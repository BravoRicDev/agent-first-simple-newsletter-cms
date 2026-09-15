import { query } from "../db.js";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";

const STATUS_LABELS = { aperto: "Aperta", in_lavorazione: "In lavorazione", risolto: "Risolta", chiuso: "Chiusa" };

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Notifica via email chi ha aperto una segnalazione a ogni cambio di stato (apertura inclusa),
// includendo sempre la nota sviluppatore se presente in quel momento. Non lancia mai: un invio
// fallito non deve mai bloccare la risposta HTTP della route chiamante.
export async function notifyStatusChange(toEmail, toName, report) {
  if (!toEmail) return;
  const statusLabel = STATUS_LABELS[report.status] || report.status;
  const subject = `Segnalazione #${report.id} — ${statusLabel}`;
  const html = `
    <p>Ciao ${escapeHtml(toName) || ""},</p>
    <p>La tua segnalazione <strong>#${report.id}</strong>${report.categoria ? ` (${escapeHtml(report.categoria)})` : ""} è ora: <strong>${escapeHtml(statusLabel)}</strong>.</p>
    <p><strong>Descrizione originale:</strong><br>${escapeHtml(report.description).replace(/\n/g, "<br>")}</p>
    ${report.note_sviluppatore ? `<p><strong>Nota dello sviluppatore:</strong><br>${escapeHtml(report.note_sviluppatore).replace(/\n/g, "<br>")}</p>` : ""}
    <p style="color:#888;font-size:12px;">Puoi vedere il dettaglio completo nella dashboard, tab Segnalazioni.</p>
  `;
  try {
    await sendEmail(toEmail, subject, html);
  } catch (err) {
    logger.error("Notifica email segnalazione non inviata", { report_id: report.id, to: toEmail, error: err.message });
  }
}

export async function listBugReports({ status, priority, limit = 50, offset = 0 }) {
  let where = " WHERE 1=1";
  const params = [];
  let idx = 1;
  if (status) { where += ` AND br.status = $${idx++}`; params.push(status); }
  if (priority) { where += ` AND br.priority = $${idx++}`; params.push(priority); }
  const countSql = `SELECT COUNT(*) FROM bug_reports br${where}`;
  const filterParamCount = params.length;
  let sql = `SELECT br.*, u.name AS user_name, u.surname AS user_surname, u.email AS user_email
             FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id${where}`;
  sql += ` ORDER BY br.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(parseInt(limit), parseInt(offset));
  const [result, countResult] = await Promise.all([query(sql, params), query(countSql, params.slice(0, filterParamCount))]);
  return { data: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function listMyBugReports(userId, { status, limit = 50, offset = 0 }) {
  let where = " WHERE user_id = $1";
  const params = [userId];
  let idx = 2;
  if (status) { where += ` AND status = $${idx++}`; params.push(status); }
  const countSql = `SELECT COUNT(*) FROM bug_reports${where}`;
  const filterParamCount = params.length;
  let sql = `SELECT * FROM bug_reports${where}`;
  sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(parseInt(limit), parseInt(offset));
  const [result, countResult] = await Promise.all([query(sql, params), query(countSql, params.slice(0, filterParamCount))]);
  return { data: result.rows, total: parseInt(countResult.rows[0].count) };
}

export async function createBugReport(user, data) {
  const result = await query(
    `INSERT INTO bug_reports (user_id, categoria, description, browser_info, steps_to_reproduce, expected_behavior, actual_behavior, mockup_before_html, mockup_after_html) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      user.sub,
      data.categoria,
      data.description,
      data.browser_info,
      data.steps_to_reproduce,
      data.expected_behavior,
      data.actual_behavior,
      data.mockup_before_html,
      data.mockup_after_html,
    ]
  );
  const created = result.rows[0];
  notifyStatusChange(user.email, user.name, created).catch(err =>
    logger.error("Notifica email apertura segnalazione fallita", { report_id: created.id, error: err.message })
  );
  return created;
}

export async function getBugReport(id) {
  const result = await query(
    `SELECT br.*, u.name AS user_name, u.surname AS user_surname, u.email AS user_email
     FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id WHERE br.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

export async function updateBugReport(id, data) {
  const before = (await query(
    `SELECT br.*, u.email AS user_email, u.name AS user_name
     FROM bug_reports br LEFT JOIN users u ON u.id = br.user_id WHERE br.id = $1`,
    [id]
  )).rows[0];
  if (!before) return { notFound: true };

  const fields = [];
  const values = [];
  let idx = 1;
  for (const [key, value] of Object.entries(data)) {
    fields.push(`${key} = $${idx++}`);
    values.push(value);
  }
  if (fields.length === 0) return { noFields: true };
  fields.push("updated_at = NOW()");
  values.push(id);
  const result = await query(
    `UPDATE bug_reports SET ${fields.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  const updated = result.rows[0];

  if (data.status && data.status !== before.status) {
    notifyStatusChange(before.user_email, before.user_name, updated).catch(err =>
      logger.error("Notifica email cambio stato segnalazione fallita", { report_id: updated.id, error: err.message })
    );
  }

  return { updated };
}
