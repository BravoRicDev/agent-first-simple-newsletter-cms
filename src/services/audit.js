import { query } from "../db.js";
import { logger } from "./logger.js";

export async function auditLog({ userId, siteId, entityType, entityId, action, oldData, newData, ipAddress }) {
  try {
    await query(
      `INSERT INTO audit_log (user_id, site_id, entity_type, entity_id, action, old_data, new_data, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId ?? null,
        siteId ?? null,
        entityType,
        entityId ?? null,
        action,
        oldData ? JSON.stringify(oldData) : null,
        newData ? JSON.stringify(newData) : null,
        ipAddress ?? null,
      ]
    );
  } catch (err) {
    logger.error("auditLog failed", { error: err.message });
  }
}
