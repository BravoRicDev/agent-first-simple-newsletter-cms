import nodemailer from "nodemailer";
import { query } from "../db.js";
import { translate } from "../middleware/i18n.js";
import { logger } from "./logger.js";
import config from "../config.js";

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  if (config.smtpHost) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: {
        user: config.smtpUser,
        pass: config.smtpPass,
      },
    });
  } else {
    // jsonTransport: le email NON vengono spedite davvero, ma sendMail()
    // risolve con successo → senza log l'assenza di SMTP è indistinguibile
    // da un problema di rete. Almeno tracciamo il fallback.
    logger.warn("SMTP di sistema non configurato: uso jsonTransport di test, le email NON vengono inviate");
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

export function resetTransporter() {
  transporter = null;
}

// Transporter dedicato per sito, usato SOLO dalla newsletter — credenziali
// lette da newsletter_settings (mai da site_variables, vedi db/018_newsletter.sql).
// Nessun fallback allo SMTP globale: se il sito non ha configurato il proprio
// SMTP, la newsletter per quel sito resta inattiva (evita invii massivi non
// intenzionali dall'account di sistema usato per i magic link).
const siteTransporters = new Map();

export function resetSiteTransporter(siteId) {
  siteTransporters.delete(siteId);
}

export async function getSiteEmailConfig(siteId) {
  const result = await query("SELECT * FROM newsletter_settings WHERE site_id = $1", [siteId]);
  const row = result.rows[0];
  if (!row || !row.smtp_host || !row.from_email) return null;
  return row;
}

async function getSiteTransporter(siteId) {
  if (siteTransporters.has(siteId)) return siteTransporters.get(siteId);
  const cfg = await getSiteEmailConfig(siteId);
  if (!cfg) return null;
  const entry = {
    fromEmail: cfg.from_email,
    transport: nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port,
      secure: cfg.smtp_port === 465,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
    }),
  };
  siteTransporters.set(siteId, entry);
  return entry;
}

export async function sendSiteEmail(siteId, to, subject, html) {
  const entry = await getSiteTransporter(siteId);
  if (!entry) throw new Error(translate(config.defaultLang, "email.siteSmtp.notConfigured", { siteId }));
  return entry.transport.sendMail({ from: entry.fromEmail, to, subject, html });
}

export async function sendMagicLink(email, token, otp) {
  const baseUrl = config.magicLinkBaseUrl;
  const emailFrom = config.emailFrom;
  const link = `${baseUrl}/login/verify?token=${token}`;
  const lang = config.defaultLang;
  const t = (key, vars) => translate(lang, key, vars);
  const appName = config.appName;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<h2>${t("email.magicLink.heading", { appName })}</h2><p>${t("email.magicLink.requestedAccess")}</p>
<p><strong>${t("email.magicLink.otpLabel")}</strong></p>
<div style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center;padding:20px;background:#f5f5f5;border-radius:8px;margin:16px 0;">${otp}</div>
<p>${t("email.magicLink.orClickLink")}</p>
<a href="${link}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:white;text-decoration:none;border-radius:6px;margin:8px 0;">${t("email.magicLink.accessButton")}</a>
<p style="color:#666;font-size:12px;margin-top:24px;">${t("email.magicLink.footer")}</p>
<p style="color:#666;font-size:12px;margin-top:8px;">Per i client CLI/agente: oltre al codice OTP servono TUTTI E DUE i valori qui sotto (il token è quello dentro il link):</p>
<div style="font-family:monospace;font-size:12px;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:10px 14px;word-break:break-all;">CODICE OTP: ${otp}<br>TOKEN: ${token}</div>
</body></html>`;
  const info = await getTransporter().sendMail({
    from: emailFrom,
    to: email,
    subject: t("email.magicLink.subject", { appName }),
    html,
  });
  return info;
}

export async function sendEmail(to, subject, html) {
  return getTransporter().sendMail({
    from: config.emailFrom,
    to,
    subject,
    html,
  });
}
