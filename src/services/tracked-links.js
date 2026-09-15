import crypto from "crypto";
import { query } from "../db.js";
import { sanitizeClickUrl } from "./tracking-email.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 39 — Link tracciati (QR / link corto) per sito.
//
// Ogni sito ha i propri link: /go/:slug conta la visita (tabella
// tracked_link_events) e fa 302 verso target_url. Il link porta un
// channel + utm_campaign: il primo contatto che arriva da quel link
// eredita la sorgente (la logica utm/first_source esiste già su contacts),
// quindi il link diventa un canale misurabile nel funnel. Se il link viene
// aperto con ?email= o ?cid= l'evento registra il contatto, per vedere chi
// ha cliccato e se ha convertito.
//
// Slug: se non fornito, generato dal label oppure casuale (8 char).
// Status: active → il link risolve; paused → 302 verso / (disattivato).
// ─────────────────────────────────────────────────────────────────────────

const VALID_STATUSES = ["active", "paused"];

// Slug sicuro: solo [a-z0-9-], max 120 char. '' se non valido → genera.
function sanitizeSlug(raw) {
  const s = String(raw || "").trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return s;
}

function randomSlug() {
  return crypto.randomBytes(4).toString("hex"); // 8 char
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase().slice(0, 255);
}

function mapTrackedLink(row) {
  if (!row) return row;
  return {
    ...row,
    qr_enabled: !!row.qr_enabled,
    visit_count: row.visit_count !== undefined ? Number(row.visit_count) || 0 : undefined,
  };
}

// ── Lettura ──────────────────────────────────────────────────────────────

export async function listTrackedLinks(siteId, { status = null, limit = 50, offset = 0 } = {}) {
  const params = [siteId];
  let where = "site_id = $1";
  if (status && VALID_STATUSES.includes(String(status))) {
    params.push(String(status));
    where += ` AND status = $${params.length}`;
  }
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = (await query(
    `SELECT l.*,
       (SELECT COUNT(*) FROM tracked_link_events e WHERE e.link_id = l.id) AS visit_count
     FROM tracked_links l WHERE ${where}
     ORDER BY l.created_at DESC LIMIT ${lim} OFFSET ${off}`,
    params
  )).rows;
  return rows.map(mapTrackedLink);
}

export async function getTrackedLink(siteId, id) {
  const row = (await query(
    `SELECT l.*,
       (SELECT COUNT(*) FROM tracked_link_events e WHERE e.link_id = l.id) AS visit_count
     FROM tracked_links l WHERE l.id = $1 AND l.site_id = $2`,
    [parseInt(id, 10), siteId]
  )).rows[0];
  return mapTrackedLink(row || null);
}

export async function getTrackedLinkBySlug(siteId, slug) {
  const row = (await query(
    "SELECT * FROM tracked_links WHERE site_id = $1 AND slug = $2",
    [siteId, sanitizeSlug(slug)]
  )).rows[0];
  return mapTrackedLink(row || null);
}

// ── Statistiche ──────────────────────────────────────────────────────────

// Stats visite: totali, uniche (per email se identificato, altrimenti per ip),
// e distribuzione giornaliera negli ultimi N giorni (default 30).
export async function getTrackedLinkStats(siteId, id, { days = 30 } = {}) {
  const link = await getTrackedLink(siteId, id);
  if (!link) return null;

  const d = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const total = (await query(
    "SELECT COUNT(*) AS c FROM tracked_link_events WHERE link_id = $1",
    [parseInt(id, 10)]
  )).rows[0].c;
  const unique = (await query(
    `SELECT COUNT(*) AS c FROM (
       SELECT DISTINCT COALESCE(NULLIF(email, ''), ip)
       FROM tracked_link_events WHERE link_id = $1
     ) t`,
    [parseInt(id, 10)]
  )).rows[0].c;
  const daily = (await query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS hits,
            COUNT(DISTINCT COALESCE(NULLIF(email, ''), ip)) AS uniques
     FROM tracked_link_events
     WHERE link_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
     GROUP BY DATE(created_at) ORDER BY day DESC`,
    [parseInt(id, 10), String(d)]
  )).rows;

  return {
    link_id: parseInt(id, 10),
    total: Number(total) || 0,
    unique: Number(unique) || 0,
    daily: daily.map(r => ({ day: r.day, hits: Number(r.hits), uniques: Number(r.uniques) })),
  };
}

// ── Scrittura ────────────────────────────────────────────────────────────

export async function createTrackedLink(siteId, { label = "", slug = "", target_url = "", channel = "", utm_campaign = "", status = "active", qr_enabled = true } = {}) {
  const cleanLabel = String(label || "").trim().slice(0, 255);
  if (!cleanLabel) return null;

  const target = sanitizeClickUrl(target_url);
  if (target === "/") return null; // URL target non valido

  const base = sanitizeSlug(slug) || randomSlug();
  // Slug univoco per sito: in caso di collisione aggiungi suffisso numerico
  let finalSlug = base;
  for (let i = 2; i <= 100; i++) {
    const exists = (await query(
      "SELECT 1 FROM tracked_links WHERE site_id = $1 AND slug = $2",
      [siteId, finalSlug]
    )).rows[0];
    if (!exists) break;
    finalSlug = `${base}-${i}`;
  }

  const cleanStatus = VALID_STATUSES.includes(String(status)) ? String(status) : "active";
  const row = (await query(
    `INSERT INTO tracked_links
       (site_id, label, slug, target_url, channel, utm_campaign, status, qr_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [siteId, cleanLabel, finalSlug, target,
     String(channel || "").trim().slice(0, 255),
     String(utm_campaign || "").trim().slice(0, 255),
     cleanStatus, !!qr_enabled]
  )).rows[0];
  return mapTrackedLink(row);
}

