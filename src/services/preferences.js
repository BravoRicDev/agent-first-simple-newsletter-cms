import crypto from "crypto";
import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Preferenze di contatto — consenso granulare per canale + centro
// preferenze pubblico via token.
// ─────────────────────────────────────────────────────────────────────────

const PREF_FIELDS = ["pref_email", "pref_sms", "pref_phone", "pref_whatsapp", "pref_marketing"];

export async function getPreferences(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();
  const row = (await query(
    `SELECT pref_email, pref_sms, pref_phone, pref_whatsapp, pref_marketing,
            pref_updated_at, pref_token
     FROM contacts WHERE site_id = $1 AND email = $2`,
    [siteId, normalized]
  )).rows[0];
  if (!row) return null;
  return {
    email: normalized,
    pref_email: !!row.pref_email,
    pref_sms: !!row.pref_sms,
    pref_phone: !!row.pref_phone,
    pref_whatsapp: !!row.pref_whatsapp,
    pref_marketing: !!row.pref_marketing,
    pref_updated_at: row.pref_updated_at,
    pref_token: row.pref_token,
  };
}

export async function setPreferences(siteId, email, prefs = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  const updates = [];
  const params = [siteId, normalized];
  for (const field of PREF_FIELDS) {
    if (prefs[field] !== undefined) {
      params.push(!!prefs[field]);
      updates.push(`${field} = $${params.length}`);
    }
  }
  if (updates.length === 0) return getPreferences(siteId, normalized);
  params.push(new Date());
  updates.push("pref_updated_at = $" + params.length);
  await query(
    `INSERT INTO contacts (site_id, email) VALUES ($1, $2) ON CONFLICT (site_id, email) DO NOTHING`,
    [siteId, normalized]
  );
  await query(
    `UPDATE contacts SET ${updates.join(", ")} WHERE site_id = $1 AND email = $2`,
    params
  );
  return getPreferences(siteId, normalized);
}

// Genera (o riusa) il token pubblico per il centro preferenze.
export async function getOrCreatePrefToken(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();
  await query(
    `INSERT INTO contacts (site_id, email) VALUES ($1, $2) ON CONFLICT (site_id, email) DO NOTHING`,
    [siteId, normalized]
  );
  const row = (await query(
    "SELECT pref_token FROM contacts WHERE site_id = $1 AND email = $2",
    [siteId, normalized]
  )).rows[0];
  if (row?.pref_token) return row.pref_token;
  const token = crypto.randomBytes(32).toString("hex");
  await query(
    "UPDATE contacts SET pref_token = $1 WHERE site_id = $2 AND email = $3",
    [token, siteId, normalized]
  );
  return token;
}

// Risolve il contatto dal token (per la pagina pubblica).
export async function getContactByPrefToken(token) {
  if (!token || typeof token !== "string") return null;
  const row = (await query(
    `SELECT site_id, email, pref_email, pref_sms, pref_phone, pref_whatsapp, pref_marketing
     FROM contacts WHERE pref_token = $1`,
    [token]
  )).rows[0];
  if (!row) return null;
  return {
    siteId: row.site_id,
    email: row.email,
    pref_email: !!row.pref_email,
    pref_sms: !!row.pref_sms,
    pref_phone: !!row.pref_phone,
    pref_whatsapp: !!row.pref_whatsapp,
    pref_marketing: !!row.pref_marketing,
  };
}

// Costruisce l'URL del centro preferenze (per il link nelle email).
export function preferenceUrl(baseUrl, token) {
  return `${baseUrl}/preferences/${token}`;
}

// Sostituisce {{pref_url}} e {{unsubscribe_url}} in un HTML email.
export function injectPreferenceLinks(html, { baseUrl, token }) {
  if (!html) return html;
  const prefUrl = preferenceUrl(baseUrl, token);
  return html
    .replace(/\{\{pref_url\}\}/g, prefUrl)
    .replace(/\{\{unsubscribe_url\}\}/g, `${baseUrl}/newsletter/unsubscribe/${token}`);
}
