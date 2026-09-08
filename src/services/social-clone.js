import { query } from "../db.js";
import { ensureExternalId, findByExternalId } from "./external-ids.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Social clone API service: gestione account e post per clone API parity.
// ─────────────────────────────────────────────────────────────────────────

export async function createSocialAccount(siteId, { platform, accountName }) {
  const result = await query(
    `INSERT INTO social_accounts (site_id, platform, account_name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'disconnected', NOW(), NOW())
     RETURNING id, external_id, site_id, platform, account_name, status, config, created_at, updated_at`,
    [siteId, platform, accountName || null]
  );
  return result.rows[0];
}

export async function listSocialAccounts(siteId, limit = 100, offset = 0) {
  const result = await query(
    `SELECT id, external_id, site_id, platform, account_name, status, config, created_at, updated_at
     FROM social_accounts
     WHERE site_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [siteId, limit, offset]
  );
  return result.rows;
}

export async function getSocialAccountCount(siteId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM social_accounts WHERE site_id = $1`,
    [siteId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getSocialAccountByExternalId(externalId) {
  return findByExternalId("social_accounts", externalId);
}

export async function deleteSocialAccount(accountId) {
  await query(`DELETE FROM social_accounts WHERE id = $1`, [accountId]);
  return true;
}

export async function createSocialPost(siteId, { platform, message, scheduledAt }) {
  // Valida la piattaforma (il check CONSTRAINT del DB farà il resto)
  const schedAt = scheduledAt ? new Date(scheduledAt) : null;
  const now = new Date();

  // Se scheduledAt è nel passato o assente, pubblica subito (simulato)
  const isImmediate = !schedAt || schedAt <= now;
  const status = isImmediate ? "posted" : "scheduled";

  const result = await query(
    `INSERT INTO social_posts (site_id, external_id, platform, message, scheduled_at, posted_at, status, simulated, created_at)
     VALUES ($6, gen_random_uuid(), $1, $2, COALESCE($3, NOW()), $4, $5, true, NOW())
     RETURNING id, external_id, platform, message, scheduled_at, posted_at, status, simulated, created_at`,
    [
      platform,
      message,
      schedAt || null,
      isImmediate ? new Date() : null,
      status,
      siteId,
    ]
  );
  return result.rows[0];
}

export async function listSocialPosts(siteId, filters = {}, limit = 100, offset = 0) {
  let where = "site_id = $1";
  const params = [siteId];
  let paramIndex = 2;

  // Filtro per platform se fornito
  if (filters.platform) {
    where += ` AND platform = $${paramIndex}`;
    params.push(filters.platform);
    paramIndex++;
  }

  // Filtro per status se fornito
  if (filters.status) {
    where += ` AND status = $${paramIndex}`;
    params.push(filters.status);
    paramIndex++;
  }

  // Nota: social_posts non ha site_id diretto, è via page_id.
  // Per il clone API, esponiamo tutti i post per ora.
  // Se necessario aggiungere site_id a social_posts in una futura migrazione.

  const result = await query(
    `SELECT id, external_id, platform, message, scheduled_at, posted_at, status, simulated, created_at
     FROM social_posts
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  return result.rows;
}

export async function getSocialPostCount(siteId, filters = {}) {
  let where = "site_id = $1";
  const params = [siteId];
  let paramIndex = 2;

  if (filters.platform) {
    where += ` AND platform = $${paramIndex}`;
    params.push(filters.platform);
    paramIndex++;
  }

  if (filters.status) {
    where += ` AND status = $${paramIndex}`;
    params.push(filters.status);
    paramIndex++;
  }

  const result = await query(
    `SELECT COUNT(*) as count FROM social_posts WHERE ${where}`,
    params
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getSocialPostByExternalId(externalId, siteId) {
  const row = await findByExternalId("social_posts", externalId);
  if (!row || (siteId !== undefined && row.site_id !== siteId)) return null;
  return row;
}

export async function updateSocialPost(siteId, postId, { message, scheduledAt }) {
  const post = await query(`SELECT * FROM social_posts WHERE id = $1 AND site_id = $2`, [postId, siteId]).then(
    (r) => r.rows[0]
  );
  if (!post) return null;

  // Solo se il post non è ancora stato pubblicato
  if (post.posted_at) {
    return null;
  }

  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (message !== undefined) {
    updates.push(`message = $${paramIndex}`);
    values.push(message);
    paramIndex++;
  }

  if (scheduledAt !== undefined) {
    updates.push(`scheduled_at = $${paramIndex}`);
    values.push(scheduledAt ? new Date(scheduledAt) : null);
    paramIndex++;
  }

  if (!updates.length) return post;

  // NB: social_posts NON ha updated_at (schema legacy db/015)
  const result = await query(
    `UPDATE social_posts SET ${updates.join(", ")} WHERE id = $${paramIndex} AND site_id = $${paramIndex + 1} RETURNING *`,
    [...values, postId, siteId]
  );
  return result.rows[0];
}

export async function deleteSocialPost(siteId, postId) {
  const post = await query(`SELECT * FROM social_posts WHERE id = $1 AND site_id = $2`, [postId, siteId]).then(
    (r) => r.rows[0]
  );
  if (!post) return null;

  // Solo se il post non è ancora stato pubblicato
  if (post.posted_at) {
    return null;
  }

  await query(`DELETE FROM social_posts WHERE id = $1`, [postId]);
  return true;
}
