import { query, getClient } from "../db.js";
import { getBlogSetting } from "./blog-settings.js";
import { hasPermission } from "./rbac.js";
import { auditLog } from "./audit.js";
import { afterContentChange } from "./site-sync.js";
import { sendEmail } from "./email.js";
import { translate } from "../middleware/i18n.js";
import { logger } from "./logger.js";
import config from "../config.js";

export const STATUSES = ["draft", "in_review", "approved", "rejected", "published"];
const TRANSITIONS = {
  submit:    { from: ["draft", "rejected"], to: "in_review", need: "edit" },
  withdraw:  { from: ["in_review", "approved"], to: "draft", need: "edit" },
  approve:   { from: ["in_review"], to: "approved", need: "review" },
  reject:    { from: ["in_review"], to: "rejected", need: "review", commentRequired: true },
  publish:   { from: ["approved"], to: "published", need: "publish" },
  unpublish: { from: ["published"], to: "draft", need: "publish" },
  reopen:    { from: ["rejected"], to: "draft", need: "edit" },
};
export const ACTIONS = Object.keys(TRANSITIONS);

function err(code, extra = {}) { const e = new Error(code); e.code = code; Object.assign(e, extra); return e; }

export async function isWorkflowEnabled(siteId) { return (await getBlogSetting(siteId, "editorial_workflow_enabled")) === "1"; }
export function effectiveStatus(page) { return page.editorial_status || (page.published ? "published" : "draft"); }

export async function canPublish(user, siteId) {
  if (!user) return false;
  if (user.role === "superadmin" || user.role === "admin") return true;
  return hasPermission({ ...user, id: user.id ?? user.sub }, siteId, "pages", "publish");
}
export async function canReview(user, siteId) {
  if (await canPublish(user, siteId)) return true;
  return hasPermission({ ...user, id: user.id ?? user.sub }, siteId, "pages", "approve");
}
async function allowed(need, user, siteId) {
  if (need === "edit") return true; // chi arriva qui ha gia' passato authorize("pages","update") / il controllo sito
  return need === "review" ? canReview(user, siteId) : canPublish(user, siteId);
}

export async function allowedActions(page, user, siteId) {
  const cur = effectiveStatus(page);
  const out = [];
  for (const [name, def] of Object.entries(TRANSITIONS)) {
    if (def.from.includes(cur) && await allowed(def.need, user, siteId)) out.push(name);
  }
  return out;
}

