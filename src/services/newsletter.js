import crypto from "crypto";
import { query } from "../db.js";
import { sendSiteEmail } from "./email.js";
import { expandSnippets } from "./page-renderer.js";
import { logger } from "./logger.js";
import { addConversationMessage } from "./conversations.js";
import { translate } from "../middleware/i18n.js";
import config from "../config.js";
import { getCanonicalBaseUrl } from "./urls.js";
import { renderEmail, getEmailTemplate, interpolate } from "./email-templates.js";
import { verifySubscriberEmail } from "./email-verify.js";
import { classifySmtpError, recordBounce } from "./bounce.js";

// Versione leggibile dell'HTML per la conversazione (niente tag, niente
// tracking). Usata solo per registrare l'outbound nel thread del contatto.
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

// Registra l'email inviata nel thread conversazione del contatto
// (fire-and-forget: un errore qui non deve mai far fallire l'invio).
function recordEmailConversation(siteId, email, subject, html, meta) {
  addConversationMessage(siteId, email, "email", {
    direction: "out",
    subject,
    body: htmlToText(html).slice(0, 10000),
    meta,
  }).catch((err) => logger.error(`Conversazione email non registrata (${email}): ${err.message}`));
}

const t = (key, vars) => translate(config.defaultLang, key, vars);

// Email di doppio opt-in, riusata sia dalla route pubblica di iscrizione
// (src/routes/newsletter.js) sia dall'import assistito via API agente
// (POST /api/agent/sites/:siteId/newsletter/subscribers senza confirmed:true).
export async function sendConfirmationEmail(siteId, email, token) {
  const site = (await query("SELECT name FROM sites WHERE id = $1", [siteId])).rows[0];
  const siteName = site?.name || t("email.newsletterConfirm.defaultSiteName");
  const baseUrl = await getCanonicalBaseUrl(siteId);
  const confirmUrl = `${baseUrl}/newsletter/confirm/${token}`;
  // Override per sito (email_templates kind=newsletter_confirm) se configurato,
  // altrimenti default standard dai locales. Placeholder disponibili:
  // {siteName}, {confirmUrl}.
  const { subject, html } = await renderEmail(siteId, "newsletter_confirm", {
    vars: { siteName, confirmUrl },
    defaultSubject: "email.newsletterConfirm.subject",
    defaultBody: `<p>${t("email.newsletterConfirm.body", { siteName })}</p>
     <a href="{confirmUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;text-decoration:none;border-radius:6px;">${t("email.newsletterConfirm.button")}</a>
     <p style="color:#666;font-size:12px;margin-top:16px;">${t("email.newsletterConfirm.footer")}</p>`,
  });
  return sendSiteEmail(
    siteId,
    email,
    subject,
    html
  );
}

// Iscrizione con doppio opt-in — stessa logica della route pubblica
// /newsletter/:siteId/subscribe (src/routes/newsletter.js), estratta qui per
// essere riusata anche dal form builder (iscrizione automatica se un campo
// checkbox marcato come consenso è spuntato, vedi routes/forms.js). Un
// iscritto già confermato non riceve una nuova email di conferma.
// BLOCCO A: verifica email PRIMA di inserire — bloccata se spam/no-reply/disposable/no MX.
export async function subscribeEmail(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();

  // Verifica email prima di procedere con insert/update.
  const verification = await verifySubscriberEmail(normalized);
  if (verification.status === "blocked") {
    // Email bloccata: non inserire, non inviare conferma, ritorna blocco.
    return { blocked: true, reason: verification.reason };
  }

  const existing = (await query(
    "SELECT id, token, status FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
    [siteId, normalized]
  )).rows[0];

  let token;
  if (!existing) {
    token = crypto.randomBytes(32).toString("hex");
    await query(
      `INSERT INTO newsletter_subscribers (site_id, email, status, token, verification, verified_at)
       VALUES ($1, $2, 'pending', $3, $4, NOW())`,
      [siteId, normalized, token, verification.status]
    );
  } else if (existing.status === "confirmed") {
    return { alreadyConfirmed: true };
  } else {
    // Re-subscribe: genera SEMPRE un nuovo token. Riutilizzare existing.token
    // (anche dopo unsubscribe) lasciava in circolazione il vecchio token nei
    // log/pixel: chiunque lo avesse poteva disiscrivere la vittima di nuovo,
    // in qualsiasi momento e ripetutamente.
    token = crypto.randomBytes(32).toString("hex");
    await query(
      `UPDATE newsletter_subscribers SET status = 'pending', token = $2, subscribed_at = NOW(), unsubscribed_at = NULL, verification = $3, verified_at = NOW() WHERE id = $1`,
      [existing.id, token, verification.status]
    );
  }

  await sendConfirmationEmail(siteId, normalized, token)
    .catch(err => logger.error(`Newsletter: email di conferma fallita (site=${siteId}, ${normalized}): ${err.message}`));
  return { alreadyConfirmed: false };
}

