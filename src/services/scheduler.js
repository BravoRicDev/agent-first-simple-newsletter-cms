import { query, getClient } from "../db.js";
import { logger } from "./logger.js";
import { auditLog } from "./audit.js";
import { sendEmail } from "./email.js";
import { renderEmail } from "./email-templates.js";
import { getCanonicalBaseUrl } from "./urls.js";
import { postScheduled } from "./social-poster.js";
import { sendCampaignBatch, sendSequenceSteps } from "./newsletter.js";
import { runScheduledBackup } from "./backup.js";
import { sendCallReminders } from "./calls.js";
import { cleanupExpiredAudio } from "./call-recordings.js";
import { exportPublishedPages } from "./static-export.js";
import { translate } from "../middleware/i18n.js";
import config from "../config.js";

const t = (key, vars) => translate(config.defaultLang, key, vars);

let schedulerInterval = null;
let exportTimer = 0;
let tickRunning = false;

// Chiave arbitraria fissa per pg_advisory_lock: il lock è a livello di
// connessione, quindi usiamo una connessione dedicata tenuta aperta per
// tutto il tick (acquisita in schedulerTick, rilasciata in finally).
const TICK_LOCK_KEY = 72700123;

async function publishDuePages() {
  try {
    const result = await query(
      `UPDATE pages
       SET published = true, updated_at = NOW(), publish_at = NULL
       WHERE publish_at IS NOT NULL
         AND publish_at <= NOW()
         AND published = false
       RETURNING id, site_id, url_path, title`
    );

    for (const page of result.rows) {
      logger.info(`Scheduled publish: ${page.url_path} (id=${page.id})`);
      await auditLog({
        userId: null,
        siteId: page.site_id,
        entityType: "page",
        entityId: page.id,
        action: "publish",
        newData: { url_path: page.url_path, source: "scheduler" },
        ipAddress: null,
      });
    }

    // Un solo export per sito, non uno per pagina: N pagine scadute nello
    // stesso tick lanciavano N export completi concorrenti dello stesso sito.
    if (result.rowCount > 0) {
      const siteIds = [...new Set(result.rows.map((r) => r.site_id))];
      for (const siteId of siteIds) {
        try {
          await exportPublishedPages({ siteId });
        } catch (err) {
          logger.error(`Scheduler export fallito per site ${siteId}: ${err.message}`);
        }
      }
      logger.info(`Scheduler: pubblicate ${result.rowCount} pagine pianificate (${siteIds.length} siti)`);
    }
  } catch (err) {
    logger.error("Scheduler error", { error: err.message });
  }
}

async function periodicStaticExport() {
  exportTimer++;
  if (exportTimer % 5 !== 0) return; // Ogni 5 minuti
  try {
    const { fullExport } = await import("./static-export.js");
    await fullExport();
    logger.info("Periodic static export completed");
  } catch (err) {
    logger.error("Periodic static export failed", { error: err.message });
  }
}

