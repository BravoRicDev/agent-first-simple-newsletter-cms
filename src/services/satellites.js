import { query } from "../db.js";
import config from "../config.js";
import { encryptSecret } from "./crypto.js";

// ─────────────────────────────────────────────────────────────────────────
// Registro moduli satellite (SSO) — generico e riutilizzabile.
//
// Un "satellite" è un'app separata su un sottodominio che usa il login del
// CMS (cookie condiviso via COOKIE_DOMAIN) e/o un API token (agtok_).
// Il registro serve a tre scopi:
// 1. allowlist degli origin ammessi come redirect_uri post-login
//    (previene open-redirect: solo origin registrati ed enabled vengono
//    accettati dal flusso /login → magic-link → /api/auth/verify);
// 2. inventario amministrabile dei moduli collegati (admin UI + agent API);
// 3. directory delle CAPABILITY dichiarate da ogni satellite (API esposte,
//    interrogabili dagli altri satelliti e usate come whitelist dal proxy
//    /invoke) + binding identità user_id per eventi/proxy.
//
// Nessun nome di modulo è cablato nel codice: l'onboarding di un nuovo
// satellite è una INSERT (admin UI, agent API o MCP tool).
// ─────────────────────────────────────────────────────────────────────────

function parseUrlOrNull(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed;
  } catch {
    return null;
  }
}

// Origin canonica per il confronto col registro: host lowercase, default
// port expliciti rimossi (https://X.com ≡ https://X.com:443), senza path.
export function normalizeOrigin(raw) {
  const parsed = parseUrlOrNull(raw);
  if (!parsed) return null;
  let host = parsed.hostname.toLowerCase();
  const port = parsed.port;
  if (
    port &&
    !((parsed.protocol === "https:" && port === "443") ||
      (parsed.protocol === "http:" && port === "80"))
  ) {
    host += ":" + port;
  }
  return `${parsed.protocol}//${host}`;
}