// Quota oraria condivisa tra broadcast (newsletter_sends) e sequenze
// evergreen (newsletter_sequence_sends) — stesso account SMTP per sito,
// un unico limite complessivo, non due che sommandosi lo superano.
async function quotaRemaining(siteId, ratePerHour) {
  const r = await query(
    `SELECT
       (SELECT COUNT(*) FROM newsletter_sends ns
        JOIN newsletter_campaigns nc ON nc.id = ns.campaign_id
        WHERE nc.site_id = $1 AND ns.sent_at >= NOW() - INTERVAL '1 hour')
     +
       (SELECT COUNT(*) FROM newsletter_sequence_sends nss
        JOIN newsletter_sequence_steps st ON st.id = nss.step_id
        JOIN newsletter_sequences sq ON sq.id = st.sequence_id
        WHERE sq.site_id = $1 AND nss.sent_at >= NOW() - INTERVAL '1 hour')
     AS c`,
    [siteId]
  );
  const sentLastHour = parseInt(r.rows[0].c, 10);
  return Math.max(0, ratePerHour - sentLastHour);
}

// Pixel di apertura + link disiscrizione + firma del sito, aggiunti dal
// server ad ogni invio (non dal contenuto della campagna/step) — così sono
// sempre presenti e coerenti con il token del destinatario. `kind` è "c"
// (campagna broadcast) o "s" (step di sequenza), usato dalla route pubblica
// di tracking per sapere in quale tabella *_sends aggiornare l'apertura.
function formatSignature(signatureHtml) {
  return signatureHtml ? `<div style="margin-top:16px;">${signatureHtml}</div>` : "";
}

function buildFooter(baseUrl, kind, trackId, token, signatureHtml) {
  const signature = formatSignature(signatureHtml);
  return `
${signature}
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#999;">
  <a href="${baseUrl}/newsletter/unsubscribe/${token}" style="color:#999;">Disiscriviti</a>
  <img src="${baseUrl}/newsletter/track/${kind}/${trackId}/${token}.gif" width="1" height="1" alt="" style="display:none;">
</div>`;
}

// Il "costruttore": il contenuto passa per lo stesso motore snippet/variabili
// usato dalle pagine (src/services/page-renderer.js), espanso al momento
// dell'invio — non al salvataggio. Un {{snippet:...}}/{{var:...}} nel corpo
// della campagna/step viene composto con i blocchi già gestiti per il sito.
// I link http/https vengono riscritti per il click tracking (se il sito ha
// tracking email attivo) e {{pref_url}}/{{unsubscribe_url}} sostituiti.
async function buildEmailHtml(siteId, rawHtml, signatureHtml, baseUrl, kind, trackId, token) {
  const expanded = await expandSnippets(siteId, rawHtml);
  let html = expanded + buildFooter(baseUrl, kind, trackId, token, signatureHtml);

  const trackingVar = (await query(
    "SELECT value FROM site_variables WHERE site_id = $1 AND key = 'tracking_email_enabled'",
    [siteId]
  )).rows[0];
  const trackingEnabled = trackingVar?.value !== "0" && trackingVar?.value !== "false";

  if (trackingEnabled) {
    const { injectClickTracking } = await import("./tracking-email.js");
    // Il pixel open resta in buildFooter (già presente); qui aggiungiamo il
    // click tracking. sendId per il click è lo stesso trackId (campagna o
    // step) — il redirect risolve email via subscriber token? No: il click
    // redirect NON ha il token del subscriber nel path (solo nel pixel).
    // Per semplificare e mantenere la privacy (email mai in URL), il click
    // tracking usa sendId = trackId e risolve il subscriber dal token nel
    // query string... ma i link riscritti non hanno il token.
    //
    // Decisione: il click tracking registra solo l'evento aggregato (send_id
    // + url), senza email — gli eventi granulari con email arrivano dal
    // pixel open (che ha il token). Per l'email nel contact_event usiamo
    // l'open (già coperto dal pixel esistente). Questo mantiene gli URL
    // pubblici senza email in chiaro.
    html = injectClickTracking(html, { kind: kind === "s" ? "s" : "c", sendId: trackId, baseUrl });
  }

  // Link centro preferenze (se il contatto ha un token preferenze).
  const { injectPreferenceLinks } = await import("./preferences.js");
  html = injectPreferenceLinks(html, { baseUrl, token });

  return html;
}

