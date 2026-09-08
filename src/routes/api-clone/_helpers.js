// ─────────────────────────────────────────────────────────────────────────
// Helper condivisi del layer clone API (vhost apicrm.*).
// Contratto trasversale: errori {statusCode,message}, meta paginazione,
// validazione uuid esterni. Vedi docs/API_CLONE_MASTER_PLAN.md §4.
// ─────────────────────────────────────────────────────────────────────────

import { ensureExternalId } from "../../services/external-ids.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// locationId canonico per le risposte clone: se il tenant ha configurato
// sites.location_external_id (la sua vera location) vince quello, altrimenti
// usiamo l'UUID auto-generato di sites — stabile e sempre presente.
export async function getLocationId(tenant) {
  if (tenant?.locationExternalId) return tenant.locationExternalId;
  return ensureExternalId("sites", tenant.siteId);
}

// Errore uniforme in stile dialetto moderno del target.
export function sendError(res, statusCode, message) {
  res.status(statusCode).json({ statusCode, message });
}

// Alias per gli handler async: passa l'errore al next() con status allegato.
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function isValidUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// Valida un uuid di percorso; in caso contrario 400. Ritorna il valore.
export function requireUuid(value, res) {
  if (!isValidUuid(value)) {
    sendError(res, 400, "Identificatore non valido");
    return null;
  }
  return value;
}

// Parametri di paginazione accettati dalle liste clone:
// limit (default 20, max 100) + cursore startAfterId (id esterno della pagina).
export function getPaging(query = {}) {
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit)) limit = 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;
  const startAfterId = typeof query.startAfterId === "string" ? query.startAfterId : null;
  return { limit, startAfterId };
}

// Meta di risposta per le liste. nextPage è il cursore da passare come
// startAfterId alla richiesta successiva (null se non ci sono altre pagine).
export function buildMeta(total, nextStartAfterId = null) {
  return {
    total,
    nextPage: nextStartAfterId ? String(nextStartAfterId) : null,
    prevPage: null,
  };
}

// Risposta lista standard: { <chiave>: [...], meta }.
export function sendList(res, key, items, total, nextStartAfterId = null) {
  res.json({ [key]: items, meta: buildMeta(total, nextStartAfterId) });
}
