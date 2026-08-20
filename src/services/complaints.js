import { query } from "../db.js";

export function calculateComplaintRate(complaintCount, sendCount) {
  if (sendCount === 0) return null;
  return complaintCount / sendCount;
}

export function suggestComplaintStatus(rate) {
  if (rate === null) return "ok";
  const threshold = 0.001;
  return rate > threshold ? "warn" : "ok";
}

export async function getComplaintMetrics(siteId) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const complaintResult = await query(
    "SELECT COUNT(*) AS c FROM newsletter_complaints WHERE site_id = $1 AND created_at >= $2",
    [siteId, thirtyDaysAgo]
  );
  const complaintCount = parseInt(complaintResult.rows[0]?.c || 0, 10);

  const sendResult = await query(
    `SELECT COUNT(*) AS c FROM (
       SELECT ns.id FROM newsletter_sends ns
       JOIN newsletter_campaigns nc ON nc.id = ns.campaign_id
       WHERE nc.site_id = $1 AND ns.sent_at >= $2
       UNION ALL
       SELECT nss.id FROM newsletter_sequence_sends nss
       JOIN newsletter_sequence_steps st ON st.id = nss.step_id
       JOIN newsletter_sequences sq ON sq.id = st.sequence_id
       WHERE sq.site_id = $1 AND nss.sent_at >= $2
     ) t`,
    [siteId, thirtyDaysAgo]
  );

  let sendCount = 0;
  if (sendResult.rows && sendResult.rows.length > 0) {
    sendCount = sendResult.rows.reduce((sum, row) => sum + parseInt(row.c || 0, 10), 0);
  }

  const rate = calculateComplaintRate(complaintCount, sendCount);
  const status = suggestComplaintStatus(rate);

  return {
    complaintCount30d: complaintCount,
    sends30d: sendCount,
    rate,
    status,
  };
}