// Invio di prova (admin o agente): stesso builder (snippet/variabili) e
// stessa firma dell'invio reale, ma NIENTE link di disiscrizione/pixel
// reali (non esiste un iscritto/token a cui agganciarli) e NON viene
// registrato in newsletter_sends/newsletter_sequence_sends — non conta
// come invio.
// Anteprima admin (nessun invio): stesso motore snippet/variabili e stessa
// firma della mail reale, senza link di disiscrizione/pixel (nessun
// iscritto/token a cui agganciarli, come in sendTestEmail).
export async function renderPreviewHtml(siteId, rawHtml, signatureHtml) {
  const expanded = await expandSnippets(siteId, rawHtml);
  return expanded + formatSignature(signatureHtml);
}

export async function sendTestEmail(siteId, toEmail, subject, rawHtml, signatureHtml) {
  const expanded = await expandSnippets(siteId, rawHtml);
  const signature = formatSignature(signatureHtml);
  const notice = `
<div style="margin-top:24px;padding:12px;background:#fef3c7;border-radius:6px;font-size:12px;color:#92400e;">
  ${t("email.newsletterTest.notice")}
</div>`;
  // Override per sito (email_templates kind=newsletter_test) se configurato:
  // il body sostituisce la notifica gialla standard; il subject resta quello
  // della campagna/step con prefisso [PROVA].
  const tpl = await getEmailTemplate(siteId, "newsletter_test");
  const finalHtml = tpl?.body_html
    ? expanded + signature + `<div style="margin-top:24px;">${interpolate(tpl.body_html, { siteName: "" })}</div>`
    : expanded + signature + notice;
  return sendSiteEmail(siteId, toEmail, `${t("email.newsletterTest.subjectPrefix")} ${subject}`, finalHtml);
}

