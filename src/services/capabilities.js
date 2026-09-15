import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Capability registry (substrato agent-first).
//
// La tabella `capabilities` è il catalogo delle capability disponibili.
// L'associazione a un ruolo riusa la tabella `roles_permissions` esistente,
// mappando la parte "risorsa" della capability (es. `contacts.read` →
// resource `contacts`) sulle colonne can_read/can_write. Convenzione:
//   - `X.read`  → can_read
//   - `X.write` → can_create/can_update/can_delete
//   - `agent.*` → risorsa speciale `agent` (can_read)
// ─────────────────────────────────────────────────────────────────────────

export async function listCapabilities() {
  return (await query(
    "SELECT key, name, description FROM capabilities ORDER BY key"
  )).rows;
}

function resourceAndAction(capabilityKey) {
  const k = String(capabilityKey || "");
  if (!k) return null;
  if (k.endsWith(".*")) {
    return { resource: k.slice(0, -2), action: "*" };
  }
  const idx = k.lastIndexOf(".");
  if (idx <= 0) return null;
  return { resource: k.slice(0, idx), action: k.slice(idx + 1) };
}

// Verifica se un ruolo possiede una capability, riusando roles_permissions.
// Ritorna true se esiste una riga roles_permissions per (role, resource) con
// il permesso corrispondente attivo (oppure il jolly *).
export async function roleHasCapability(role, capabilityKey) {
  const map = resourceAndAction(capabilityKey);
  if (!map) return false;
  const rows = (await query(
    "SELECT can_create, can_read, can_update, can_delete FROM roles_permissions WHERE role = $1 AND resource = $2",
    [role, map.resource]
  )).rows;
  if (rows.length === 0) return false;
  const row = rows[0];
  if (map.action === "*") {
    return !!(row.can_read || row.can_create || row.can_update || row.can_delete);
  }
  if (map.action === "read") return !!row.can_read;
  // write (create/update/delete)
  return !!(row.can_create || row.can_update || row.can_delete);
}

// Concede/aggiorna una capability a un ruolo: INSERT in roles_permissions con
// il permesso corrispondente attivo (ON CONFLICT DO UPDATE per idempotenza).
export async function grantCapability(role, capabilityKey, { read = true, write = true } = {}) {
  const map = resourceAndAction(capabilityKey);
  if (!map) return null;
  const resource = map.resource || capabilityKey;
  return (await query(
    `INSERT INTO roles_permissions (role, resource, can_create, can_read, can_update, can_delete)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (role, resource) DO UPDATE SET
       can_create = roles_permissions.can_create OR EXCLUDED.can_create,
       can_read = roles_permissions.can_read OR EXCLUDED.can_read,
       can_update = roles_permissions.can_update OR EXCLUDED.can_update,
       can_delete = roles_permissions.can_delete OR EXCLUDED.can_delete
     RETURNING *`,
    [role, resource, write, read, write, write]
  )).rows[0];
}

// Revoca completamente una capability dal ruolo (elimina la riga risorsa).
export async function revokeCapability(role, capabilityKey) {
  const resource = (resourceAndAction(capabilityKey) || {}).resource || capabilityKey;
  return (await query(
    "DELETE FROM roles_permissions WHERE role = $1 AND resource = $2",
    [role, resource]
  )).rowCount;
}
