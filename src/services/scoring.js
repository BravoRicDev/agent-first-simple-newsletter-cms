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
     WHERE site_id = $1 AND enabled = true AND trigger_on = 'above' ORDER BY min_score DESC`,
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

// Configurazione decay per sito (settings globali per-tenant, stesso
// pattern riusato di tracking.js/site-seo.js — nessuna tabella dedicata).
// scoring_decay_rate: fattore di moltiplicazione per periodo (0<rate<1).
// scoring_decay_days: lunghezza del periodo in giorni senza eventi.
async function getScoringDecayConfig(siteId) {
  if (!siteId) return { rate: 0.95, days: 1 };
  const rows = (await query(
    "SELECT key, value FROM settings WHERE site_id = $1 AND key = ANY($2)",
    [siteId, ["scoring_decay_rate", "scoring_decay_days"]]
  )).rows;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const rate = Number(map.scoring_decay_rate);
  const days = Number(map.scoring_decay_days);
  return {
    rate: Number.isFinite(rate) && rate > 0 && rate < 1 ? rate : 0.95,
    days: Number.isFinite(days) && days > 0 ? days : 1,
  };
}

// Soglie 'below': azione scattata quando il decadimento fa scendere il
// punteggio sotto min_score (es. rimuovi tag "hot", notifica raffreddamento).
// Scatta solo sull'attraversamento (oldScore >= min > newScore), non ad ogni
// tick in cui il punteggio resta sotto soglia.
async function checkDecayThresholds(siteId, email, oldScore, newScore, { depth = 0 } = {}) {
  if (depth > 3) return;
  const thresholds = (await query(
    `SELECT id, min_score, action_type, action_config FROM scoring_thresholds
     WHERE site_id = $1 AND enabled = true AND trigger_on = 'below' ORDER BY min_score ASC`,
    [siteId]
  )).rows;
  for (const th of thresholds) {
    const min = Number(th.min_score);
    if (!(oldScore >= min && newScore < min)) continue;
    try {
      await executeThresholdAction(siteId, email, th, { depth });
    } catch (err) {
      logger.error(`Scoring decay threshold ${th.id} fallita (site=${siteId}, ${email}): ${err.message}`);
    }
  }
}

// Decadimento periodico: score * rate^periodi senza eventi (default
// rate=0.95, periodo=1 giorno; configurabile per sito via settings
// scoring_decay_rate/scoring_decay_days). Chiamato dal tick scheduler.
async function applyScoreDecayForSite(siteId) {
  const { rate, days: decayDays } = await getScoringDecayConfig(siteId);
  const rows = (await query(
    `SELECT id, email, score, score_updated_at
     FROM contacts
     WHERE site_id = $1 AND score != 0 AND score_updated_at IS NOT NULL
       AND score_updated_at < NOW() - ($2 || ' days')::interval
     LIMIT 5000`,
    [siteId, String(decayDays)]
  )).rows;

  let decayed = 0;
  for (const row of rows) {
    const elapsedDays = (Date.now() - new Date(row.score_updated_at).getTime()) / (24 * 3600 * 1000);
    const periods = Math.floor(elapsedDays / decayDays);
    if (periods <= 0) continue;
    const oldScore = Number(row.score);
    // Calcolo diretto: round(score * rate^periodi). Un loop periodo-per-
    // periodo con Math.round resta fermo su score piccoli (es. 10*0.95=9.5
    // → round=10 → loop infinito senza cambiare nulla).
    const newScore = Math.round(oldScore * Math.pow(rate, periods));
    if (newScore === oldScore) continue;
    await query(
      `UPDATE contacts SET score = $1, score_updated_at = NOW(), updated_at = NOW() WHERE id = $2`,
      [newScore, row.id]
    );
    decayed++;
    await checkDecayThresholds(siteId, row.email, oldScore, newScore, { depth: 1 });
  }
  return { decayed };
}

// siteId=null → decadimento su tutti i siti con contatti "scorati".
export async function applyScoreDecay(siteId = null) {
  if (siteId) return applyScoreDecayForSite(siteId);
  const sites = (await query(
    "SELECT DISTINCT site_id FROM contacts WHERE score != 0"
  )).rows;
  let decayed = 0;
  for (const row of sites) {
    const r = await applyScoreDecayForSite(row.site_id);
    decayed += r.decayed;
  }
  return { decayed };
}

// Alias storico: nome usato dallo scheduler interno e dai test esistenti.
export const applyScoringDecay = applyScoreDecay;

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
    trigger_on: raw.trigger_on === "below" ? "below" : "above",
  };
}