// Chiamata dallo scheduler (ogni 60s, vedi services/scheduler.js). Rispetta
// una quota oraria per sito (newsletter_settings.rate_per_hour) invece di
// spedire tutto in un colpo solo.
export async function sendCampaignBatch() {
  let campaigns;
  try {
    campaigns = (await query(
      `SELECT nc.*, s.rate_per_hour, s.signature_html FROM newsletter_campaigns nc
       JOIN newsletter_settings s ON s.site_id = nc.site_id
       WHERE nc.status = 'sending'`
    )).rows;
  } catch (err) {
    logger.error(`Newsletter: query campagne fallita: ${err.message}`);
    return;
  }

  for (const campaign of campaigns) {
    try {
      const baseUrl = await getCanonicalBaseUrl(campaign.site_id);
      const quota = await quotaRemaining(campaign.site_id, campaign.rate_per_hour);
      if (quota <= 0) continue;

      // target_tag NULL (default) = tutti gli iscritti confermati, invariato;
      // valorizzato = solo chi ha quel tag in contacts (CRM-lite, vedi
      // services/contacts.js). LEFT JOIN perché un iscritto può non avere
      // ancora una riga in contacts (mai arrivato da un form).
      //
      // suppress_inactive: se true e inactive_after_sends > 0, esclude iscritti
      // che non hanno aperto nessuno degli ultimi N invii ricevuti (unione
      // newsletter_sends + newsletter_sequence_sends). Se l'iscritto ha ricevuto
      // meno di N invii totali, non viene escluso (storico insufficiente).
      const pending = (await query(
        `SELECT sub.* FROM newsletter_subscribers sub
         LEFT JOIN contacts c ON c.site_id = sub.site_id AND c.email = sub.email
         WHERE sub.site_id = $1 AND sub.status = 'confirmed'
           AND ($4::text IS NULL OR (c.tags IS NOT NULL AND $4 = ANY(c.tags)))
           AND NOT EXISTS (
             SELECT 1 FROM newsletter_sends WHERE campaign_id = $2 AND subscriber_id = sub.id
           )
           AND (NOT $5::boolean OR $6::int = 0
             OR (SELECT COUNT(*) FROM (
                   SELECT 1 FROM newsletter_sends WHERE subscriber_id = sub.id
                   UNION ALL
                   SELECT 1 FROM newsletter_sequence_sends WHERE subscriber_id = sub.id
                 ) total_sends) < $6::int
             OR EXISTS (
               SELECT 1 FROM (
                 SELECT opened_at, ROW_NUMBER() OVER (ORDER BY sent_at DESC) AS rn
                 FROM (
                   SELECT opened_at, sent_at FROM newsletter_sends WHERE subscriber_id = sub.id
                   UNION ALL
                   SELECT opened_at, sent_at FROM newsletter_sequence_sends WHERE subscriber_id = sub.id
                 ) all_sends
               ) ranked
               WHERE ranked.rn <= $6::int AND ranked.opened_at IS NOT NULL
             ))
         ORDER BY sub.id LIMIT $3`,
        [campaign.site_id, campaign.id, quota, campaign.target_tag, campaign.suppress_inactive, campaign.inactive_after_sends]
      )).rows;

      let lastError = null;
      for (const sub of pending) {
        try {
          const html = await buildEmailHtml(
            campaign.site_id, campaign.html_content, campaign.signature_html,
            baseUrl, "c", campaign.id, sub.token
          );
          await sendSiteEmail(campaign.site_id, sub.email, campaign.subject, html);
          await query(
            `INSERT INTO newsletter_sends (campaign_id, subscriber_id) VALUES ($1, $2)
             ON CONFLICT (campaign_id, subscriber_id) DO NOTHING`,
            [campaign.id, sub.id]
          );
          recordEmailConversation(campaign.site_id, sub.email, campaign.subject, html, { campaign_id: campaign.id });
        } catch (err) {
          const bounceKind = classifySmtpError(err);
          if (bounceKind) {
            await recordBounce(campaign.site_id, sub, bounceKind, err.message);
          } else {
            logger.error(`Newsletter: invio fallito campagna #${campaign.id} -> ${sub.email}: ${err.message}`);
            lastError = err.message;
          }
        }
      }
      if (lastError) {
        await query("UPDATE newsletter_campaigns SET last_error = $1, last_error_at = NOW() WHERE id = $2", [lastError, campaign.id]);
      }

      const remaining = (await query(
        `SELECT COUNT(*) AS c FROM newsletter_subscribers sub
         LEFT JOIN contacts ct ON ct.site_id = sub.site_id AND ct.email = sub.email
         WHERE sub.site_id = $1 AND sub.status = 'confirmed'
           AND ($3::text IS NULL OR (ct.tags IS NOT NULL AND $3 = ANY(ct.tags)))
           AND NOT EXISTS (
             SELECT 1 FROM newsletter_sends WHERE campaign_id = $2 AND subscriber_id = sub.id
           )
           AND (NOT $4::boolean OR $5::int = 0
             OR (SELECT COUNT(*) FROM (
                   SELECT 1 FROM newsletter_sends WHERE subscriber_id = sub.id
                   UNION ALL
                   SELECT 1 FROM newsletter_sequence_sends WHERE subscriber_id = sub.id
                 ) total_sends) < $5::int
             OR EXISTS (
               SELECT 1 FROM (
                 SELECT opened_at, ROW_NUMBER() OVER (ORDER BY sent_at DESC) AS rn
                 FROM (
                   SELECT opened_at, sent_at FROM newsletter_sends WHERE subscriber_id = sub.id
                   UNION ALL
                   SELECT opened_at, sent_at FROM newsletter_sequence_sends WHERE subscriber_id = sub.id
                 ) all_sends
               ) ranked
               WHERE ranked.rn <= $5::int AND ranked.opened_at IS NOT NULL
             ))`,
        [campaign.site_id, campaign.id, campaign.target_tag, campaign.suppress_inactive, campaign.inactive_after_sends]
      )).rows[0].c;

      if (parseInt(remaining, 10) === 0) {
        await query("UPDATE newsletter_campaigns SET status = 'sent', sent_at = NOW(), last_error = NULL WHERE id = $1", [campaign.id]);
        logger.info(`Newsletter: campagna #${campaign.id} completata`);
      }
    } catch (err) {
      logger.error(`Newsletter: errore campagna #${campaign.id}: ${err.message}`);
    }
  }
}

