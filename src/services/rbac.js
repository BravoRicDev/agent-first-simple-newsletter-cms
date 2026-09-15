import { query, getClient } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// RBAC granulare (ruoli custom), turni operatori, ricerca audit (F28).
// I ruoli statici (superadmin/admin/collaboratore su users.role) restano
// quelli gestiti da middleware/authorize.js: qui si aggiunge un livello
// custom per-modulo che vale sui moduli CRM. Collaboratore senza ruolo
// custom → sola lettura sui moduli conosciuti.
// ─────────────────────────────────────────────────────────────────────────

const BASE_READONLY_PERMISSIONS = {
  contacts: ["read"],
  tasks: ["read"],
  pages: ["read"],
  opportunities: ["read"],
  conversations: ["read"],
};

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  return err;
}

function sanitizePermissions(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [module, actions] of Object.entries(raw)) {
    const mod = String(module).trim().slice(0, 100);
    if (!mod) continue;
    const list = Array.isArray(actions) ? actions : [actions];
    const clean = [...new Set(list.map(a => String(a).trim().slice(0, 50)).filter(Boolean))];
    if (clean.length) out[mod] = clean;
  }
  return out;
}

// ── Permessi effettivi ───────────────────────────────────────────────────

// Ritorna { all, permissions } per un utente su un sito:
// - superadmin/admin → { all: true } (pieni poteri, come da ruolo statico)
// - collaboratore con custom_role_id → permissions JSONB del ruolo,
//   solo se il ruolo è globale (site_id 0) o appartiene al sito
// - collaboratore senza ruolo custom → read-only sui moduli conosciuti
export async function getEffectivePermissions(user, siteId) {
  if (!user) return { all: false, permissions: {} };
  if (user.role === "superadmin" || user.role === "admin") {
    return { all: true, permissions: {} };
  }

  // req.user (JWT/API token) non espone custom_role_id: lo carichiamo dal DB
  // quando manca, così la funzione funziona con qualunque meccanismo di auth.
  let customRoleId = user.custom_role_id ?? null;
  if (customRoleId === null) {
    const row = (await query("SELECT custom_role_id FROM users WHERE id = $1", [user.id ?? user.sub])).rows[0];
    customRoleId = row?.custom_role_id ?? null;
  }

  if (customRoleId) {
    const role = (await query(
      "SELECT site_id, permissions FROM custom_roles WHERE id = $1",
      [customRoleId]
    )).rows[0];
    if (role && (role.site_id === 0 || role.site_id === siteId)) {
      return { all: false, permissions: role.permissions || {} };
    }
  }

  return { all: false, permissions: { ...BASE_READONLY_PERMISSIONS } };
}

// true se l'utente può eseguire action sul modulo (o ha 'all' sul modulo).
export async function hasPermission(user, siteId, module, action) {
  const eff = await getEffectivePermissions(user, siteId);
  if (eff.all) return true;
  const perms = eff.permissions[module];
  if (!Array.isArray(perms) || perms.length === 0) return false;
  return perms.includes("all") || perms.includes(action);
}

// ── Ruoli custom ─────────────────────────────────────────────────────────

export async function listRoles(siteId) {
  return (await query(
    "SELECT * FROM custom_roles WHERE site_id = $1 OR site_id = 0 ORDER BY site_id DESC, name",
    [siteId]
  )).rows;
}

export async function createRole(siteId, { name, permissions } = {}) {
  const cleanName = String(name || "").trim().slice(0, 255);
  if (!cleanName) throw httpError(400, "Nome obbligatorio");
  const perms = sanitizePermissions(permissions);
  try {
    const { rows } = await query(
      "INSERT INTO custom_roles (site_id, name, permissions) VALUES ($1, $2, $3) RETURNING *",
      [siteId, cleanName, JSON.stringify(perms)]
    );
    return rows[0];
  } catch (err) {
    if (err.code === "23505") throw httpError(409, "Ruolo con questo nome già esistente");
    throw err;
  }
}