export async function transition(siteId, pageId, action, user, { comment = "", ip = null } = {}) {
  const def = TRANSITIONS[action];
  if (!def) throw err("INVALID_ACTION");
  if (!(await isWorkflowEnabled(siteId))) throw err("WORKFLOW_DISABLED");
  if (!(await allowed(def.need, user, siteId))) throw err("FORBIDDEN_ACTION");
  const text = String(comment || "").trim().slice(0, 2000);
  if (def.commentRequired && !text) throw err("COMMENT_REQUIRED");
  const actorId = user.id ?? user.sub ?? null;
  const client = await getClient();
  let page, from;
  try {
    await client.query("BEGIN");
    page = (await client.query("SELECT * FROM pages WHERE id = $1 AND site_id = $2 FOR UPDATE", [pageId, siteId])).rows[0];
    if (!page) throw err("PAGE_NOT_FOUND");
    from = effectiveStatus(page);
    if (!def.from.includes(from)) throw err("INVALID_TRANSITION", { from, action });
    if (action === "publish") {
      await client.query(
        `UPDATE pages SET published = true, editorial_status = 'published', editorial_updated_at = NOW(), updated_at = NOW(), publish_at = NULL,
           published_at = CASE WHEN post_type = 'article' THEN COALESCE(published_at, NOW()) ELSE published_at END,
           unpublish_at = CASE WHEN unpublish_at IS NOT NULL AND unpublish_at <= NOW() THEN NULL ELSE unpublish_at END
         WHERE id = $1`, [pageId]);
    } else if (action === "unpublish") {
      await client.query("UPDATE pages SET published = false, editorial_status = 'draft', editorial_updated_at = NOW(), updated_at = NOW() WHERE id = $1", [pageId]);
    } else {
      await client.query("UPDATE pages SET editorial_status = $2, editorial_updated_at = NOW() WHERE id = $1", [pageId, def.to]);
    }
    await client.query(
      `INSERT INTO page_reviews (page_id, site_id, from_status, to_status, actor_user_id, actor_label, comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [pageId, siteId, from, def.to, actorId, String(user.email || user.name || `user:${actorId}`).slice(0, 255), text]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
  await auditLog({ userId: actorId, siteId, entityType: "page", entityId: pageId, action: `editorial_${action}`,
    oldData: { status: from }, newData: { status: def.to, comment: text || undefined }, ipAddress: ip });
  if (action === "publish" || action === "unpublish") {
    afterContentChange(siteId, { articleChanged: page.post_type === "article", deleteStaticPaths: action === "unpublish" ? [page.url_path] : [], awaitExport: false }).catch(() => {});
  }
  notify(siteId, pageId, action, user, text).catch((e) => logger.error(`editorial notify: ${e.message}`));
  const fresh = (await query("SELECT * FROM pages WHERE id = $1", [pageId])).rows[0];
  return { page: fresh, from, to: def.to };
}

async function notify(siteId, pageId, action, actor, comment) {
  if (!config.smtpHost) return;
  if (!["submit", "approve", "reject"].includes(action)) return;
  const page = (await query("SELECT id, title, url_path, author_id FROM pages WHERE id = $1", [pageId])).rows[0];
  if (!page) return;
  let emails = [];
  if (action === "submit") {
    emails = (await query("SELECT email FROM users WHERE status = 'active' AND role IN ('admin','superadmin') AND (site_id = $1 OR role = 'superadmin')", [siteId])).rows.map((r) => r.email);
  } else {
    const author = page.author_id ? (await query("SELECT email FROM users WHERE id = $1 AND status = 'active'", [page.author_id])).rows[0] : null;
    const submitter = author ? null : (await query(
      "SELECT u.email FROM page_reviews r JOIN users u ON u.id = r.actor_user_id WHERE r.page_id = $1 AND r.to_status = 'in_review' ORDER BY r.created_at DESC LIMIT 1", [pageId])).rows[0];
    emails = [author?.email || submitter?.email].filter(Boolean);
  }
  emails = [...new Set(emails)].filter((e) => e && e !== actor.email);
  const E = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");   // sendEmail invia HTML: i testi utente vanno escapati
  const vars = { title: E(page.title || page.url_path), url: E(`${config.magicLinkBaseUrl}/admin/pages/${page.id}/edit`), comment: E(comment || ""), actor: E(actor.email || "") };
  const subject = translate(config.defaultLang, `email.editorial.${action}.subject`, vars);
  const body = translate(config.defaultLang, `email.editorial.${action}.body`, vars);
  for (const to of emails) { try { await sendEmail(to, subject, body); } catch (e) { logger.error(`editorial email to ${to}: ${e.message}`); } }
}

export async function listQueue(siteId, { status = "in_review", limit = 50, offset = 0 } = {}) {
  const st = STATUSES.includes(status) ? status : "in_review";
  return (await query(
    `SELECT p.id, p.url_path, p.title, p.post_type, p.published, p.editorial_status, p.editorial_updated_at, p.updated_at,
            (SELECT r.comment FROM page_reviews r WHERE r.page_id = p.id ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS last_comment
     FROM pages p WHERE p.site_id = $1 AND p.editorial_status = $2 AND p.managed_by IS NULL
     ORDER BY p.editorial_updated_at DESC NULLS LAST, p.id DESC LIMIT $3 OFFSET $4`,
    [siteId, st, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)])).rows;
}

export async function listReviews(siteId, pageId, { limit = 50 } = {}) {
  return (await query(
    `SELECT id, from_status, to_status, actor_user_id, actor_label, comment, created_at FROM page_reviews
     WHERE site_id = $1 AND page_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3`,
    [siteId, pageId, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)])).rows;
}

export function mapEditorialError(e, t) {
  const m = {
    INVALID_ACTION: [400, "invalid_action"], WORKFLOW_DISABLED: [409, "workflow_disabled"], FORBIDDEN_ACTION: [403, "editorial_forbidden"],
    COMMENT_REQUIRED: [400, "comment_required"], PAGE_NOT_FOUND: [404, "page_not_found"], INVALID_TRANSITION: [409, "invalid_transition"],
  }[e?.code];
  if (!m) return null;
  return { status: m[0], body: { error: m[1], code: m[1], message: t(`api.editorial.${m[1]}`), ...(e.from ? { from: e.from, action: e.action } : {}) } };
}