// Sequenze evergreen: ogni iscritto confermato riceve gli step in base ai
// giorni trascorsi dalla propria conferma (confirmed_at + delay_days),
// nell'ordine definito (step N richiede che N-1 sia già stato inviato a
// quell'iscritto, anche se la quota oraria ha rallentato gli invii).
export async function sendSequenceSteps() {
  let sequences;
  try {
    sequences = (await query(
      `SELECT sq.id AS sequence_id, sq.site_id, sq.target_tag, s.rate_per_hour, s.signature_html
       FROM newsletter_sequences sq
       JOIN newsletter_settings s ON s.site_id = sq.site_id
       WHERE sq.active = true`
    )).rows;
  } catch (err) {
    logger.error(`Newsletter: query sequenze fallita: ${err.message}`);
    return;
  }

  for (const seq of sequences) {
    try {
      const baseUrl = await getCanonicalBaseUrl(seq.site_id);
      const steps = (await query(
        `SELECT * FROM newsletter_sequence_steps WHERE sequence_id = $1 ORDER BY step_order`,
        [seq.sequence_id]
      )).rows;

      for (const step of steps) {
        let quota = await quotaRemaining(seq.site_id, seq.rate_per_hour);
        if (quota <= 0) break;

        // target_tag NULL (default) = tutti gli iscritti confermati, invariato;
        // valorizzato = solo chi ha quel tag in contacts (vedi sendCampaignBatch).
        //
        // suppress_inactive: se true e inactive_after_sends > 0, esclude iscritti
        // che non hanno aperto nessuno degli ultimi N invii ricevuti (unione
        // newsletter_sends + newsletter_sequence_sends). Se l'iscritto ha ricevuto
        // meno di N invii totali, non viene escluso (storico insufficiente).
        const eligible = (await query(
          `SELECT sub.* FROM newsletter_subscribers sub
           LEFT JOIN contacts ct ON ct.site_id = sub.site_id AND ct.email = sub.email
           WHERE sub.site_id = $1 AND sub.status = 'confirmed' AND sub.confirmed_at IS NOT NULL
             AND sub.confirmed_at + ($2 || ' days')::interval <= NOW()
             AND ($7::text IS NULL OR (ct.tags IS NOT NULL AND $7 = ANY(ct.tags)))
             AND NOT EXISTS (
               SELECT 1 FROM newsletter_sequence_sends WHERE step_id = $3 AND subscriber_id = sub.id
             )
             AND ($4::int = 1 OR EXISTS (
               SELECT 1 FROM newsletter_sequence_sends prev
               JOIN newsletter_sequence_steps ps ON ps.id = prev.step_id
               WHERE ps.sequence_id = $5 AND ps.step_order = $4 - 1 AND prev.subscriber_id = sub.id
             ))
             AND (NOT $8::boolean OR $9::int = 0
               OR (SELECT COUNT(*) FROM (
                     SELECT 1 FROM newsletter_sends WHERE subscriber_id = sub.id
                     UNION ALL
                     SELECT 1 FROM newsletter_sequence_sends WHERE subscriber_id = sub.id
                   ) total_sends) < $9::int
               OR EXISTS (
                 SELECT 1 FROM (
                   SELECT opened_at, ROW_NUMBER() OVER (ORDER BY sent_at DESC) AS rn
                   FROM (
                     SELECT opened_at, sent_at FROM newsletter_sends WHERE subscriber_id = sub.id
                     UNION ALL
                     SELECT opened_at, sent_at FROM newsletter_sequence_sends WHERE subscriber_id = sub.id
                   ) all_sends
                 ) ranked
                 WHERE ranked.rn <= $9::int AND ranked.opened_at IS NOT NULL
               ))
           ORDER BY sub.id LIMIT $6`,
          [seq.site_id, step.delay_days, step.id, step.step_order, seq.sequence_id, quota, seq.target_tag, seq.suppress_inactive, seq.inactive_after_sends]
        )).rows;

        for (const sub of eligible) {
          try {
            const html = await buildEmailHtml(
              seq.site_id, step.html_content, seq.signature_html,
              baseUrl, "s", step.id, sub.token
            );
            await sendSiteEmail(seq.site_id, sub.email, step.subject, html);
            await query(
              `INSERT INTO newsletter_sequence_sends (step_id, subscriber_id) VALUES ($1, $2)
               ON CONFLICT (step_id, subscriber_id) DO NOTHING`,
              [step.id, sub.id]
            );
            recordEmailConversation(seq.site_id, sub.email, step.subject, html, { sequence_id: seq.sequence_id, step_id: step.id });
          } catch (err) {
            const bounceKind = classifySmtpError(err);
            if (bounceKind) {
              await recordBounce(seq.site_id, sub, bounceKind, err.message);
            } else {
              logger.error(`Newsletter: invio step #${step.id} fallito -> ${sub.email}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      logger.error(`Newsletter: errore sequenza #${seq.sequence_id}: ${err.message}`);
    }
  }
}
