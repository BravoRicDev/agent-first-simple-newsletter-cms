import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Segmenti dinamici — membership materializzata.
//
// Ogni segmento ha `rules` JSONB: [{field, op, value, days?, event?}].
// Il valutatore traduce le regole in condizioni su dati reali caricati dal
// DB (contacts + contact_events) — MAI SQL interpolato: campo e operatore
// vengono validati contro whitelist; una regola sconosciuta è ignorata.
//
// refreshSegmentsForContact() viene chiamato a ogni evento (via
// emitContactEvent) e aggiorna segment_members in modo incrementale.
// ─────────────────────────────────────────────────────────────────────────

const FIELD_WHITELIST = new Set([
  "tag", "status", "score", "value_estimate", "email", "notes",
  "utm_source", "utm_medium", "utm_campaign", "first_source",
  "pref_email", "pref_sms", "pref_phone", "pref_whatsapp", "pref_marketing",
]);

const OP_WHITELIST = new Set([
  "has", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains",
]);

// Operatori speciali per il campo `event` (l'op non è in OP_WHITELIST).
const EVENT_OPS = new Set(["gte_days_ago", "lt_days_ago", "exists"]);

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Valuta una singola regola contro il contesto caricato del contatto.
// ctx = { contact: {...}, events: [{event_type, created_at}], email }
function evalRule(rule, ctx) {
  if (!rule || typeof rule !== "object") return false;
  const field = String(rule.field || "");
  const op = String(rule.op || "");

  if (!FIELD_WHITELIST.has(field) && field !== "event") return false;
  if (field === "event") {
    if (!EVENT_OPS.has(op)) return false;
    const eventType = String(rule.value || "");
    const days = num(rule.days);
    const cutoff = Number.isFinite(days) ? Date.now() - days * 24 * 3600 * 1000 : Date.now();
    const match = ctx.events.find((e) => e.event_type === eventType);
    const hasRecent = !!match && new Date(match.created_at).getTime() >= cutoff;
    if (op === "gte_days_ago") return hasRecent;
    if (op === "lt_days_ago") return !hasRecent;
    if (op === "exists") return !!match;
    return false;
  }

  // Operatori non validi per i campi normali.
  if (!OP_WHITELIST.has(op)) return false;

  const contact = ctx.contact || {};
  let actual;
  switch (field) {
    case "tag":
      actual = Array.isArray(contact.tags) ? contact.tags : [];
      break;
    case "status": actual = contact.status || ""; break;
    case "score": actual = num(contact.score); break;
    case "value_estimate": actual = num(contact.value_estimate); break;
    case "email": actual = ctx.email; break;
    case "notes": actual = contact.notes || ""; break;
    case "utm_source": actual = contact.utm_source || ""; break;
    case "utm_medium": actual = contact.utm_medium || ""; break;
    case "utm_campaign": actual = contact.utm_campaign || ""; break;
    case "first_source": actual = contact.first_source || ""; break;
    case "pref_email": actual = !!contact.pref_email; break;
    case "pref_sms": actual = !!contact.pref_sms; break;
    case "pref_phone": actual = !!contact.pref_phone; break;
    case "pref_whatsapp": actual = !!contact.pref_whatsapp; break;
    case "pref_marketing": actual = !!contact.pref_marketing; break;
    default: return false;
  }

  const expected = rule.value;
  switch (op) {
    case "has": return Array.isArray(actual) ? actual.includes(String(expected)) : false;
    case "eq": return Array.isArray(actual) ? actual.includes(String(expected)) : String(actual) === String(expected);
    case "neq": return Array.isArray(actual) ? !actual.includes(String(expected)) : String(actual) !== String(expected);
    case "gt": return num(actual) > num(expected);
    case "gte": return num(actual) >= num(expected);
    case "lt": return num(actual) < num(expected);
    case "lte": return num(actual) <= num(expected);
    case "contains": return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case "not_contains": return !String(actual).toLowerCase().includes(String(expected).toLowerCase());
    default: return false;
  }
}

// Valuta tutte le regole di un segmento (match_mode all/any).
export function evalSegment(segment, ctx) {
  const rules = Array.isArray(segment.rules) ? segment.rules : [];
  if (rules.length === 0) return false;
  const mode = segment.match_mode === "any" ? "any" : "all";
  if (mode === "any") return rules.some((r) => evalRule(r, ctx));
  return rules.every((r) => evalRule(r, ctx));
}

