import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Email tracking — click tracking e helper eventi.
//
// L'open tracking esiste già (pixel /newsletter/track/:kind/:trackId/:token,
// aggiorna opened_at su newsletter_sends / newsletter_sequence_sends).
// Qui aggiungiamo:
//   1. injectClickTracking(): riscrive i link http/https delle email con
//      /track/click/... (redirect con registrazione click)
//   2. recordEmailEvent(): INSERT in newsletter_send_events + emissione
//      evento contatto (email_opened / email_clicked) per workflow/scoring.
// ─────────────────────────────────────────────────────────────────────────

const GIF_1x1 = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export function transparentGif() {
  return GIF_1x1;
}

// Riscrive i link http/https in /track/click/:kind/:sendId?u=<encoded>.
// mailto:, tel:, #, // (protocol-relative) e link già riscritti restano
// invariati. Il tracking viene applicato SOLO se tracking_email_enabled
// (variabile di sito, default true).
export function injectClickTracking(html, { kind, sendId, baseUrl }) {
  if (!html || typeof html !== "string") return html;
  const prefix = `${baseUrl}/track/click/${kind}/${sendId}?u=`;
  // Regex: href="..." o href='...' con URL assoluto http/https.
  return html.replace(/href=(["'])((?:https?:)?\/\/[^"'\s]+)\1/gi, (match, quote, url) => {
    // Protocol-relative (//evil.com) → NON riscrivere (potrebbe essere
    // esterno; il tracking di un link protocol-relative è ambiguo).
    if (url.startsWith("//")) return match;
    if (!/^https?:\/\//i.test(url)) return match;
    if (url.includes("/track/click/")) return match; // già riscritto
    const encoded = encodeURIComponent(url);
    if (prefix.length + encoded.length > 2500) return match; // troppo lungo
    return `href=${quote}${prefix}${encoded}${quote}`;
  });
}

// Validazione URL per il redirect click: solo http/https, niente userinfo
// (@ prima del path = spoofing tipo https://evil.com@trusted.com), niente
// CRLF, max 2048 char. Non valida → "/" (mai eseguire javascript: ecc.).
export function sanitizeClickUrl(raw) {
  const value = String(raw || "").trim();
  if (value.length === 0 || value.length > 2048) return "/";
  if (/[\r\n]/.test(value)) return "/";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "/";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "/";
  if (parsed.username || parsed.password) return "/";
  return parsed.toString();
}

// Risolve send_id + email per un evento di tracking. kind: "c"=campaign,
// "s"=sequence (stessa convenzione dell'open pixel esistente).
export async function resolveSendEmail(kind, sendId) {
  if (kind === "s") {
    const row = (await query(
      `SELECT se.id, sub.email, se.step_id AS ref_id
       FROM newsletter_sequence_sends se
       JOIN newsletter_subscribers sub ON sub.id = se.subscriber_id
       WHERE se.id = $1`,
      [sendId]
    )).rows[0];
    return row ? { email: row.email, siteId: null } : null;
  }
  const row = (await query(
    `SELECT ns.id, sub.email, ns.campaign_id AS ref_id
     FROM newsletter_sends ns
     JOIN newsletter_subscribers sub ON sub.id = ns.subscriber_id
     WHERE ns.id = $1`,
    [sendId]
  )).rows[0];
  return row ? { email: row.email, siteId: null } : null;
}

// Registra un evento di tracking (open o click) e notifica il contatto.
// site_id viene dal subscriber (newsletter_subscribers.site_id).
export async function recordEmailEvent({ kind, sendId, email, eventType, url = "", siteId }) {
  if (!email || !sendId) return;
  try {
    await query(
      `INSERT INTO newsletter_send_events (site_id, send_id, kind, event_type, url, email)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [siteId || 0, sendId, kind === "s" ? "sequence" : "campaign", eventType, url.slice(0, 2048), email]
    );
  } catch (err) {
    // silenzioso: il tracking non deve mai rompere il redirect/pixel
  }
  try {
    const { emitContactEventAsync } = await import("./events.js");
    emitContactEventAsync(
      siteId || 0,
      email,
      eventType === "click" ? "email_clicked" : "email_opened",
      { send_id: sendId, kind: kind === "s" ? "sequence" : "campaign", url: url.slice(0, 500) }
    );
  } catch {
    // silenzioso
  }
}
