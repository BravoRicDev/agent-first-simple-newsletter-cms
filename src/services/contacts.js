import { query } from "../db.js";
import { PIPELINE_STAGE_KEYS } from "../constants/pipeline.js";

const EMAIL_KEY_HEURISTIC = /email/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksLikeEmail(v) {
  return typeof v === "string" && EMAIL_RE.test(v.trim());
}

// L'identità (email) viene dedotta al volo dai dati già in form_submissions,
// non richiesta come campo separato da compilare. Per i form creati col
// builder si usa il campo marcato tipo 'email' (nessuna ambiguità); per i
// form scritti a mano (nessuna riga in `forms`) si tenta un'euristica sul
// nome del campo.
async function getEmailFieldMap(siteId) {
  const rows = (await query("SELECT slug, fields FROM forms WHERE site_id = $1", [siteId])).rows;
  const map = new Map();
  for (const row of rows) {
    const emailField = (row.fields || []).find(f => f.type === "email");
    if (emailField) map.set(row.slug, emailField.key);
  }
  return map;
}

function extractEmail(data, knownKey) {
  if (knownKey && looksLikeEmail(data?.[knownKey])) return data[knownKey].trim().toLowerCase();
  for (const [key, val] of Object.entries(data || {})) {
    if (EMAIL_KEY_HEURISTIC.test(key) && looksLikeEmail(val)) return val.trim().toLowerCase();
  }
  return null;
}

// Usata dalla route pubblica di submit, dove i campi del form sono già stati
// caricati per la whitelist — evita una query aggiuntiva per lo stesso form.
export function extractEmailFromFields(fields, data) {
  const emailField = (fields || []).find(f => f.type === "email");
  return extractEmail(data, emailField?.key);
}

// Limite di invii analizzati per sito: "lite" per scelta — su installazioni
// con volumi molto più alti servirebbe un'aggregazione lato SQL, non lato
// JS come qui.
const SUBMISSIONS_SCAN_LIMIT = 5000;

// Hook per il PUSH opzionale verso il CRM sorgente (GoHighLevel).
// Fire-and-forget: l'enqueue non deve MAI bloccare il chiamante (e se il
// push non è abilitato per il sito, enqueuePush ritorna subito senza fare
// nulla). `origin` ('cms'|'ghl_in'|'import') implementa l'anti-echo: le
// mutate arrivate da GHL non vengono rispedite a GHL.
function pushContact(siteId, email, origin = "cms") {
  if (!siteId || !email) return;
  import("./source-sync/push.js")
    .then(({ enqueuePush }) => enqueuePush(siteId, "contact", { email, origin }))
    .catch(() => {});
}

export async function loadEnrichedSubmissions(siteId, { formSlug, limit = SUBMISSIONS_SCAN_LIMIT } = {}) {
  const emailFieldMap = await getEmailFieldMap(siteId);
  const params = [siteId];
  let where = "site_id = $1";
  if (formSlug) {
    params.push(formSlug);
    where += ` AND form_slug = $${params.length}`;
  }
  // limit = null/0 → senza LIMIT: serve per l'export/cancellazione GDPR, dove
  // troncare a 5000 invii significherebbe esportare/cancellare solo i più
  // recenti e lasciare i dati più vecchi in giro (violazione art. 15/17).
  const limitClause = limit ? ` LIMIT $${params.length + 1}` : "";
  if (limit) params.push(limit);

  const rows = (await query(
    `SELECT id, form_slug, data, created_at FROM form_submissions
     WHERE ${where} ORDER BY created_at DESC${limitClause}`,
    params
  )).rows;

  return rows.map(row => ({ ...row, email: extractEmail(row.data, emailFieldMap.get(row.form_slug)) }));
}

// Crea il contatto se non esiste ancora (prima volta che quest'email viene
// riconosciuta in un invio) — idempotente, chiamata sia dal submit pubblico
// sia come backfill di lettura per invii già esistenti prima di questa
// funzionalità. Usata anche per aggiungere a mano un lead che non è mai
// passato da un form (es. modulo pipeline vendite).
export async function upsertContact(siteId, email, options = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  await query(
    `INSERT INTO contacts (site_id, email) VALUES ($1, $2)
     ON CONFLICT (site_id, email) DO NOTHING`,
    [siteId, normalized]
  );
  pushContact(siteId, normalized, options.origin);
}

// Solo tag/stato/note/valore, senza scansionare gli invii — per chi deve
// solo leggere/unire lo stato persistito (es. update parziale via API agente).
// Include anche le preferenze GDPR (pref_whatsapp/pref_email/pref_phone):
// servono al runtime conversazionale (feature 29) per non scrivere mai un
// messaggio OUT verso un contatto non consenziente.
export async function getContactRecord(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();
  const row = (await query(
    "SELECT tags, status, notes, value_estimate, score, pref_whatsapp, pref_email, pref_phone FROM contacts WHERE site_id = $1 AND email = $2",
    [siteId, normalized]
  )).rows[0];
  // Fallback con i default di schema: whatsapp = non consenziente finché non
  // risulta altrimenti (il contatto non esiste ancora), email/phone = sì.
  return row || { tags: [], status: "", notes: "", value_estimate: null, score: 0, pref_whatsapp: false, pref_email: true, pref_phone: true };
}

export async function setContactFields(siteId, email, { tags, status, notes, value_estimate }, options = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  await query(
    `INSERT INTO contacts (site_id, email, tags, status, notes, value_estimate)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id, email)
     DO UPDATE SET tags = $3, status = $4, notes = $5, value_estimate = $6, updated_at = NOW()`,
    [siteId, normalized, tags, status, notes, value_estimate]
  );
  pushContact(siteId, normalized, options.origin);
}

