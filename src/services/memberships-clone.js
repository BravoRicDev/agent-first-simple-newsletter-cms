import { query } from "../db.js";
import { findByExternalId } from "./external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Memberships clone API service: CRUD memberships, courses, enrollments.
// ─────────────────────────────────────────────────────────────────────────

// ── Memberships ─────────────────────────────────────────────────────────


// Risolve un riferimento membership/course: uuid esterno -> id interno.
// Tollerante anche a id numerici già interni (uso tra service e route).
async function resolveMembershipRef(siteId, ref) {
  if (ref === undefined || ref === null) return null;
  if (/^\d+$/.test(String(ref))) {
    const r = await query("SELECT id FROM memberships WHERE id = $1 AND site_id = $2", [parseInt(ref, 10), siteId]);
    return r.rows[0]?.id ?? null;
  }
  const row = await findByExternalId("memberships", String(ref));
  return row && row.site_id === siteId ? row.id : null;
}
async function resolveCourseRef(siteId, ref) {
  if (ref === undefined || ref === null) return null;
  if (/^\d+$/.test(String(ref))) {
    const r = await query("SELECT id FROM courses WHERE id = $1 AND site_id = $2", [parseInt(ref, 10), siteId]);
    return r.rows[0]?.id ?? null;
  }
  const row = await findByExternalId("courses", String(ref));
  return row && row.site_id === siteId ? row.id : null;
}

export async function createMembership(siteId, { name, price, currency, billingInterval, active }) {
  const result = await query(
    `INSERT INTO memberships (site_id, name, price, currency, billing_interval, active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     RETURNING id, external_id, site_id, name, price, currency, billing_interval, active, created_at, updated_at`,
    [siteId, name, price || 0, currency || "EUR", billingInterval || "monthly", active !== false]
  );
  return result.rows[0];
}