async function sendReviewReminders() {
  try {
    const due = await query(
      `SELECT p.id, p.url_path, p.title, p.site_id, u.email
       FROM pages p
       JOIN users u ON u.site_id = p.site_id
       WHERE p.review_at <= NOW() AND p.reminder_sent = false AND u.role IN ('admin', 'superadmin') AND u.status = 'active'`
    );
    for (const page of due.rows) {
      try {
        const baseUrl = await getCanonicalBaseUrl(page.site_id);
        const url = `${baseUrl}/admin/pages/${page.id}/edit`;
        // Override per sito (email_templates kind=review_reminder) se configurato.
        const { subject, html } = await renderEmail(page.site_id, "review_reminder", {
          vars: { title: page.title, url, urlPath: page.url_path },
          defaultSubject: "email.reviewReminder.subject",
          defaultBody: t("email.reviewReminder.body", { url, title: page.title, urlPath: page.url_path }),
        });
        await sendEmail(page.email, subject, html);
        await query("UPDATE pages SET reminder_sent = true WHERE id = $1", [page.id]);
        logger.info(`Review reminder inviato per pagina #${page.id} (${page.url_path})`);
      } catch (err) {
        logger.error(`Review reminder fallito per pagina #${page.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error("Review reminder error", { error: err.message });
  }
}

async function schedulerTick() {
  if (tickRunning) {
    logger.warn("Scheduler: tick precedente ancora in corso, salto questo giro");
    return;
  }
  tickRunning = true;
  // Lock anti-sovrapposizione anche tra più istanze del CMS sullo stesso DB.
  // pg_advisory_lock è legato alla connessione: teniamo una connessione
  // dedicata per tutto il tick e la rilasciamo in finally.
  let lockClient = null;
  try {
    lockClient = await getClient();
    const lockRes = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [TICK_LOCK_KEY]
    );
    if (!lockRes.rows[0].locked) {
      logger.warn("Scheduler: lock non acquisito (altra istanza in corso), salto questo giro");
      lockClient.release();
      lockClient = null;
      return;
    }
    await publishDuePages();
    await postScheduled();
    await sendReviewReminders();
    await sendCampaignBatch();
    await sendSequenceSteps();
    await sendCallReminders();
    await runScheduledBackup();
    await periodicStaticExport();
    // CRM: retention audio registrazioni chiamate (M7) — 1 volta su ~60 tick
    // (≈ ogni ora) per non gravare sul tick; disabilitata se audioRetentionDays=0.
    try {
      if (config.audioRetentionDays > 0 && exportTimer % 60 === 0) {
        const removed = await cleanupExpiredAudio();
        if (removed > 0) logger.info(`Call-recordings: retention rimossi ${removed} audio scaduti`);
      }
    } catch (err) {
      logger.error(`Call-recordings retention tick fallito: ${err.message}`);
    }
    // CRM: workflow differiti (wait_days), decay scoring, funnel snapshot.
    try {
      const { processDelayedActions } = await import("./workflows.js");
      const r = await processDelayedActions();
      if (r.executed > 0) logger.info(`Workflow: ${r.executed} azioni differite eseguite`);
    } catch (err) {
      logger.error(`Workflow delayed tick fallito: ${err.message}`);
    }
    try {
      const { applyScoringDecay } = await import("./scoring.js");
      const r = await applyScoringDecay();
      if (r.decayed > 0) logger.info(`Scoring: ${r.decayed} punteggi con decadimento applicato`);
    } catch (err) {
      logger.error(`Scoring decay tick fallito: ${err.message}`);
    }
    try {
      // Funnel snapshot: 1 volta su ~20 tick (≈ ogni 20 minuti) per il
      // giorno corrente; il calcolo è leggero (una query per sito).
      if (exportTimer % 20 === 0) {
        const { buildFunnelSnapshotsForAllSites } = await import("./tasks.js");
        await buildFunnelSnapshotsForAllSites();
      }
    } catch (err) {
      logger.error(`Funnel snapshot tick fallito: ${err.message}`);
    }
    try {
      // Recurring tasks + follow-up rules: idempotent operations.
      const { generateDueRecurringTasks, checkFollowups } = await import("./recurring.js");
      const r1 = await generateDueRecurringTasks();
      if (r1.generated > 0) logger.info(`Recurring: ${r1.generated} task generate`);
      const r2 = await checkFollowups();
      if (r2.executed > 0) logger.info(`Follow-up: ${r2.executed} azioni eseguite`);
    } catch (err) {
      logger.error(`Recurring/followup tick fallito: ${err.message}`);
    }
    try {
      // Periodic reports: send due reports (weekly/monthly schedules).
      const { runDueReports } = await import("./reports.js");
      const rr = await runDueReports();
      if (rr.sent > 0) logger.info(`Report: ${rr.sent} inviati, ${rr.failed} falliti`);
    } catch (err) {
      logger.error(`Report tick fallito: ${err.message}`);
    }
  } finally {
    if (lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [TICK_LOCK_KEY]);
      } catch (err) {
        logger.error(`Scheduler: unlock fallito (la connessione verrà chiusa dal pool): ${err.message}`);
      }
      lockClient.release();
    }
    tickRunning = false;
  }
}

export function startScheduler() {
  if (schedulerInterval) return;
  schedulerTick().catch((err) => {
    logger.error("Scheduler tick iniziale fallito", { error: err.message });
  });
  schedulerInterval = setInterval(() => {
    schedulerTick().catch((err) => {
      logger.error("Scheduler tick fallito", { error: err.message });
    });
  }, 60 * 1000);
  logger.info("Scheduler avviato (controllo ogni 60s)");
}

export function stopScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }
}
