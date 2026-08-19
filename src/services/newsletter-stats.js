import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Statistiche email (open/click) per campagna e sequenza — alimentate da
// newsletter_send_events (click con URL) + opened_at/open_count esistenti.
// ─────────────────────────────────────────────────────────────────────────

export async function getEmailStatsCampaign(siteId, campaignId) {
  const campaign = (await query(
    "SELECT id, subject, status, sent_at FROM newsletter_campaigns WHERE id = $1 AND site_id = $2",
    [campaignId, siteId]
  )).rows[0];
  if (!campaign) return { error: "Campagna non trovata" };

  const sends = (await query(
    `SELECT COUNT(*) AS total,
            COUNT(opened_at) AS opened,
            COALESCE(SUM(open_count), 0) AS open_events
     FROM newsletter_sends WHERE campaign_id = $1`,
    [campaignId]
  )).rows[0];

  const events = (await query(
    `SELECT event_type, url, COUNT(*) AS c
     FROM newsletter_send_events
     WHERE send_id = $1 AND kind = 'campaign'
     GROUP BY event_type, url ORDER BY c DESC LIMIT 20`,
    [campaignId]
  )).rows;

  const clicks = (await query(
    `SELECT COUNT(DISTINCT email) AS clickers, COUNT(*) AS click_events
     FROM newsletter_send_events WHERE send_id = $1 AND kind = 'campaign' AND event_type = 'click'`,
    [campaignId]
  )).rows[0];

  const total = parseInt(sends?.total || 0, 10);
  const opened = parseInt(sends?.opened || 0, 10);
  const clickers = parseInt(clicks?.clickers || 0, 10);

  return {
    campaign,
    total,
    opened,
    open_rate: total > 0 ? +(opened / total).toFixed(4) : 0,
    clickers,
    click_rate: total > 0 ? +(clickers / total).toFixed(4) : 0,
    ctor: opened > 0 ? +(clickers / opened).toFixed(4) : 0,
    events,
  };
}

export async function getEmailStatsSequence(siteId, sequenceId) {
  const sequence = (await query(
    "SELECT id, name, active FROM newsletter_sequences WHERE id = $1 AND site_id = $2",
    [sequenceId, siteId]
  )).rows[0];
  if (!sequence) return { error: "Sequenza non trovata" };

  const steps = (await query(
    `SELECT st.id, st.step_order, st.delay_days, st.subject,
            COUNT(se.id) AS sent, COUNT(se.opened_at) AS opened
     FROM newsletter_sequence_steps st
     LEFT JOIN newsletter_sequence_sends se ON se.step_id = st.id
     WHERE st.sequence_id = $1
     GROUP BY st.id ORDER BY st.step_order`,
    [sequenceId]
  )).rows;

  const events = (await query(
    `SELECT event_type, url, COUNT(*) AS c
     FROM newsletter_send_events
     WHERE kind = 'sequence' AND send_id IN (
       SELECT id FROM newsletter_sequence_sends WHERE step_id IN (
         SELECT id FROM newsletter_sequence_steps WHERE sequence_id = $1
       )
     )
     GROUP BY event_type, url ORDER BY c DESC LIMIT 20`,
    [sequenceId]
  )).rows;

  return { sequence, steps, events };
}