// Carica il contesto di un contatto (record + eventi recenti).
async function loadContactContext(siteId, email) {
  const normalized = normalizeEmail(email);
  const contactRow = (await query(
    `SELECT tags, status, notes, value_estimate, score, utm_source, utm_medium,
            utm_campaign, first_source, pref_email, pref_sms, pref_phone,
            pref_whatsapp, pref_marketing
     FROM contacts WHERE site_id = $1 AND email = $2`,
    [siteId, normalized]
  )).rows[0];

  const events = (await query(
    `SELECT event_type, created_at FROM contact_events
     WHERE site_id = $1 AND email = $2 AND created_at >= NOW() - INTERVAL '180 days'
     ORDER BY created_at DESC LIMIT 200`,
    [siteId, normalized]
  )).rows;

  return {
    email: normalized,
    contact: contactRow || { tags: [], status: "", notes: "", value_estimate: null, score: 0, pref_email: true, pref_sms: false, pref_phone: true, pref_whatsapp: false, pref_marketing: true },
    events,
  };
}

// Rivaluta un contatto contro TUTTI i segmenti del sito e aggiorna la
// membership. Chiamato a ogni evento (incrementale).
export async function refreshSegmentsForContact(siteId, email, { source = "event" } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !siteId) return { added: [], removed: [] };

  const segments = (await query(
    "SELECT id, rules, match_mode FROM segments WHERE site_id = $1 AND enabled = true",
    [siteId]
  )).rows;
  if (segments.length === 0) return { added: [], removed: [] };

  const ctx = await loadContactContext(siteId, normalized);

  const added = [];
  const removed = [];
  const currentRows = (await query(
    "SELECT segment_id FROM segment_members WHERE site_id = $1 AND email = $2",
    [siteId, normalized]
  )).rows;
  const current = new Set(currentRows.map((r) => r.segment_id));

  for (const segment of segments) {
    const matches = evalSegment(segment, ctx);
    const isMember = current.has(segment.id);
    if (matches && !isMember) {
      await query(
        `INSERT INTO segment_members (site_id, segment_id, email) VALUES ($1, $2, $3)
         ON CONFLICT (segment_id, email) DO UPDATE SET matched_at = NOW()`,
        [siteId, segment.id, normalized]
      );
      added.push(segment.id);
      // segment_entered: emesso SOLO da eventi reali, mai da segment_refresh
      // (evita loop infinito workflow↔segmenti).
      if (source === "event") {
        import("./events.js").then((m) =>
          m.emitContactEvent(siteId, normalized, "segment_entered", { segment_id: segment.id }, { depth: 1 })
        ).catch(() => {});
      }
    } else if (!matches && isMember) {
      await query(
        "DELETE FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
        [siteId, segment.id, normalized]
      );
      removed.push(segment.id);
    }
  }

  return { added, removed };
}

// Elenco email membri di un segmento (paginato).
export async function listSegmentMembers(siteId, segmentId, { limit = 100, offset = 0 } = {}) {
  const params = [siteId, segmentId];
  params.push(Math.min(parseInt(limit, 10) || 100, 500), Math.max(parseInt(offset, 10) || 0, 0));
  const rows = (await query(
    `SELECT m.email, m.matched_at, c.tags, c.status, c.score
     FROM segment_members m
     LEFT JOIN contacts c ON c.site_id = m.site_id AND c.email = m.email
     WHERE m.site_id = $1 AND m.segment_id = $2
     ORDER BY m.matched_at DESC LIMIT $3 OFFSET $4`,
    params
  )).rows;
  const total = (await query(
    "SELECT COUNT(*) AS c FROM segment_members WHERE site_id = $1 AND segment_id = $2",
    [siteId, segmentId]
  )).rows[0].c;
  return { members: rows, total: parseInt(total, 10) };
}

// Rivaluta TUTTI i contatti conosciuti del sito contro un segmento
// (ricostruzione completa, uso manuale — non nel flusso evento).
export async function recountSegment(siteId, segmentId) {
  const segment = (await query(
    "SELECT id, rules, match_mode FROM segments WHERE site_id = $1 AND id = $2 AND enabled = true",
    [siteId, segmentId]
  )).rows[0];
  if (!segment) return { total: 0 };

  // Tutti gli email unici visti dal sito (contacts + form_submissions).
  const emails = (await query(
    `SELECT DISTINCT email FROM contacts WHERE site_id = $1
     UNION SELECT DISTINCT lower(data->>'email') AS email FROM form_submissions
       WHERE site_id = $1 AND data->>'email' IS NOT NULL`,
    [siteId]
  )).rows.map((r) => r.email).filter(Boolean);

  await query("DELETE FROM segment_members WHERE site_id = $1 AND segment_id = $2", [siteId, segmentId]);

  let total = 0;
  for (const email of emails) {
    const ctx = await loadContactContext(siteId, email);
    if (evalSegment(segment, ctx)) {
      await query(
        "INSERT INTO segment_members (site_id, segment_id, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [siteId, segmentId, email]
      );
      total++;
    }
  }
  return { total };
}

