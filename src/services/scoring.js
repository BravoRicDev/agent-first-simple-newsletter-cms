import { query } from "../db.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Lead scoring — punteggio accumulato sul contatto.
//
// applyScoring(siteId, email, eventType, payload):
//   1. trova le regole (scoring_rules) che matchano l'evento → somma punti
//   2. aggiorna contacts.score + score_updated_at
//   3. verifica le soglie (scoring_thresholds): alla prima soglia superata
//      esegue l'azione configurata (set_stage/add_tag/notify_email)
//
// Il decadimento (score * 0.95 per giorno senza eventi) è applicato dal
// tick scheduler (applyScoringDecay), NON qui — qui ogni evento riporta
// score_updated_at a NOW() e annulla il decadimento accumulato.
// ─────────────────────────────────────────────────────────────────────────

export async function applyScoring(siteId, email, eventType, payload = {}, { depth = 0 } = {}) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized || !siteId) return;

  const rules = (await query(
    `SELECT id, event_type, event_filter, points FROM scoring_rules
     WHERE site_id = $1 AND enabled = true`,
    [siteId]
  )).rows;
  if (rules.length === 0) return;

  let totalPoints = 0;
  for (const rule of rules) {
    if (!matchEvent(rule, eventType, payload)) continue;
    totalPoints += Number(rule.points) || 0;
  }
  if (totalPoints === 0) return;

  const updated = (await query(
    `INSERT INTO contacts (site_id, email, score, score_updated_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (site_id, email)
     DO UPDATE SET score = contacts.score + $3, score_updated_at = NOW(), updated_at = NOW()
     RETURNING score`,
    [siteId, normalized, totalPoints]
  )).rows[0];

  const newScore = parseInt(updated.score, 10);
  await checkThresholds(siteId, normalized, newScore, { depth });
}

function matchEvent(rule, eventType, payload) {
  if (rule.event_type !== eventType) return false;
  const filter = rule.event_filter || {};
  // Filtri opzionali: form_slug, quiz_slug, min_score (punteggio quiz),
  // tag, stage, status.
  if (filter.form_slug && payload.form_slug !== filter.form_slug) return false;
  if (filter.quiz_slug && payload.quiz_slug !== filter.quiz_slug) return false;
  if (filter.min_score !== undefined && filter.min_score !== null && Number(payload.points || 0) < Number(filter.min_score)) return false;
  if (filter.tag && payload.tag !== filter.tag) return false;
  if (filter.stage && payload.to_stage !== filter.stage) return false;
  if (filter.status && payload.status !== filter.status) return false;
  return true;
}

async function checkThresholds(siteId, email, score, { depth = 0 } = {}) {
  if (depth > 3) return;
  const thresholds = (await query(
    `SELECT id, min_score, action_type, action_config FROM scoring_thresholds
     WHERE site_id = $1 AND enabled = true ORDER BY min_score DESC`,
    [siteId]
  )).rows;

  for (const th of thresholds) {
    if (score < Number(th.min_score)) continue;
    try {
      await executeThresholdAction(siteId, email, th, { depth });
    } catch (err) {
      logger.error(`Scoring threshold ${th.id} fallita (site=${siteId}, ${email}): ${err.message}`);
    }
  }
}

async function executeThresholdAction(siteId, email, th, { depth } = {}) {
  const cfg = th.action_config || {};
  switch (th.action_type) {
    case "set_stage": {
      const stage = String(cfg.stage || "");
      if (!stage) return;
      const { setContactStage } = await import("./contacts.js");
      await setContactStage(siteId, email, stage);
      break;
    }
    case "add_tag": {
      const tag = String(cfg.tag || "");
      if (!tag) return;
      const { addContactTag } = await import("./contacts.js");
      await addContactTag(siteId, email, tag);
      break;
    }
    case "notify_email": {
      const to = String(cfg.to || "").trim();
      const subject = String(cfg.subject || "Lead score raggiunto").slice(0, 500);
      const body = String(cfg.body || `${email} ha raggiunto il punteggio ${th.min_score} sul sito #${siteId}`).slice(0, 5000);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;
      const { sendEmail } = await import("./email.js");
      await sendEmail(to, subject, body.replace(/\n/g, "<br>"));
      break;
    }
    default:
      break;
  }
}

// Decadimento giornaliero: score * 0.95 per ogni giorno senza eventi.
// Chiamato dal tick scheduler una volta al giorno per contatto.
export async function applyScoringDecay(siteId = null) {
  const params = [];
  let where = "c.score != 0 AND c.score_updated_at IS NOT NULL";
  if (siteId) {
    params.push(siteId);
    where += ` AND c.site_id = $${params.length}`;
  }
  // giorni senza eventi = floor((NOW() - score_updated_at) / 1 day)
  const rows = (await query(
    `SELECT c.id, c.score, c.score_updated_at
     FROM contacts c
     WHERE ${where} AND c.score_updated_at < NOW() - INTERVAL '1 day'
     LIMIT 5000`,
    params
  )).rows;

  let decayed = 0;
  for (const row of rows) {
    const days = Math.floor((Date.now() - new Date(row.score_updated_at).getTime()) / (24 * 3600 * 1000));
    if (days <= 0) continue;
    // Calcolo diretto: round(score * 0.95^days). Un loop giorno-per-giorno
    // con Math.round resta fermo su score piccoli (es. 10*0.95=9.5 → round
    // =10 → loop infinito senza cambiare nulla).
    const score = Math.round(Number(row.score) * Math.pow(0.95, days));
    if (score === Number(row.score)) continue;
    await query(
      `UPDATE contacts SET score = $1, score_updated_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [score, row.id]
    );
    decayed++;
  }
  return { decayed };
}

// Sanitizzazione regole/azioni per le route.
export function sanitizeScoringRule(raw) {
  if (!raw || typeof raw !== "object") return null;
  const eventTypes = new Set([
    "form_submitted", "quiz_completed", "email_opened", "email_clicked",
    "call_booked", "call_status_changed", "stage_changed", "tag_added",
    "contact_created", "manual",
  ]);
  const eventType = String(raw.event_type || "");
  if (!eventTypes.has(eventType)) return null;
  const points = Number.isFinite(Number(raw.points)) ? Number(raw.points) : 0;
  const filter = raw.event_filter && typeof raw.event_filter === "object" ? raw.event_filter : {};
  return {
    name: String(raw.name || "").trim().slice(0, 255),
    event_type: eventType,
    event_filter: filter,
    points,
    enabled: raw.enabled !== false,
  };
}

export function sanitizeScoringThreshold(raw) {
  if (!raw || typeof raw !== "object") return null;
  const minScore = Number.isFinite(Number(raw.min_score)) ? Number(raw.min_score) : null;
  if (minScore === null) return null;
  const actionTypes = new Set(["set_stage", "add_tag", "notify_email"]);
  const actionType = actionTypes.has(raw.action_type) ? raw.action_type : "set_stage";
  return {
    min_score: minScore,
    action_type: actionType,
    action_config: raw.action_config && typeof raw.action_config === "object" ? raw.action_config : {},
    enabled: raw.enabled !== false,
  };
}
