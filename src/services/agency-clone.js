// ─────────────────────────────────────────────────────────────────────────
// Onda G: Agency, Users, Teams, Locations — service layer per operazioni DB
// Wrapper intorno alle query dirette con supporto external_id UUID.
// ─────────────────────────────────────────────────────────────────────────

import crypto from "crypto";
import { query } from "../db.js";
import { ensureExternalId, findByAnyId, publicId } from "./external-ids.js";

// ── LOCATIONS (Sites) ────────────────────────────────────────────────────

export async function createLocation({ name, businessInfo }) {
  const domainBase = "loc-" + crypto.randomBytes(6).toString("hex");
  const locationExternalId = crypto.randomUUID();

  const result = await query(
    `INSERT INTO sites (name, domain, location_external_id, business_info)
     VALUES ($1, $2, $3, $4)
     RETURNING id, external_id, name, location_external_id, business_info, created_at`,
    [name, domainBase + ".internal", locationExternalId, businessInfo || null]
  );

  const row = result.rows[0];
  return {
    id: row.external_id,
    locationId: row.location_external_id,
    name: row.name,
    businessInfo: row.business_info || {},
    dateAdded: row.created_at.toISOString(),
  };
}

export async function getLocationByIdOrExternalId(identifier) {
  // Prova prima come UUID esterno di site, poi come location_external_id
  let row = await query(
    "SELECT id, external_id, name, location_external_id, business_info, created_at FROM sites WHERE external_id = $1 LIMIT 1",
    [identifier]
  ).then((r) => r.rows[0] || null);

  if (!row) {
    row = await query(
      "SELECT id, external_id, name, location_external_id, business_info, created_at FROM sites WHERE location_external_id = $1 LIMIT 1",
      [identifier]
    ).then((r) => r.rows[0] || null);
  }

  if (!row) return null;

  return {
    id: row.external_id,
    locationId: row.location_external_id || row.external_id,
    name: row.name,
    businessInfo: row.business_info || {},
    dateAdded: row.created_at.toISOString(),
  };
}

export async function updateLocationBusinessInfo(siteId, businessInfo) {
  const result = await query(
    `UPDATE sites SET business_info = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, external_id, name, location_external_id, business_info, created_at`,
    [siteId, businessInfo || null]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.external_id,
    locationId: row.location_external_id || row.external_id,
    name: row.name,
    businessInfo: row.business_info || {},
    dateAdded: row.created_at.toISOString(),
  };
}

// ── USERS ────────────────────────────────────────────────────────────────

export async function createUser({ siteId, firstName, lastName, email, roles }) {
  const name = [firstName, lastName].filter(Boolean).join(" ");
  const role = (roles && roles[0]) || "collaboratore";

  const result = await query(
    `INSERT INTO users (email, name, role, site_id, status)
     VALUES ($1, $2, $3, $4, 'active')
     RETURNING id, external_id, ghl_id, email, name, role, created_at`,
    [email, name, role, siteId]
  );

  const row = result.rows[0];
  const [first, ...rest] = row.name.split(" ");

  return {
    id: publicId(row),
    locationId: null, // Sarà assegnato separatamente
    firstName: first,
    lastName: rest.join(" "),
    email: row.email,
    roles: [row.role],
    dateAdded: row.created_at.toISOString(),
  };
}

export async function getUsersByLocationId(siteId, limit = 20, startAfterId = null) {
  let sql = "SELECT * FROM users WHERE site_id = $1";
  const params = [siteId];

  if (startAfterId) {
    const afterRow = await findByAnyId("users", siteId, startAfterId);
    if (afterRow) {
      sql += " AND external_id > $2";
      params.push(afterRow.external_id);
    }
  }

  sql += " ORDER BY external_id ASC LIMIT $" + (params.length + 1);
  params.push(limit + 1);

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);
  const total = await query("SELECT COUNT(*)::INTEGER as cnt FROM users WHERE site_id = $1", [siteId]);
  const hasMore = result.rows.length > limit;
  const nextId = hasMore ? publicId(result.rows[limit]) : null;

  const users = rows.map((row) => {
    const [first, ...rest] = row.name.split(" ");
    return {
      id: publicId(row),
      locationId: null,
      firstName: first,
      lastName: rest.join(" "),
      email: row.email,
      roles: [row.role],
      dateAdded: row.created_at.toISOString(),
    };
  });

  return { users, total: parseInt(total.rows[0].cnt, 10), nextId };
}