export async function listMemberships(siteId, limit = 100, offset = 0) {
  const result = await query(
    `SELECT id, external_id, site_id, name, price, currency, billing_interval, active, created_at, updated_at
     FROM memberships
     WHERE site_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [siteId, limit, offset]
  );
  return result.rows;
}

export async function getMembershipCount(siteId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM memberships WHERE site_id = $1`,
    [siteId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getMembershipByExternalId(externalId) {
  return findByExternalId("memberships", externalId);
}

export async function updateMembership(membershipId, updates) {
  const setClause = [];
  const values = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClause.push(`name = $${paramIndex}`);
    values.push(updates.name);
    paramIndex++;
  }
  if (updates.price !== undefined) {
    setClause.push(`price = $${paramIndex}`);
    values.push(updates.price);
    paramIndex++;
  }
  if (updates.currency !== undefined) {
    setClause.push(`currency = $${paramIndex}`);
    values.push(updates.currency);
    paramIndex++;
  }
  if (updates.billingInterval !== undefined) {
    setClause.push(`billing_interval = $${paramIndex}`);
    values.push(updates.billingInterval);
    paramIndex++;
  }
  if (updates.active !== undefined) {
    setClause.push(`active = $${paramIndex}`);
    values.push(updates.active);
    paramIndex++;
  }

  if (!setClause.length) return null;

  setClause.push(`updated_at = NOW()`);
  values.push(membershipId);

  const result = await query(
    `UPDATE memberships SET ${setClause.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function deleteMembership(membershipId) {
  await query(`DELETE FROM memberships WHERE id = $1`, [membershipId]);
  return true;
}

// ── Courses ─────────────────────────────────────────────────────────────

export async function createCourse(siteId, { membershipId, name, description, published }) {
  membershipId = await resolveMembershipRef(siteId, membershipId);
  const result = await query(
    `INSERT INTO courses (site_id, membership_id, name, description, published, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id, external_id, site_id, membership_id, name, description, published, created_at, updated_at`,
    [siteId, membershipId || null, name, description || "", published !== false]
  );
  return result.rows[0];
}

export async function listCourses(siteId, filters = {}, limit = 100, offset = 0) {
  let where = "site_id = $1";
  const params = [siteId];
  let paramIndex = 2;

  if (filters.membershipId) {
    filters.membershipId = await resolveMembershipRef(siteId, filters.membershipId);
    if (!filters.membershipId) return [];
    where += ` AND membership_id = $${paramIndex}`;
    params.push(filters.membershipId);
    paramIndex++;
  }

  const result = await query(
    `SELECT id, external_id, site_id, membership_id, name, description, published, created_at, updated_at
     FROM courses
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset]
  );
  return result.rows;
}

export async function getCourseCount(siteId, filters = {}) {
  let where = "site_id = $1";
  const params = [siteId];
  let paramIndex = 2;

  if (filters.membershipId) {
    where += ` AND membership_id = $${paramIndex}`;
    params.push(filters.membershipId);
    paramIndex++;
  }

  const result = await query(
    `SELECT COUNT(*) as count FROM courses WHERE ${where}`,
    params
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getCourseByExternalId(externalId) {
  return findByExternalId("courses", externalId);
}

export async function updateCourse(courseId, updates) {
  const setClause = [];
  const values = [];
  let paramIndex = 1;

  if (updates.membershipId !== undefined) {
    updates.membershipId = await resolveMembershipRef(siteId, updates.membershipId);
    setClause.push(`membership_id = $${paramIndex}`);
    values.push(updates.membershipId || null);
    paramIndex++;
  }
  if (updates.name !== undefined) {
    setClause.push(`name = $${paramIndex}`);
    values.push(updates.name);
    paramIndex++;
  }
  if (updates.description !== undefined) {
    setClause.push(`description = $${paramIndex}`);
    values.push(updates.description);
    paramIndex++;
  }
  if (updates.published !== undefined) {
    setClause.push(`published = $${paramIndex}`);
    values.push(updates.published);
    paramIndex++;
  }

  if (!setClause.length) return null;

  setClause.push(`updated_at = NOW()`);
  values.push(courseId);

  const result = await query(
    `UPDATE courses SET ${setClause.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function deleteCourse(courseId) {
  await query(`DELETE FROM courses WHERE id = $1`, [courseId]);
  return true;
}

// ── Enrollments ─────────────────────────────────────────────────────────

export async function createEnrollment(siteId, membershipId, { contactId, courseId }) {
  const result = await query(
    `INSERT INTO enrollments (site_id, membership_id, contact_id, course_id, status, enrolled_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', NOW(), NOW(), NOW())
     RETURNING id, external_id, site_id, membership_id, contact_id, course_id, status, enrolled_at, completed_at, created_at, updated_at`,
    [siteId, membershipId, contactId, courseId || null]
  );
  return result.rows[0];
}

export async function listEnrollments(membershipId, limit = 100, offset = 0) {
  const result = await query(
    `SELECT id, external_id, site_id, membership_id, contact_id, course_id, status, enrolled_at, completed_at, created_at, updated_at
     FROM enrollments
     WHERE membership_id = $1
     ORDER BY enrolled_at DESC
     LIMIT $2 OFFSET $3`,
    [membershipId, limit, offset]
  );
  return result.rows;
}

export async function getEnrollmentCount(membershipId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM enrollments WHERE membership_id = $1`,
    [membershipId]
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getEnrollmentByExternalId(externalId) {
  return findByExternalId("enrollments", externalId);
}

export async function updateEnrollment(enrollmentId, updates) {
  const setClause = [];
  const values = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    setClause.push(`status = $${paramIndex}`);
    values.push(updates.status);
    paramIndex++;

    // Se lo status è 'completed', imposta completed_at a NOW()
    if (updates.status === "completed") {
      setClause.push(`completed_at = NOW()`);
    }
  }

  if (!setClause.length) return null;

  setClause.push(`updated_at = NOW()`);
  values.push(enrollmentId);

  const result = await query(
    `UPDATE enrollments SET ${setClause.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

export async function deleteEnrollment(enrollmentId) {
  await query(`DELETE FROM enrollments WHERE id = $1`, [enrollmentId]);
  return true;
}
