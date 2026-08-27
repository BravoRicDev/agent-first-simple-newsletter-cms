import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import ejs from "ejs";
import { query } from "../db.js";
import { logger } from "./logger.js";

const VIEWS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../views");

// Riusa la tabella "settings" già esistente (per-sito, chiave/valore, non
// espansa in {{var:}} nel contenuto pubblico — a differenza di
// site_variables, è un posto sicuro per il token CAPI) invece di una tabella
// dedicata: nessuna migrazione necessaria, e già esposta via API agente
// generica (GET/PUT /api/agent/sites/:id/settings/:key).
const TRACKING_KEYS = {
  ga4Id: "tracking_ga4_id",
  gtmId: "tracking_gtm_id",
  metaPixelId: "tracking_meta_pixel_id",
  metaCapiToken: "tracking_meta_capi_token",
  metaCapiTestCode: "tracking_meta_capi_test_code",
  clarityId: "tracking_clarity_id",
  searchConsoleVerification: "tracking_search_console_verification",
  // Testi del banner di consenso: personalizzabili, con default sensati se
  // il sito attiva il tracking senza toccarli — mai vuoti a schermo.
  consentBannerText: "tracking_consent_banner_text",
  consentAcceptLabel: "tracking_consent_accept_label",
  consentRejectLabel: "tracking_consent_reject_label",
  consentPrivacyUrl: "tracking_consent_privacy_url",
};

const CONSENT_DEFAULTS = {
  consentBannerText: "Usiamo cookie tecnici necessari e, solo con il tuo consenso, cookie di analisi e marketing.",
  consentAcceptLabel: "Accetta tutti",
  consentRejectLabel: "Solo necessari",
  consentPrivacyUrl: "",
};

function emptyConfig() {
  const c = {};
  for (const field of Object.keys(TRACKING_KEYS)) c[field] = "";
  c.hasAnyTracking = false;
  return c;
}

export async function getSiteTrackingConfig(siteId) {
  if (!siteId) return emptyConfig();
  const rows = (await query(
    "SELECT key, value FROM settings WHERE site_id = $1 AND key = ANY($2)",
    [siteId, Object.values(TRACKING_KEYS)]
  )).rows;
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]));

  const c = {};
  for (const [field, key] of Object.entries(TRACKING_KEYS)) c[field] = map[key] || "";
  c.hasAnyTracking = !!(c.ga4Id || c.gtmId || c.metaPixelId || c.clarityId);
  if (c.hasAnyTracking) {
    for (const [field, defaultValue] of Object.entries(CONSENT_DEFAULTS)) {
      if (!c[field]) c[field] = defaultValue;
    }
  }
  return c;
}

// Non ritorna metaCapiToken: chi la chiama per popolare una UI/risposta API
// deve trattarlo a parte (mascherato), stesso pattern già usato per le
// credenziali SMTP della newsletter.
export async function getSiteTrackingConfigMasked(siteId) {
  const full = await getSiteTrackingConfig(siteId);
  return { ...full, metaCapiToken: full.metaCapiToken ? "••••••••" : "" };
}

export async function setSiteTrackingConfig(siteId, fields) {
  for (const [field, key] of Object.entries(TRACKING_KEYS)) {
    if (!(field in fields)) continue;
    const value = String(fields[field] ?? "").trim();
    if (value) {
      await query(
        `INSERT INTO settings (site_id, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (site_id, key) DO UPDATE SET value = $3`,
        [siteId, key, value]
      );
    } else {
      await query("DELETE FROM settings WHERE site_id = $1 AND key = $2", [siteId, key]);
    }
  }
}

// ── Meta Conversions API ─────────────────────────────────────────────────
// Eventi lato server per i momenti di conversione reali già presenti
// nell'app (invio form, conferma iscrizione newsletter, prenotazione
// chiamata) — non un generico PageView server-side: le pagine statiche
// esportate sono servite da Caddy, fuori dalla visibilità di Express, quindi
// un PageView server-side sistematico non sarebbe comunque raggiungibile per
// una parte del traffico. Il pixel client-side copre già il PageView.
// Nessun event_id condiviso col client: questi eventi non hanno una
// corrispondente chiamata fbq('track', ...) lato client da deduplicare
// (il flusso di submit di questi form è un redirect classico, non SPA).
const META_API_VERSION = "v21.0";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");
}