// URL interno Docker (base_internal): normalizzato senza slash finale.
// A differenza dell'origin SSO può includere una path di base (reverse proxy
// con prefisso); NON viene mai usato per il redirect post-login.
export function normalizeInternalUrl(raw) {
  const parsed = parseUrlOrNull(raw);
  if (!parsed) return null;
  let host = parsed.hostname.toLowerCase();
  if (parsed.port) host += ":" + parsed.port;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${host}${path === "/" ? "" : path}`;
}

const VALID_CAP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

// Valida l'array capabilities dichiarato da un satellite. Ritorna la lista
// normalizzata o null se malformata. Ogni voce:
//   { method: "POST", path: "/api/messages/send", desc?: "...", scope: "read"|"write" }
export function validateCapabilities(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const method = String(item.method || "").toUpperCase();
    const path = String(item.path || "").trim();
    const scope = String(item.scope || "read").toLowerCase();
    if (!VALID_CAP_METHODS.has(method)) return null;
    if (!path.startsWith("/") || path.length > 512) return null;
    if (scope !== "read" && scope !== "write") return null;
    const entry = { method, path, scope };
    if (item.desc !== undefined) {
      const desc = String(item.desc).slice(0, 300);
      if (desc) entry.desc = desc;
    }
    out.push(entry);
  }
  // Dedup (method, path): l'ultima voce vince, come un override.
  const seen = new Map();
  for (const e of out) seen.set(`${e.method} ${e.path}`, e);
  return [...seen.values()];
}

function validateWebhooks(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const event = String(item.event || "").trim().slice(0, 200);
    const url = parseUrlOrNull(item.url)?.href;
    const secretRef = String(item.secret_ref || "").trim().slice(0, 200);
    if (!event || !url) return null;
    const entry = { event, url };
    if (secretRef) entry.secret_ref = secretRef;
    out.push(entry);
  }
  return out;
}

// Valida il redirect_uri post-login contro il registro sso_satellites.
// Ritorna la destinazione consentita ("origin + path + query") o null se
// assente/malformata/non registrata/disabilitata. In produzione solo HTTPS;
// fuori produzione HTTP è ammesso (test/dev locali dei satelliti).
export async function validateRedirectUri(uri) {
  if (!uri || typeof uri !== "string" || uri.length > 2048) return null;
  const parsed = parseUrlOrNull(uri);
  if (!parsed) return null;
  if (config.nodeEnv === "production" && parsed.protocol !== "https:") return null;

  const origin = normalizeOrigin(parsed);
  if (!origin) return null;
  try {
    const result = await query(
      "SELECT id FROM sso_satellites WHERE origin = $1 AND enabled = true",
      [origin]
    );
    if (result.rows.length === 0) return null;
    return origin + parsed.pathname + parsed.search;
  } catch {
    // Tabella non migrata / DB irraggiungibile: fail-closed, mai aprire il redirect.
    return null;
  }
}

// agent_token_enc NON è mai selezionato: si espone solo il booleano.
const SAT_COLS =
  "id, name, origin, enabled, capabilities, webhooks, base_internal, user_id, " +
  "(agent_token_enc IS NOT NULL) AS has_agent_token, created_at, updated_at";

export async function listSatellites() {
  return (await query(`SELECT ${SAT_COLS} FROM sso_satellites ORDER BY name`)).rows;
}

export async function findEnabledSatelliteByName(name) {
  const rows = (await query(
    `SELECT ${SAT_COLS} FROM sso_satellites WHERE name = $1 AND enabled = true`,
    [String(name || "").trim()]
  )).rows;
  return rows[0] || null;
}

// Binding token ↔ satellite: risale al nome del satellite dall'utente che
// possiede l'agtok_ (sso_satellites.user_id). Usato da proxy (header
// X-Satellite-Caller) ed eventi (inbox per-target).
export async function findEnabledSatelliteByUserId(userId) {
  if (!userId) return null;
  const rows = (await query(
    `SELECT ${SAT_COLS} FROM sso_satellites WHERE user_id = $1 AND enabled = true LIMIT 1`,
    [userId]
  )).rows;
  return rows[0] || null;
}

// Uso INTERNO del proxy (mai esposto via API): include il token M2M cifrato.
export async function getSatelliteForProxy(name) {
  const rows = (await query(
    `SELECT id, name, origin, capabilities, webhooks, base_internal, user_id, agent_token_enc
     FROM sso_satellites WHERE name = $1 AND enabled = true`,
    [String(name || "").trim()]
  )).rows;
  return rows[0] || null;
}

// Directory discovery: capability di tutti i satelliti abilitati.
export async function listSatelliteCapabilities() {
  return (await query(
    `SELECT name, origin, capabilities FROM sso_satellites WHERE enabled = true ORDER BY name`
  )).rows;
}

export async function getSatelliteCapabilities(name) {
  const rows = (await query(
    `SELECT name, origin, capabilities, webhooks FROM sso_satellites
     WHERE name = $1 AND enabled = true`,
    [String(name || "").trim()]
  )).rows;
  return rows[0] ? { name: rows[0].name, origin: rows[0].origin, capabilities: rows[0].capabilities, webhooks: rows[0].webhooks } : null;
}

export async function createSatellite({
  name, origin, enabled = true,
  capabilities, webhooks, base_internal, user_id,
} = {}) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) {
    const err = new Error("invalid_origin");
    err.code = "SATELLITE_INVALID_ORIGIN";
    throw err;
  }
  const caps = validateCapabilities(capabilities);
  if (caps === null) {
    const err = new Error("invalid_capabilities");
    err.code = "SATELLITE_INVALID_CAPABILITIES";
    throw err;
  }
  const hooks = validateWebhooks(webhooks);
  if (hooks === null) {
    const err = new Error("invalid_webhooks");
    err.code = "SATELLITE_INVALID_WEBHOOKS";
    throw err;
  }
  let internal = null;
  if (base_internal !== undefined && base_internal !== null && base_internal !== "") {
    internal = normalizeInternalUrl(base_internal);
    if (!internal) {
      const err = new Error("invalid_base_internal");
      err.code = "SATELLITE_INVALID_BASE_INTERNAL";
      throw err;
    }
  }
  const uid = user_id === undefined || user_id === null || user_id === "" ? null : parseInt(user_id, 10);
  const result = await query(
    `INSERT INTO sso_satellites (name, origin, enabled, capabilities, webhooks, base_internal, user_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (origin) DO UPDATE SET
       name = EXCLUDED.name, enabled = EXCLUDED.enabled, capabilities = EXCLUDED.capabilities,
       webhooks = EXCLUDED.webhooks, base_internal = EXCLUDED.base_internal, user_id = EXCLUDED.user_id,
       updated_at = NOW()
     RETURNING ${SAT_COLS}`,
    [
      String(name).trim().slice(0, 100), normalized, Boolean(enabled),
      JSON.stringify(caps), JSON.stringify(hooks), internal,
      Number.isInteger(uid) ? uid : null,
    ]
  );
  return result.rows[0];
}

export async function updateSatellite(id, {
  name, origin, enabled,
  capabilities, webhooks, base_internal, user_id,
} = {}) {
  const fields = [];
  const values = [];
  if (name !== undefined) {
    values.push(String(name).trim().slice(0, 100));
    fields.push(`name = $${values.length}`);
  }
  if (origin !== undefined) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) {
      const err = new Error("invalid_origin");
      err.code = "SATELLITE_INVALID_ORIGIN";
      throw err;
    }
    values.push(normalized);
    fields.push(`origin = $${values.length}`);
  }
  if (enabled !== undefined) {
    values.push(Boolean(enabled));
    fields.push(`enabled = $${values.length}`);
  }
  if (capabilities !== undefined) {
    const caps = validateCapabilities(capabilities);
    if (caps === null) {
      const err = new Error("invalid_capabilities");
      err.code = "SATELLITE_INVALID_CAPABILITIES";
      throw err;
    }
    values.push(JSON.stringify(caps));
    fields.push(`capabilities = $${values.length}::jsonb`);
  }
  if (webhooks !== undefined) {
    const hooks = validateWebhooks(webhooks);
    if (hooks === null) {
      const err = new Error("invalid_webhooks");
      err.code = "SATELLITE_INVALID_WEBHOOKS";
      throw err;
    }
    values.push(JSON.stringify(hooks));
    fields.push(`webhooks = $${values.length}::jsonb`);
  }
  if (base_internal !== undefined) {
    if (base_internal === null || base_internal === "") {
      values.push(null);
    } else {
      const internal = normalizeInternalUrl(base_internal);
      if (!internal) {
        const err = new Error("invalid_base_internal");
        err.code = "SATELLITE_INVALID_BASE_INTERNAL";
        throw err;
      }
      values.push(internal);
    }
    fields.push(`base_internal = $${values.length}`);
  }
  if (user_id !== undefined) {
    const uid = user_id === null || user_id === "" ? null : parseInt(user_id, 10);
    if (uid !== null && !Number.isInteger(uid)) {
      const err = new Error("invalid_user_id");
      err.code = "SATELLITE_INVALID_USER_ID";
      throw err;
    }
    values.push(uid);
    fields.push(`user_id = $${values.length}`);
  }
  if (fields.length === 0) {
    const err = new Error("no_fields_to_update");
    err.code = "SATELLITE_NO_FIELDS";
    throw err;
  }
  fields.push("updated_at = NOW()");
  values.push(parseInt(id, 10));
  const result = await query(
    `UPDATE sso_satellites SET ${fields.join(", ")} WHERE id = $${values.length} RETURNING ${SAT_COLS}`,
    values
  );
  return result.rows[0] || null;
}

// Registra/cancella il token M2M del satellite (per il proxy /invoke).
// Cifrato a riposo con ENCRYPTION_KEY (services/crypto.js); token vuoto o
// null = cancella. Mai restituito in chiaro dalle SELECT del registro.
export async function setSatelliteAgentToken(id, plaintext) {
  const enc = plaintext ? encryptSecret(String(plaintext)) : null;
  const result = await query(
    `UPDATE sso_satellites SET agent_token_enc = $1, updated_at = NOW()
     WHERE id = $2 RETURNING ${SAT_COLS}`,
    [enc, parseInt(id, 10)]
  );
  return result.rows[0] || null;
}

export async function deleteSatellite(id) {
  const result = await query(
    `DELETE FROM sso_satellites WHERE id = $1 RETURNING ${SAT_COLS}`,
    [parseInt(id, 10)]
  );
  return result.rows[0] || null;
}