// Refresh periodico (tick scheduler): rivaluta TUTTI i segmenti dinamici
// abilitati del sito contro TUTTI gli email conosciuti, aggiungendo i nuovi
// match e rimuovendo i membri che non soddisfano più le regole. A differenza
// di refreshSegmentsForContact (incrementale, un contatto alla volta, ad
// ogni evento) questo è pensato per correggere drift accumulato — es.
// regole basate su `event ... lt_days_ago` il cui esito cambia col solo
// passare del tempo, senza un nuovo evento che lo triggeri.
// siteId=null → refresh su tutti i siti con almeno un segmento abilitato.
export async function refreshSegments(siteId = null) {
  if (siteId) return refreshSegmentsForSite(siteId);
  const sites = (await query(
    "SELECT DISTINCT site_id FROM segments WHERE enabled = true"
  )).rows;
  let segmentsCount = 0, added = 0, removed = 0;
  for (const row of sites) {
    const r = await refreshSegmentsForSite(row.site_id);
    segmentsCount += r.segments;
    added += r.added;
    removed += r.removed;
  }
  return { segments: segmentsCount, added, removed };
}

async function refreshSegmentsForSite(siteId) {
  const segments = (await query(
    "SELECT id, rules, match_mode FROM segments WHERE site_id = $1 AND enabled = true",
    [siteId]
  )).rows;
  if (segments.length === 0) return { segments: 0, added: 0, removed: 0 };

  const emails = (await query(
    `SELECT DISTINCT email FROM (
       SELECT email FROM contacts WHERE site_id = $1
       UNION
       SELECT lower(data->>'email') AS email FROM form_submissions
         WHERE site_id = $1 AND data->>'email' IS NOT NULL
     ) u WHERE email IS NOT NULL`,
    [siteId]
  )).rows.map((r) => r.email).filter(Boolean);

  let added = 0, removed = 0;
  for (const segment of segments) {
    const currentRows = (await query(
      "SELECT email FROM segment_members WHERE site_id = $1 AND segment_id = $2",
      [siteId, segment.id]
    )).rows;
    const current = new Set(currentRows.map((r) => r.email));
    const matched = new Set();

    for (const email of emails) {
      const ctx = await loadContactContext(siteId, email);
      if (!evalSegment(segment, ctx)) continue;
      matched.add(email);
      if (current.has(email)) continue;
      await query(
        `INSERT INTO segment_members (site_id, segment_id, email) VALUES ($1, $2, $3)
         ON CONFLICT (segment_id, email) DO UPDATE SET matched_at = NOW()`,
        [siteId, segment.id, email]
      );
      added++;
    }

    for (const email of current) {
      if (matched.has(email)) continue;
      await query(
        "DELETE FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
        [siteId, segment.id, email]
      );
      removed++;
    }
  }
  return { segments: segments.length, added, removed };
}

// Anteprima: quanti contatti matchano una definizione senza salvarla.
// Accetta rules array + match_mode e valuta sugli email conosciuti (max 500).
// Le email vengono da contacts + contact_events (un contatto può esistere
// solo come evento, es. tracking email, senza riga in contacts).
export async function previewSegment(siteId, rules, matchMode = "all") {
  const segment = { rules: Array.isArray(rules) ? rules : [], match_mode: matchMode };
  const emails = (await query(
    `SELECT DISTINCT email FROM (
       SELECT email FROM contacts WHERE site_id = $1
       UNION
       SELECT email FROM contact_events WHERE site_id = $1
     ) u LIMIT 500`,
    [siteId]
  )).rows.map((r) => r.email).filter(Boolean);

  const matches = [];
  for (const email of emails) {
    const ctx = await loadContactContext(siteId, email);
    if (evalSegment(segment, ctx)) matches.push(email);
  }
  return { total: matches.length, sample: matches.slice(0, 20) };
}

// Sanitizzazione definizione segmento (per route admin/agent).
export function sanitizeSegmentRules(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r) => r && typeof r === "object")
    .slice(0, 30)
    .map((r) => {
      const field = String(r.field || "").slice(0, 50);
      const op = String(r.op || "").slice(0, 30);
      const value = (r.value !== undefined && r.value !== null) ? String(r.value).slice(0, 255) : "";
      const days = Number.isFinite(Number(r.days)) ? Number(r.days) : null;
      const rule = { field, op, value };
      if (days !== null) rule.days = days;
      return rule;
    })
    .filter((r) => (FIELD_WHITELIST.has(r.field) || r.field === "event") &&
      (OP_WHITELIST.has(r.op) || (r.field === "event" && EVENT_OPS.has(r.op))));
}
