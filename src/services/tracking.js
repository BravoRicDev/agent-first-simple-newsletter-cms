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
  // Provider del banner di consenso: "native" (banner CMS integrato,
  // default — vuoto = native, retrocompatibile) oppure "library" (libreria
  // condivisa mantenuta in questo repo, public/consent/*, personalizzabile
  // per-sito solo su testi/CSS/posizione/lingua — vedi sotto).
  // "external" (banner completamente arbitrario, vendored per-sito fuori
  // dal repo in media/<site>/consent/) NON è più selezionabile dall'admin:
  // un bridge scritto ad hoc, fuori dal nostro controllo, poteva riapplicare
  // il consenso senza le guardie anti-doppio-evento del CMS (PageView/Lead
  // duplicati). Un valore "external" salvato in passato viene normalizzato
  // automaticamente a "library" in getSiteTrackingConfig, sotto.
  consentProvider: "tracking_consent_provider",
  // URL della libreria di consenso (JS) e del relativo CSS, e dello script
  // che la inizializza/bridgea sui cookie CMS. Con provider "library"
  // puntano di default agli asset condivisi del repo (public/consent/*);
  // un override esplicito resta possibile ma non più esposto in UI.
  consentLibUrl: "tracking_consent_lib_url",
  consentLibCssUrl: "tracking_consent_lib_css_url",
  consentScriptUrl: "tracking_consent_script_url",
  // ── Provider "library" (banner a libreria condivisa nel repo) ──────────
  // Testi/posizione/lingua per-sito, usati dal bridge vendored in
  // public/consent/bridge.js tramite window.__cmsConsentConfig. Nessuna
  // dipendenza da media/ al volo: la lib (consent.js/consent.css) è servita
  // staticamente dal repo, il bridge è generico e corretto.
  consentTitle: "tracking_consent_title",
  consentDescription: "tracking_consent_description",
  consentPreferencesTitle: "tracking_consent_preferences_title",
  consentAcceptAllLabel: "tracking_consent_accept_all_label",
  consentRejectLabelLib: "tracking_consent_reject_label",
  consentPreferencesLabel: "tracking_consent_preferences_label",
  consentSaveLabel: "tracking_consent_save_label",
  consentCloseLabel: "tracking_consent_close_label",
  consentNecessaryTitle: "tracking_consent_necessary_title",
  consentNecessaryDesc: "tracking_consent_necessary_desc",
  consentAnalyticsTitle: "tracking_consent_analytics_title",
  consentAnalyticsDesc: "tracking_consent_analytics_desc",
  consentMarketingTitle: "tracking_consent_marketing_title",
  consentMarketingDesc: "tracking_consent_marketing_desc",
  consentPosition: "tracking_consent_position",
  consentLanguage: "tracking_consent_language",
  consentRevision: "tracking_consent_revision",
  // Evento Meta Pixel da sparare lato browser su pagine di conversione che
  // non passano da un submit gestito dal CMS (es. form esterni: videoask,
  // altri CRM). Gated SEMPRE su consenso marketing (Consent Mode v2), una
  // volta per sessione. Vuoto = nessun Lead automatico (comportamento
  // attuale, nessuna regressione).
  leadEventName: "tracking_lead_event",
  // Pagine su cui sparare leadEventName: lista separata da virgole di
  // sottostringhe del pathname (case-insensitive, match "contiene"), es.
  // "/thank-you,/grazie". Vuoto = nessun Lead automatico anche se
  // leadEventName è impostato (entrambe le chiavi servono).
  leadPages: "tracking_lead_pages",
  // Durata (in ore) dei cookie consent_analytics/consent_marketing e del
  // cookie interno del provider "library" (cc_cookie). Default 1 ora
  // (DEFAULT_CONSENT_COOKIE_HOURS sotto): scaduta, il banner ricompare e
  // l'utente deve ridare il consenso. Override per-pagina possibile in
  // page_tracking_overrides.consent_cookie_hours (vedi getEffectiveTrackingConfig).
  consentCookieHours: "tracking_consent_cookie_hours",
};

// Default globale: nessun valore salvato in settings = 1 ora. Cambiare la
// durata di default per TUTTI i siti che non la impostano esplicitamente
// va fatto qui (decisione di prodotto, non retrocompatibilità: prima
// dell'introduzione di questo campo la durata era fissa a 365 giorni negli
// script client — vedi tracking-body.ejs/bridge.js).
const DEFAULT_CONSENT_COOKIE_HOURS = 1;

const CONSENT_DEFAULTS = {
  consentBannerText: "Usiamo cookie tecnici necessari e, solo con il tuo consenso, cookie di analisi e marketing.",
  consentAcceptLabel: "Accetta tutti",
  consentRejectLabel: "Solo necessari",
  consentPrivacyUrl: "",
};

