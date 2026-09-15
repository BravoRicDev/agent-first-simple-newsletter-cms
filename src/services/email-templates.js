import { query } from "../db.js";
import { translate } from "../middleware/i18n.js";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────
// Template email per sito (Livello sito). Ogni tipo di email di sistema
// può avere un override di subject/body per sito (tabella email_templates);
// se non esiste, si usa il default standard (locales/*.json o il testo
// hardcoded del chiamante). I placeholder {var} vengono interpolati con la
// stessa sintassi dei locales (translate).
// ─────────────────────────────────────────────────────────────────────────

export const EMAIL_TEMPLATE_KINDS = [
  "newsletter_confirm",
  "newsletter_test",
  "call_confirmation",
  "call_reminder",
  "form_notify",
  "deploy_notify",
  "review_reminder",
];

export async function getEmailTemplate(siteId, kind) {
  const row = (await query(
    "SELECT subject, body_html FROM email_templates WHERE site_id = $1 AND kind = $2",
    [siteId, kind]
  )).rows[0];
  return row || null;
}

export async function setEmailTemplate(siteId, kind, { subject, body_html }) {
  await query(
    `INSERT INTO email_templates (site_id, kind, subject, body_html, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (site_id, kind)
     DO UPDATE SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, updated_at = NOW()`,
    [siteId, kind, String(subject ?? ""), String(body_html ?? "")]
  );
  return getEmailTemplate(siteId, kind);
}

export async function deleteEmailTemplate(siteId, kind) {
  await query("DELETE FROM email_templates WHERE site_id = $1 AND kind = $2", [siteId, kind]);
}

export async function listEmailTemplates(siteId) {
  const rows = (await query(
    "SELECT kind, subject, body_html, updated_at FROM email_templates WHERE site_id = $1 ORDER BY kind",
    [siteId]
  )).rows;
  const found = new Set(rows.map(r => r.kind));
  return {
    templates: rows,
    kinds: EMAIL_TEMPLATE_KINDS.map(kind => ({ kind, configured: found.has(kind) })),
  };
}

export function interpolate(str, vars) {
  if (!str) return "";
  let out = String(str);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v ?? ""));
    }
  }
  return out;
}

// Risolve subject + html per un tipo di email: override per sito se
// configurato (anche parzialmente: subject/body scelti singolarmente),
// altrimenti fallback ai default passati dal chiamante.
export async function renderEmail(siteId, kind, { vars = {}, defaultSubject, defaultBody }) {
  const tpl = await getEmailTemplate(siteId, kind);
  if (!tpl) {
    return {
      subject: translate(config.defaultLang, defaultSubject, vars),
      html: defaultBody ? interpolate(defaultBody, vars) : translate(config.defaultLang, defaultBody ?? "", vars),
      template: null,
    };
  }
  return {
    subject: tpl.subject ? interpolate(tpl.subject, vars) : translate(config.defaultLang, defaultSubject, vars),
    html: tpl.body_html ? interpolate(tpl.body_html, vars) : defaultBody ? interpolate(defaultBody, vars) : "",
    template: tpl,
  };
}