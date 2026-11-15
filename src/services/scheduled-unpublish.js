import { query } from "../db.js";
import { logger } from "./logger.js";
import { auditLog } from "./audit.js";
import { afterContentChange } from "./site-sync.js";

export async function runUnpublishDue() {
  try {
    const res = await query(
      `WITH due AS (
         SELECT id, unpublish_at AS old_unpublish_at FROM pages
         WHERE unpublish_at IS NOT NULL AND unpublish_at <= NOW() AND published = true
         FOR UPDATE SKIP LOCKED
       )
       UPDATE pages p
          SET published = false, unpublish_at = NULL, updated_at = NOW(),
              editorial_status = CASE WHEN p.editorial_status = 'published' THEN 'draft' ELSE p.editorial_status END
         FROM due WHERE p.id = due.id
       RETURNING p.id, p.site_id, p.url_path, p.post_type, due.old_unpublish_at`
    );
    const bySite = new Map();
    for (const row of res.rows) {
      logger.info(`Scheduled unpublish: ${row.url_path} (id=${row.id})`);
      await auditLog({ userId: null, siteId: row.site_id, entityType: "page", entityId: row.id, action: "unpublish",
        newData: { url_path: row.url_path, source: "scheduler", unpublish_at: row.old_unpublish_at }, ipAddress: null });
      if (!bySite.has(row.site_id)) bySite.set(row.site_id, []);
      bySite.get(row.site_id).push(row);
    }
    for (const [siteId, rows] of bySite) {
      await afterContentChange(siteId, { articleChanged: rows.some((r) => r.post_type === "article"), deleteStaticPaths: rows.map((r) => r.url_path) });
    }
    return { unpublished: res.rowCount, sites: bySite.size };
  } catch (err) {
    logger.error("Scheduler unpublish error", { error: err.message });
    return { unpublished: 0, error: err.message };
  }
}