function emptyConfig() {
  const c = {};
  for (const field of Object.keys(TRACKING_KEYS)) c[field] = "";
  c.consentProvider = "native";
  c.consentCookieHours = DEFAULT_CONSENT_COOKIE_HOURS;
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
  // Vuoto = "native" (retrocompatibile: nessuna riga in settings finora
  // significava "banner CMS integrato", e deve continuare a significarlo).
  if (!c.consentProvider) c.consentProvider = "native";
  // "external" non è più selezionabile dall'admin (vedi commento su
  // TRACKING_KEYS.consentProvider): un sito configurato in passato viene
  // migrato in automatico su "library", che usa lo stesso meccanismo ma con
  // codice che controlliamo (nessuna azione richiesta lato admin/sito).
  if (c.consentProvider === "external") c.consentProvider = "library";
  // "library" usa di default gli asset condivisi del REPO (public/consent/*).
  if (c.consentProvider === "library") {
    c.consentLibUrl = c.consentLibUrl || '/consent/consent.js';
    c.consentLibCssUrl = c.consentLibCssUrl || '/consent/consent.css';
    c.consentScriptUrl = c.consentScriptUrl || '/consent/bridge.js';
  }
  // Durata cookie di consenso: numero intero di ore, sempre valorizzato
  // (mai stringa vuota) così i template client-side possono usarlo senza
  // ulteriori controlli di undefined.
  const parsedHours = parseInt(c.consentCookieHours, 10);
  c.consentCookieHours = Number.isFinite(parsedHours) && parsedHours > 0 ? parsedHours : DEFAULT_CONSENT_COOKIE_HOURS;
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

// ── Per-pagina tracking overrides ───────────────────────────────────────────
// Tabella: page_tracking_overrides (page_id PK, pixel_enabled, track_pageview,
// track_lead, consent_cookie_hours — tutti NULLABLE per tri-state: NULL =
// eredita, valore impostato = override)

export async function getPageTrackingOverride(pageId) {
  if (!pageId) return {};
  const result = await query(
    `SELECT pixel_enabled, track_pageview, track_lead, consent_cookie_hours
     FROM page_tracking_overrides WHERE page_id = $1`,
    [pageId]
  );
  if (result.rows.length === 0) return {};
  const row = result.rows[0];
  return {
    pixel_enabled: row.pixel_enabled ?? null,
    track_pageview: row.track_pageview ?? null,
    track_lead: row.track_lead ?? null,
    consent_cookie_hours: row.consent_cookie_hours ?? null,
  };
}

export async function setPageTrackingOverride(pageId, fields) {
  if (!pageId) return;

  // Campi: pixelEnabled, trackPageview, trackLead, consentCookieHours
  // (camelCase dall'API/UI). undefined = non toccare (chiave assente);
  // null = resetta a eredita (NULL nel DB). Tipi diversi per colonna:
  // i primi tre sono booleani, consentCookieHours è un intero (ore) > 0.
  const fieldMap = {
    pixelEnabled: { col: "pixel_enabled", type: "boolean" },
    trackPageview: { col: "track_pageview", type: "boolean" },
    trackLead: { col: "track_lead", type: "boolean" },
    consentCookieHours: { col: "consent_cookie_hours", type: "integer" },
  };

  const cols = [];
  const values = [pageId];
  const updateSets = [];
  let paramIdx = 2;

  for (const [apiField, { col: dbField, type }] of Object.entries(fieldMap)) {
    if (apiField in fields) {
      const raw = fields[apiField];
      let value;
      if (raw === null) {
        value = null;
      } else if (type === "boolean") {
        value = raw === true;
      } else {
        // integer: scarta valori non validi (<=0, NaN) come "eredita",
        // invece di salvare un override inutilizzabile lato client.
        const n = parseInt(raw, 10);
        value = Number.isFinite(n) && n > 0 ? n : null;
      }
      cols.push(dbField);
      values.push(value);
      updateSets.push(`${dbField} = $${paramIdx}`);
      paramIdx++;
    }
  }

  if (cols.length === 0) return;

  // NB: updated_at è un letterale (NOW()) sia in INSERT che in UPDATE, MAI
  // un placeholder — così il numero di colonne dichiarate combacia sempre
  // col numero di placeholder in VALUES (bug precedente: la colonna
  // updated_at finiva nella lista colonne ma non aveva un $N corrispondente,
  // "INSERT has more target columns than expressions").
  const sql = `
    INSERT INTO page_tracking_overrides (page_id, ${cols.join(", ")}, updated_at)
    VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")}, NOW())
    ON CONFLICT (page_id) DO UPDATE SET ${updateSets.join(", ")}, updated_at = NOW()
  `;
  await query(sql, values);
}

export async function getEffectiveTrackingConfig(siteId, pageId) {
  const siteConfig = await getSiteTrackingConfigMasked(siteId);
  const pageOverride = await getPageTrackingOverride(pageId);

  // Default site-level: pixel è attivo se c'è un metaPixelId
  // trackPageview default true se c'è tracking, trackLead dipende da leadPages/leadEventName (logica client-side)
  const effective = { ...siteConfig };

  // pixelEnabled: default true se il sito ha metaPixelId, altrimenti false
  // ma se l'override è esplicito (true/false/null), usa quello
  if (pageOverride.pixel_enabled !== undefined && pageOverride.pixel_enabled !== null) {
    effective.pixelEnabled = pageOverride.pixel_enabled;
  } else {
    effective.pixelEnabled = !!siteConfig.metaPixelId;
  }

  // trackPageview: default true se il sito ha tracking, override se impostato
  if (pageOverride.track_pageview !== undefined && pageOverride.track_pageview !== null) {
    effective.trackPageview = pageOverride.track_pageview;
  } else {
    effective.trackPageview = siteConfig.hasAnyTracking;
  }

  // leadOverride: true|false|null (null = nessun override, usa logica leadPages client-side)
  // Questo serve solo per FORZARE on/off il Lead indipendentemente dal match leadPages
  if (pageOverride.track_lead !== undefined && pageOverride.track_lead !== null) {
    effective.leadOverride = pageOverride.track_lead;
  } else {
    effective.leadOverride = null;
  }

  // consentCookieHours: default dal sito (già normalizzato a un intero > 0
  // in getSiteTrackingConfig), sovrascritto se questa pagina ha un override.
  if (pageOverride.consent_cookie_hours !== undefined && pageOverride.consent_cookie_hours !== null) {
    effective.consentCookieHours = pageOverride.consent_cookie_hours;
  }

  return effective;
}