export async function getUserById(siteId, userId) {
  const result = await query(
    "SELECT * FROM users WHERE id = $1 AND site_id = $2 LIMIT 1",
    [userId, siteId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const [first, ...rest] = row.name.split(" ");
  return {
    id: publicId(row),
    locationId: null,
    firstName: first,
    lastName: rest.join(" "),
    email: row.email,
    roles: [row.role],
    dateAdded: row.created_at.toISOString(),
  };
}

export async function updateUser(siteId, userId, { firstName, lastName, roles }) {
  const updates = [];
  const params = [userId, siteId];

  if (firstName !== undefined || lastName !== undefined) {
    const oldResult = await query("SELECT name FROM users WHERE id = $1", [userId]);
    const oldRow = oldResult.rows[0];
    const oldParts = oldRow ? oldRow.name.split(" ") : ["", ""];
    const newFirst = firstName !== undefined ? firstName : oldParts[0];
    const newLast = lastName !== undefined ? lastName : oldParts.slice(1).join(" ");
    const newName = [newFirst, newLast].filter(Boolean).join(" ");
    updates.push("name = $" + (params.length + 1));
    params.push(newName);
  }

  if (roles && roles.length > 0) {
    updates.push("role = $" + (params.length + 1));
    params.push(roles[0]);
  }

  if (updates.length === 0) return null;

  updates.push("updated_at = NOW()");
  const sql = `UPDATE users SET ${updates.join(", ")} WHERE id = $1 AND site_id = $2 RETURNING *`;
  const result = await query(sql, params);

  const row = result.rows[0];
  if (!row) return null;

  const [first, ...rest] = row.name.split(" ");
  return {
    id: publicId(row),
    locationId: null,
    firstName: first,
    lastName: rest.join(" "),
    email: row.email,
    roles: [row.role],
    dateAdded: row.created_at.toISOString(),
  };
}

export async function deleteUser(siteId, userId) {
  const result = await query("DELETE FROM users WHERE id = $1 AND site_id = $2", [userId, siteId]);
  return result.rowCount > 0;
}

export async function searchUsersByEmail(siteId, email) {
  const result = await query(
    "SELECT * FROM users WHERE site_id = $1 AND email = $2",
    [siteId, email]
  );

  return result.rows.map((row) => {
    const [first, ...rest] = row.name.split(" ");
    return {
      id: publicId(row),
      locationId: null,
      firstName: first,
      lastName: rest.join(" "),
      email: row.email,
      roles: [row.role],
      dateAdded: row.created_at.toISOString(),
    };
  });
}

// ── TEAMS ────────────────────────────────────────────────────────────────

export async function createTeam({ siteId, name, members }) {
  const teamResult = await query(
    `INSERT INTO teams (site_id, name)
     VALUES ($1, $2)
     RETURNING id, external_id, site_id, name, created_at, updated_at`,
    [siteId, name]
  );

  const team = teamResult.rows[0];
  const teamMembers = [];

  if (members && members.length > 0) {
    for (const member of members) {
      const userRow = await query("SELECT id FROM users WHERE external_id = $1", [member.userId]);
      if (userRow.rows[0]) {
        const userId = userRow.rows[0].id;
        const role = member.role || "member";
        const memberResult = await query(
          `INSERT INTO team_members (team_id, user_id, role)
           VALUES ($1, $2, $3)
           RETURNING external_id, role`,
          [team.id, userId, role]
        );
        if (memberResult.rows[0]) {
          teamMembers.push({
            id: memberResult.rows[0].external_id,
            role: memberResult.rows[0].role,
          });
        }
      }
    }
  }

  return {
    id: team.external_id,
    locationId: null,
    name: team.name,
    members: teamMembers,
    dateAdded: team.created_at.toISOString(),
    dateUpdated: team.updated_at.toISOString(),
  };
}

export async function getTeamsByLocationId(siteId, limit = 20, startAfterId = null) {
  let sql = "SELECT * FROM teams WHERE site_id = $1";
  const params = [siteId];

  if (startAfterId) {
    sql += " AND external_id > $2";
    params.push(startAfterId);
  }

  sql += " ORDER BY external_id ASC LIMIT $" + (params.length + 1);
  params.push(limit + 1);

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);
  const total = await query("SELECT COUNT(*)::INTEGER as cnt FROM teams WHERE site_id = $1", [siteId]);
  const hasMore = result.rows.length > limit;
  const nextId = hasMore ? result.rows[limit].external_id : null;

  const teams = [];
  for (const row of rows) {
    const memberResult = await query(
      `SELECT tm.external_id, tm.role FROM team_members tm WHERE tm.team_id = $1`,
      [row.id]
    );

    teams.push({
      id: row.external_id,
      locationId: null,
      name: row.name,
      members: memberResult.rows.map((m) => ({ id: m.external_id, role: m.role })),
      dateAdded: row.created_at.toISOString(),
      dateUpdated: row.updated_at.toISOString(),
    });
  }

  return { teams, total: parseInt(total.rows[0].cnt, 10), nextId };
}

export async function getTeamById(siteId, teamId) {
  const result = await query(
    "SELECT * FROM teams WHERE external_id = $1 AND site_id = $2 LIMIT 1",
    [teamId, siteId]
  );

  const row = result.rows[0];
  if (!row) return null;

  const memberResult = await query(
    `SELECT tm.external_id, tm.role FROM team_members tm WHERE tm.team_id = $1`,
    [row.id]
  );

  return {
    id: row.external_id,
    locationId: null,
    name: row.name,
    members: memberResult.rows.map((m) => ({ id: m.external_id, role: m.role })),
    dateAdded: row.created_at.toISOString(),
    dateUpdated: row.updated_at.toISOString(),
  };
}

export async function updateTeam(siteId, teamId, { name, members }) {
  const teamResult = await query(
    "SELECT id FROM teams WHERE external_id = $1 AND site_id = $2",
    [teamId, siteId]
  );

  if (!teamResult.rows[0]) return null;
  const internalTeamId = teamResult.rows[0].id;

  if (name !== undefined) {
    await query("UPDATE teams SET name = $1, updated_at = NOW() WHERE id = $2", [name, internalTeamId]);
  }

  if (members !== undefined) {
    await query("DELETE FROM team_members WHERE team_id = $1", [internalTeamId]);

    for (const member of members) {
      const userRow = await query("SELECT id FROM users WHERE external_id = $1", [member.userId]);
      if (userRow.rows[0]) {
        const userId = userRow.rows[0].id;
        const role = member.role || "member";
        await query(
          `INSERT INTO team_members (team_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [internalTeamId, userId, role]
        );
      }
    }
  }

  const updated = await query(
    "SELECT * FROM teams WHERE external_id = $1 AND site_id = $2",
    [teamId, siteId]
  );

  const row = updated.rows[0];
  const memberResult = await query(
    `SELECT tm.external_id, tm.role FROM team_members tm WHERE tm.team_id = $1`,
    [row.id]
  );

  return {
    id: row.external_id,
    locationId: null,
    name: row.name,
    members: memberResult.rows.map((m) => ({ id: m.external_id, role: m.role })),
    dateAdded: row.created_at.toISOString(),
    dateUpdated: row.updated_at.toISOString(),
  };
}

export async function deleteTeam(siteId, teamId) {
  const result = await query("DELETE FROM teams WHERE external_id = $1 AND site_id = $2", [
    teamId,
    siteId,
  ]);
  return result.rowCount > 0;
}