// consentGranted va deciso da chi chiama leggendo il cookie di consenso
// marketing della richiesta — qui non si presume nulla, si rifiuta l'invio
// se non esplicitamente true (fail-safe: in dubbio, non si manda).
export async function sendMetaCapiEvent(siteId, eventName, {
  email, eventSourceUrl, actionSource = "website",
  clientIp, userAgent, customData, consentGranted, dedupKey,
} = {}) {
  if (!consentGranted) return { sent: false, reason: "no_consent" };

  const trackingConfig = await getSiteTrackingConfig(siteId);
  if (!trackingConfig.metaPixelId || !trackingConfig.metaCapiToken) {
    return { sent: false, reason: "not_configured" };
  }

  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;

  // event_id DETERMINISTICO: con crypto.randomUUID() due invii dello stesso
  // form (doppio click, retry, bot) producevano event_id diversi → Meta
  // deduplica per event_id+event_name entro 48h → conversioni conteggiate
  // doppie nelle campagne. Ora: stesso dedupKey (es. id riga DB) o stesso
  // (sito, evento, email) entro 60s → stesso event_id → dedup corretto.
  const bucket = Math.floor(Date.now() / 60000);
  const rawKey = dedupKey
    ? `${siteId}:${eventName}:${dedupKey}`
    : `${siteId}:${eventName}:${String(email || "")}:${bucket}`;
  const eventId = crypto.createHash("sha256").update(rawKey).digest("hex").slice(0, 32);

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: eventSourceUrl,
    action_source: actionSource,
    user_data: userData,
    ...(customData ? { custom_data: customData } : {}),
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${trackingConfig.metaPixelId}/events`;
  const body = {
    data: [event],
    ...(trackingConfig.metaCapiTestCode ? { test_event_code: trackingConfig.metaCapiTestCode } : {}),
  };

  try {
    const res = await fetch(`${url}?access_token=${encodeURIComponent(trackingConfig.metaCapiToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Timeout: i chiamanti lanciano fire-and-forget; senza timeout, se
      // graph.facebook.com non risponde le promise pendono e si accumulano.
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.error(`Meta CAPI: invio fallito (site=${siteId}, event=${eventName}): ${res.status} ${text}`);
      return { sent: false, reason: "http_error" };
    }
    return { sent: true, eventId: event.event_id };
  } catch (err) {
    logger.error(`Meta CAPI: errore rete (site=${siteId}, event=${eventName}): ${err.message}`);
    return { sent: false, reason: "network_error" };
  }
}

export function isMarketingConsentGranted(req) {
  return req.cookies?.consent_marketing === "1";
}

// ── Tracking sulle pagine standalone ─────────────────────────────────────
// Il layout EJS (wrapped) include tracking-head.ejs nel <head> e
// tracking-body.ejs prima di </body>. Le pagine standalone non passano dal
// layout: renderizziamo gli stessi due partial e li cuciamo nell'HTML
// salvato, così GA4/GTM/pixel/banner consenso funzionano identici.
// locals DEVE contenere la config tracking (già mascherata) + i testi del
// banner: es. `{ ...themeVars }` come costruito in serve.js / static-export.js.
export async function renderTrackingBlocks(locals) {
  if (!locals || !locals.hasAnyTracking) return { head: "", body: "" };
  const opts = { ...locals, layout: false, cache: false };
  const [head, body] = await Promise.all([
    ejs.renderFile(path.join(VIEWS_DIR, "partials", "tracking-head.ejs"), opts),
    ejs.renderFile(path.join(VIEWS_DIR, "partials", "tracking-body.ejs"), opts),
  ]);
  return { head, body };
}

// Inietta i blocchi tracking in un documento HTML standalone:
// - head → prima di </head> (gli script di tracking DEVONO stare nel head,
//   il consent default deve precedere il caricamento di gtag/GTM);
// - body (banner + JS consenso) → prima di </body>, con fallback prima di
//   </html> e, in ultima istanza, in coda al documento (markup anomalo).
// Se manca </head> il blocco head viene scartato, non il documento.
export function injectTrackingIntoStandalone(html, { head = "", body = "" } = {}) {
  if (typeof html !== "string" || !html) return html;

  if (head) {
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, () => `${head}\n</head>`);
    }
    // senza </head>: blocco head scartato (markup anomalo)
  }

  if (body) {
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, () => `${body}\n</body>`);
    } else if (/<\/html>/i.test(html)) {
      html = html.replace(/<\/html>/i, () => `${body}\n</html>`);
    } else {
      html += `\n${body}`;
    }
  }

  return html;
}