// Aggiunge un tag all'array esistente senza duplicati — usata dal submit dei
// form builder (newsletter_tag_key): un contatto può compilare lo stesso form
// più volte, il tag non deve comparire due volte. Crea il contatto se manca
// (stesso comportamento di upsertContact).
export async function addContactTag(siteId, email, tag, options = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  const cleanTag = String(tag || "").trim().slice(0, 100);
  if (!cleanTag) return;
  await query(
    `INSERT INTO contacts (site_id, email, tags) VALUES ($1, $2, ARRAY[$3])
     ON CONFLICT (site_id, email)
     DO UPDATE SET
       tags = CASE WHEN $3 = ANY(contacts.tags) THEN contacts.tags ELSE contacts.tags || $3 END,
       updated_at = NOW()`,
    [siteId, normalized, cleanTag]
  );
  // Evento per workflow/scoring (fire-and-forget, mai bloccare il chiamante).
  import("./events.js").then(({ emitContactEvent }) =>
    emitContactEvent(siteId, normalized, "tag_added", { tag: cleanTag })
  ).catch(() => {});
  pushContact(siteId, normalized, options.origin);
}

// Board del modulo pipeline vendite: TUTTI i contatti del sito (non solo
// quelli con invii recenti come aggregateContacts), raggruppati per stadio
// fisso. Uno status che non è uno stadio noto (vuoto, o testo libero
// pre-esistente da prima del modulo) finisce nel bucket "" (da assegnare).
export async function getPipelineBoard(siteId) {
  const rows = (await query(
    `SELECT email, tags, status, notes, value_estimate, updated_at
     FROM contacts WHERE site_id = $1 ORDER BY updated_at DESC`,
    [siteId]
  )).rows;

  const board = { "": [] };
  for (const key of PIPELINE_STAGE_KEYS) board[key] = [];

  for (const row of rows) {
    const bucket = PIPELINE_STAGE_KEYS.has(row.status) ? row.status : "";
    board[bucket].push(row);
  }
  return board;
}

export async function setContactStage(siteId, email, stage, options = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  await query(
    `INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, $3)
     ON CONFLICT (site_id, email) DO UPDATE SET status = $3, updated_at = NOW()`,
    [siteId, normalized, stage]
  );
  // Evento per workflow/scoring (fire-and-forget, mai bloccare il chiamante).
  import("./events.js").then(({ emitContactEvent }) =>
    emitContactEvent(siteId, normalized, "stage_changed", { to_stage: stage })
  ).catch(() => {});
  pushContact(siteId, normalized, options.origin);
}

export async function listTags(siteId) {
  const rows = (await query(
    "SELECT DISTINCT unnest(tags) AS tag FROM contacts WHERE site_id = $1 ORDER BY 1",
    [siteId]
  )).rows;
  return rows.map(r => r.tag);
}

// Raggruppa gli invii per email: risponde a "questa persona ha già
// compilato qualcosa?" e "ha compilato più di un form?". Ogni email trovata
// viene garantita presente in `contacts` (backfill silenzioso) così tag/
// stato/note possono essere assegnati anche a invii precedenti a questa
// funzionalità, senza una migrazione dati a parte.
export async function aggregateContacts(siteId, { tag } = {}) {
  const submissions = await loadEnrichedSubmissions(siteId);
  const byEmail = new Map();

  for (const s of submissions) {
    if (!s.email) continue;
    if (!byEmail.has(s.email)) {
      byEmail.set(s.email, { email: s.email, forms: new Set(), total: 0, firstSeen: s.created_at, lastSeen: s.created_at });
    }
    const c = byEmail.get(s.email);
    c.forms.add(s.form_slug);
    c.total++;
    if (s.created_at > c.lastSeen) c.lastSeen = s.created_at;
    if (s.created_at < c.firstSeen) c.firstSeen = s.created_at;
  }

  const emails = [...byEmail.keys()];
  if (emails.length > 0) {
    await query(
      `INSERT INTO contacts (site_id, email)
       SELECT $1, x FROM unnest($2::text[]) AS x
       ON CONFLICT (site_id, email) DO NOTHING`,
      [siteId, emails]
    );
  }
  const contactRows = emails.length > 0
    ? (await query("SELECT email, tags, status, notes FROM contacts WHERE site_id = $1 AND email = ANY($2)", [siteId, emails])).rows
    : [];
  const contactMap = new Map(contactRows.map(r => [r.email, r]));

  let result = [...byEmail.values()].map(c => {
    const contact = contactMap.get(c.email) || { tags: [], status: "", notes: "" };
    return {
      email: c.email, formsCount: c.forms.size, forms: [...c.forms], total: c.total,
      firstSeen: c.firstSeen, lastSeen: c.lastSeen,
      tags: contact.tags, status: contact.status, notes: contact.notes,
    };
  });

  if (tag) result = result.filter(c => c.tags.includes(tag));

  return result.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
}

export async function getContactTimeline(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();
  const submissions = await loadEnrichedSubmissions(siteId);
  const timeline = submissions
    .filter(s => s.email === normalized)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return { timeline, contact: await getContactRecord(siteId, normalized) };
}

// Ricerca libera dentro i dati inviati (qualsiasi campo, su tutti i form del
// sito): usa il testo dell'intero JSONB, quindi non richiede di conoscere
// in anticipo le chiavi dei campi.
export async function searchSubmissions(siteId, term, { limit = 100 } = {}) {
  const rows = (await query(
    `SELECT id, form_slug, data, created_at FROM form_submissions
     WHERE site_id = $1 AND data::text ILIKE $2
     ORDER BY created_at DESC LIMIT $3`,
    [siteId, `%${term}%`, limit]
  )).rows;
  return rows;
}
