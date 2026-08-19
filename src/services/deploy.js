import { logger } from "./logger.js";
import { sendEmail } from "./email.js";
import { query } from "../db.js";
import { exportPublishedPages } from "./static-export.js";
import { translate } from "../middleware/i18n.js";
import { renderEmail } from "./email-templates.js";
import config from "../config.js";

const t = (key, vars) => translate(config.defaultLang, key, vars);

async function purgeCloudflare(zoneId, apiToken, paths = null) {
  const body = paths
    ? { files: paths }
    : { purge_everything: true };

  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const data = await res.json();
  if (!data.success) {
    throw new Error("Cloudflare purge fallito: " + JSON.stringify(data.errors));
  }
  return data;
}

async function callDeployWebhook(webhookUrl, payload) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return res.ok;
}

export async function deploysite({ siteId, siteName, siteDomain, userId, pages = [], note = "" }) {
  const results = {
    cloudflare: null,
    webhook: null,
    email: null,
    errors: [],
  };

  const deployPayload = {
    site_id: siteId,
    site_name: siteName,
    site_domain: siteDomain,
    deployed_by: userId,
    pages_affected: pages,
    note,
    deployed_at: new Date().toISOString(),
  };

  // Export statico prima del purge CDN
  try {
    const exportResult = await exportPublishedPages({ siteId });
    const failedPages = (exportResult?.results || []).filter(r => !r.ok);
    if (failedPages.length > 0) {
      results.errors.push(...failedPages.map(r => `Export statico (${r.url_path}): ${r.error}`));
      logger.error(`Deploy: static export completato con ${failedPages.length} errori per site ${siteId}`, { errors: failedPages });
    } else {
      logger.info(`Deploy: static export completato per site ${siteId}`);
    }
  } catch (err) {
    results.errors.push(`Export statico: ${err.message}`);
    logger.error("Deploy: static export fallito", { error: err.message });
  }

  const cfZone = config.cloudflareZoneId;
  const cfToken = config.cloudflareApiToken;
  if (cfZone && cfToken) {
    if (!siteDomain || !siteDomain.trim()) {
      results.errors.push("Dominio del sito non configurato, impossibile fare purge Cloudflare");
    } else {
      try {
        if (pages.length > 0 && pages.length <= 30) {
          const urls = pages.map(p => `https://${siteDomain}${p}`);
          await purgeCloudflare(cfZone, cfToken, urls);
        } else {
          await purgeCloudflare(cfZone, cfToken);
        }
        results.cloudflare = "ok";
        logger.info(`Deploy: Cloudflare purge completato per ${siteDomain}`);
      } catch (err) {
        results.cloudflare = "error";
        results.errors.push(`Cloudflare: ${err.message}`);
        logger.error("Deploy: Cloudflare purge fallito", { error: err.message });
      }
    }
  }

  const webhookUrl = config.deployWebhookUrl;
  if (webhookUrl) {
    try {
      const ok = await callDeployWebhook(webhookUrl, deployPayload);
      results.webhook = ok ? "ok" : "error";
    } catch (err) {
      results.webhook = "error";
      results.errors.push(`Webhook: ${err.message}`);
    }
  }

  try {
    const adminEmails = (await query(
      `SELECT u.email FROM users u WHERE u.site_id = $1 AND u.status = 'active'
       AND u.role IN ('admin', 'superadmin')`,
      [siteId]
    )).rows.map(r => r.email);

    if (adminEmails.length > 0) {
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const pageList = pages.length > 0
        ? `<ul>${pages.map(p => `<li><code>${esc(p)}</code></li>`).join("")}</ul>`
        : `<p>${t("email.deployNotify.generalChanges")}</p>`;
      const dateLocale = config.defaultLang === "it" ? "it-IT" : "en-US";
      const dateStr = new Date().toLocaleString(dateLocale);

      const defaultHtml = `
        <h2>${esc(t("email.deployNotify.subject", { siteName }))}</h2>
        <p>${esc(t("email.deployNotify.completedBy", { siteDomain }))}</p>
        ${note ? `<p><strong>${esc(t("email.deployNotify.notesLabel"))}</strong> ${esc(note)}</p>` : ""}
        <p><strong>${esc(t("email.deployNotify.pagesInvolvedLabel"))}</strong></p>
        ${pageList}
        <p style="color:#888;font-size:12px">${esc(t("email.deployNotify.executedOn", { date: dateStr }))}</p>
      `;

      // Override per sito (email_templates kind=deploy_notify) se configurato.
      const { subject, html } = await renderEmail(siteId, "deploy_notify", {
        vars: { siteName, siteDomain, note, pageList, date: dateStr },
        defaultSubject: "email.deployNotify.subject",
        defaultBody: defaultHtml,
      });

      await sendEmail(adminEmails.join(","), subject, html);
      results.email = "ok";
    }
  } catch (err) {
    results.email = "error";
    results.errors.push(`Email: ${err.message}`);
  }

  return results;
}