export async function updateRole(siteId, roleId, data) {
  const role = (await query(
    "SELECT * FROM custom_roles WHERE id = $1 AND (site_id = $2 OR site_id = 0)",
    [roleId, siteId]
  )).rows[0];
  if (!role) throw httpError(404, "Ruolo non trovato");
  const name = data.name !== undefined ? String(data.name).trim().slice(0, 255) : role.name;
  if (!name) throw httpError(400, "Nome obbligatorio");
  const permissions = data.permissions !== undefined ? sanitizePermissions(data.permissions) : role.permissions;
  try {
    await query(
      "UPDATE custom_roles SET name = $1, permissions = $2, updated_at = NOW() WHERE id = $3",
      [name, JSON.stringify(permissions), roleId]
    );
  } catch (err) {
    if (err.code === "23505") throw httpError(409, "Ruolo con questo nome già esistente");
    throw err;
  }
  return (await query("SELECT * FROM custom_roles WHERE id = $1", [roleId])).rows[0];
}

export async function deleteRole(siteId, roleId) {
  const role = (await query(
    "SELECT id FROM custom_roles WHERE id = $1 AND (site_id = $2 OR site_id = 0)",
    [roleId, siteId]
  )).rows[0];
  if (!role) throw httpError(404, "Ruolo non trovato");
  const client = await getClient();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE users SET custom_role_id = NULL WHERE custom_role_id = $1", [roleId]);
    await client.query("DELETE FROM custom_roles WHERE id = $1", [roleId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { deleted: roleId };
}

// ── Assegnazione ruolo utente ────────────────────────────────────────────

// Assegna (o toglie, roleId = null) il ruolo custom a un utente del sito.
// L'utente deve esistere e appartenere a siteId; il ruolo deve essere
// compatibile col sito (globale o del sito stesso).
export async function assignUserRole(siteId, userId, roleId) {
  const uid = parseInt(userId, 10);
  if (!Number.isInteger(uid)) throw httpError(400, "userId non valido");
  const rid = (roleId === null || roleId === undefined || roleId === "")
    ? null
    : parseInt(roleId, 10);
  if (rid !== null && !Number.isInteger(rid)) throw httpError(400, "custom_role_id non valido");

  const userRow = (await query("SELECT id, site_id FROM users WHERE id = $1", [uid])).rows[0];
  if (!userRow) throw httpError(404, "Utente non trovato");
  if (userRow.site_id !== siteId) throw httpError(400, "Utente non appartiene al sito");

  if (rid !== null) {
    const role = (await query(
      "SELECT id FROM custom_roles WHERE id = $1 AND (site_id = $2 OR site_id = 0)",
      [rid, siteId]
    )).rows[0];
    if (!role) throw httpError(404, "Ruolo non trovato o incompatibile col sito");
  }

  await query(
    "UPDATE users SET custom_role_id = $1, updated_at = NOW() WHERE id = $2",
    [rid, uid]
  );
  return (await query(
    "SELECT id, email, name, role, site_id, custom_role_id FROM users WHERE id = $1",
    [uid]
  )).rows[0];
}

// ── Turni operatori ──────────────────────────────────────────────────────

function validateShift(siteId, { user_id, day_of_week, start_min, end_min }) {
  const uid = parseInt(user_id, 10);
  const dow = parseInt(day_of_week, 10);
  const start = parseInt(start_min, 10);
  const end = parseInt(end_min, 10);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw httpError(400, "day_of_week deve essere tra 0 e 6");
  if (!Number.isInteger(start) || start < 0 || start > 1439) throw httpError(400, "start_min deve essere tra 0 e 1439");
  if (!Number.isInteger(end) || end < 0 || end > 1439) throw httpError(400, "end_min deve essere tra 0 e 1439");
  if (end <= start) throw httpError(400, "end_min deve essere maggiore di start_min");
  if (!Number.isInteger(uid)) throw httpError(400, "user_id non valido");
  return { uid, dow, start, end };
}

export async function listShifts(siteId) {
  return (await query(
    `SELECT s.*, u.name AS user_name, u.email AS user_email
     FROM operator_shifts s JOIN users u ON u.id = s.user_id
     WHERE s.site_id = $1 ORDER BY s.day_of_week, s.start_min`,
    [siteId]
  )).rows;
}

export async function createShift(siteId, data) {
  const { uid, dow, start, end } = validateShift(siteId, data);
  const u = (await query("SELECT id, site_id FROM users WHERE id = $1", [uid])).rows[0];
  if (!u) throw httpError(404, "Utente non trovato");
  if (u.site_id !== siteId) throw httpError(400, "Utente non appartiene al sito");
  const { rows } = await query(
    `INSERT INTO operator_shifts (site_id, user_id, day_of_week, start_min, end_min)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [siteId, uid, dow, start, end]
  );
  return rows[0];
}

export async function updateShift(siteId, shiftId, data) {
  const current = (await query(
    "SELECT * FROM operator_shifts WHERE id = $1 AND site_id = $2",
    [shiftId, siteId]
  )).rows[0];
  if (!current) throw httpError(404, "Turno non trovato");
  const merged = {
    user_id: data.user_id !== undefined ? data.user_id : current.user_id,
    day_of_week: data.day_of_week !== undefined ? data.day_of_week : current.day_of_week,
    start_min: data.start_min !== undefined ? data.start_min : current.start_min,
    end_min: data.end_min !== undefined ? data.end_min : current.end_min,
  };
  const { uid, dow, start, end } = validateShift(siteId, merged);
  if (uid !== current.user_id) {
    const u = (await query("SELECT id, site_id FROM users WHERE id = $1", [uid])).rows[0];
    if (!u) throw httpError(404, "Utente non trovato");
    if (u.site_id !== siteId) throw httpError(400, "Utente non appartiene al sito");
  }
  await query(
    `UPDATE operator_shifts
     SET user_id = $1, day_of_week = $2, start_min = $3, end_min = $4, active = $5
     WHERE id = $6 AND site_id = $7`,
    [uid, dow, start, end, data.active !== undefined ? !!data.active : current.active, shiftId, siteId]
  );
  return (await query("SELECT * FROM operator_shifts WHERE id = $1", [shiftId])).rows[0];
}

export async function deleteShift(siteId, shiftId) {
  const result = await query(
    "DELETE FROM operator_shifts WHERE id = $1 AND site_id = $2",
    [shiftId, siteId]
  );
  if (result.rowCount === 0) throw httpError(404, "Turno non trovato");
  return { deleted: shiftId };
}

// Utenti con turno attivo nel giorno/ora indicati (default: adesso).
// Intervallo [start_min, end_min] incluso su entrambi gli estremi.
export async function onDutyUsers(siteId, date = new Date()) {
  const dow = date.getDay();
  const nowMin = date.getHours() * 60 + date.getMinutes();
  return (await query(
    `SELECT u.id, u.name, u.email,
            s.id AS shift_id, s.day_of_week, s.start_min, s.end_min, s.active
     FROM operator_shifts s JOIN users u ON u.id = s.user_id
     WHERE s.site_id = $1 AND s.active = true AND s.day_of_week = $2
       AND s.start_min <= $3 AND s.end_min >= $3
     ORDER BY u.name`,
    [siteId, dow, nowMin]
  )).rows;
}

// ── Ricerca audit log ────────────────────────────────────────────────────

// Colonna reali di audit_log (001_schema.sql): id, user_id, site_id,
// entity_type, entity_id, action (VARCHAR(20)), old_data, new_data,
// ip_address, created_at.
export async function searchAuditLog(siteId, {
  user_id, action, entity_type, from, to, limit = 50, offset = 0,
} = {}) {
  const conditions = ["site_id = $1"];
  const params = [siteId];

  const pushFilter = (value, column, transform) => {
    if (value === undefined || value === null || value === "") return;
    params.push(transform(value));
    conditions.push(`${column} = $${params.length}`);
  };
  pushFilter(user_id, "user_id", v => parseInt(v, 10));
  pushFilter(action, "action", v => String(v).trim().slice(0, 20));
  pushFilter(entity_type, "entity_type", v => String(v).trim().slice(0, 100));

  const parseDate = (v) => {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  };
  const fromDate = from ? parseDate(from) : null;
  if (fromDate) {
    params.push(fromDate);
    conditions.push(`created_at >= $${params.length}`);
  }
  const toDate = to ? parseDate(to) : null;
  if (toDate) {
    params.push(toDate);
    conditions.push(`created_at <= $${params.length}`);
  }

  const where = conditions.join(" AND ");
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);

  // COUNT senza LIMIT/OFFSET (i placeholder dei filtri sono i primi N)
  const totalRow = (await query(
    `SELECT COUNT(*)::int AS n FROM audit_log WHERE ${where}`,
    params
  )).rows[0];

  const { rows } = await query(
    `SELECT id, user_id, site_id, entity_type, entity_id, action,
            old_data, new_data, ip_address, created_at
     FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, lim, off]
  );

  return { total: totalRow.n, events: rows, limit: lim, offset: off };
}