export async function updateTrackedLink(siteId, id, data = {}) {
  const current = (await query(
    "SELECT * FROM tracked_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  if (!current) return null;

  const fields = [];
  const params = [];
  if (data.label !== undefined) {
    const t = String(data.label).trim().slice(0, 255);
    if (t) { params.push(t); fields.push(`label = $${params.length}`); }
  }
  if (data.target_url !== undefined) {
    const target = sanitizeClickUrl(data.target_url);
    if (target !== "/") { params.push(target); fields.push(`target_url = $${params.length}`); }
  }
  if (data.channel !== undefined) {
    params.push(String(data.channel).trim().slice(0, 255));
    fields.push(`channel = $${params.length}`);
  }
  if (data.utm_campaign !== undefined) {
    params.push(String(data.utm_campaign).trim().slice(0, 255));
    fields.push(`utm_campaign = $${params.length}`);
  }
  if (data.status !== undefined && VALID_STATUSES.includes(String(data.status))) {
    params.push(String(data.status));
    fields.push(`status = $${params.length}`);
  }
  if (data.qr_enabled !== undefined) {
    params.push(!!data.qr_enabled);
    fields.push(`qr_enabled = $${params.length}`);
  }
  if (data.slug !== undefined) {
    const s = sanitizeSlug(data.slug);
    if (s && s !== current.slug) {
      // Evita collisioni: cerca un slug libero partendo dal richiesto
      let finalSlug = s;
      for (let i = 2; i <= 100; i++) {
        const clash = (await query(
          "SELECT 1 FROM tracked_links WHERE site_id = $1 AND slug = $2 AND id <> $3",
          [siteId, finalSlug, parseInt(id, 10)]
        )).rows[0];
        if (!clash) break;
        finalSlug = `${s}-${i}`;
      }
      params.push(finalSlug);
      fields.push(`slug = $${params.length}`);
    }
  }

  if (fields.length === 0) return mapTrackedLink(current);

  params.push(parseInt(id, 10), siteId);
  await query(
    `UPDATE tracked_links SET ${fields.join(", ")}, updated_at = NOW()
     WHERE id = $${params.length - 1} AND site_id = $${params.length}`,
    params
  );
  const row = (await query(
    "SELECT * FROM tracked_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  )).rows[0];
  return mapTrackedLink(row);
}

export async function deleteTrackedLink(siteId, id) {
  const result = await query(
    "DELETE FROM tracked_links WHERE id = $1 AND site_id = $2",
    [parseInt(id, 10), siteId]
  );
  return (result.rowCount || 0) > 0;
}

// ── Hit tracking (route pubblica) ────────────────────────────────────────

// Registra una visita al link. Se viene passata un'email (parametro ?email=
// dell'URL pubblico) viene associata all'evento. Ritorna l'oggetto link
// aggiornato (per il 302) oppure null se il link non esiste/è paused.
export async function registerHit(siteId, slug, { ip = "", ua = "", referrer = "", email = "" } = {}) {
  const link = await getTrackedLinkBySlug(siteId, slug);
  if (!link || link.status !== "active") return null;

  await query(
    `INSERT INTO tracked_link_events (link_id, email, ip, ua, referrer)
     VALUES ($1, $2, $3, $4, $5)`,
    [link.id, normalizeEmail(email), String(ip || "").slice(0, 64),
     String(ua || "").slice(0, 2000), String(referrer || "").slice(0, 2000)]
  );

  // Il primo contatto che arriva da questo link eredita la sorgente funnel.
  // Se email identificata, aggiorna first_source/utm sul contatto (primo
  // contatto vince: la logica esiste già in ingest.js, qui solo quando il
  // link identifica esplicitamente il visitatore).
  if (email) {
    try {
      await query(
        `UPDATE contacts SET
           first_source = CASE WHEN first_source = '' THEN $2 ELSE first_source END,
           utm_source = COALESCE(utm_source, $2),
           utm_medium = COALESCE(utm_medium, 'link-tracciato'),
           utm_campaign = COALESCE(utm_campaign, NULLIF($3, ''))
         WHERE site_id = $1 AND email = $4`,
        [siteId,
         link.channel || "link-tracciato",
         link.utm_campaign || null,
         normalizeEmail(email)]
      );
    } catch {
      // il tracking non deve mai rompere il redirect
    }
  }

  return link;
}