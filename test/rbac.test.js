import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerRbacRoutes } from "../src/routes/agent-rbac.js";
import { auditLog } from "../src/services/audit.js";
import {
  getEffectivePermissions,
  hasPermission,
  assignUserRole,
  createRole,
  createShift,
  onDutyUsers,
  searchAuditLog,
} from "../src/services/rbac.js";

// F28: ruoli custom granulari (RBAC), turni operatori, ricerca audit.
// Il modulo route viene montato su un router locale con requireAuth +
// requireAgent (NON si importa agentRouter, per isolare la feature).
describe("crm: rbac, turni operatori e audit", () => {
  let site, site2, admin, collab, user2, token, token2, baseUrl, server;
  let roleReadId = null;

  before(async () => {
    site = await createTestSite("RBAC Test");
    site2 = await createTestSite("RBAC Test 2");
    admin = await createTestUser(site.id, "admin");
    collab = await createTestUser(site.id, "collaboratore");
    user2 = await createTestUser(site2.id, "admin");
    const created = await createApiToken(admin.id, "rbac test", 30);
    token = created.token;
    const created2 = await createApiToken(user2.id, "rbac test 2", 30);
    token2 = created2.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    const r = express.Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerRbacRoutes(r);
    app.use(r);
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
      console.error("TEST ERROR:", err?.message);
      res.status(500).json({ error: err?.message || "Errore interno" });
    });
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const auth2 = () => ({ Authorization: `Bearer ${token2}` });
  // Invia una richiesta con body JSON opzionale (GET → senza body)
  const send = (method, url, body) => fetch(url, {
    method,
    headers: { ...auth(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // ── (a) CRUD ruolo custom con permissions ──────────────────────────────

  test("POST /roles crea ruolo custom con permissions", async () => {
    const res = await send("POST", `${baseUrl}/api/agent/sites/${site.id}/roles`, {
      name: "Solo lettura",
      permissions: { contacts: ["read"], tasks: ["read"] },
    });
    assert.equal(res.status, 200);
    const { role } = await res.json();
    assert.ok(role.id);
    assert.equal(role.site_id, site.id);
    assert.deepEqual(role.permissions, { contacts: ["read"], tasks: ["read"] });
    roleReadId = role.id;
  });

  test("POST /roles con nome duplicato → 409", async () => {
    const res = await send("POST", `${baseUrl}/api/agent/sites/${site.id}/roles`, {
      name: "Solo lettura",
      permissions: {},
    });
    assert.equal(res.status, 409);
  });

  test("GET /roles elenca i ruoli del sito (e globali)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/roles`, { headers: auth() });
    assert.equal(res.status, 200);
    const { roles } = await res.json();
    assert.ok(roles.some(r => r.id === roleReadId));
  });

  test("PUT /roles/:id aggiorna nome e permissions", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/roles/${roleReadId}`, {
      name: "Solo lettura v2",
      permissions: { contacts: ["read", "update"] },
    });
    assert.equal(res.status, 200);
    const { role } = await res.json();
    assert.equal(role.name, "Solo lettura v2");
    assert.deepEqual(role.permissions, { contacts: ["read", "update"] });
  });

  test("GET /roles su sito altrui → 403", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/roles`, { headers: auth2() });
    assert.equal(res.status, 403);
  });

  // ── (b) hasPermission / getEffectivePermissions ────────────────────────

  test("superadmin ha permessi totali (all)", async () => {
    const eff = await getEffectivePermissions({ role: "superadmin" }, site.id);
    assert.equal(eff.all, true);
    assert.equal(await hasPermission({ role: "superadmin" }, site.id, "contacts", "update"), true);
    assert.equal(await hasPermission({ role: "superadmin" }, site.id, "whatever", "delete"), true);
  });

  test("collaboratore con ruolo custom: read sì, update no", async () => {
    // ri-crea un ruolo dedicato con solo lettura (quello di (a) è stato modificato)
    const role = await createRole(site.id, { name: "Read only CRM", permissions: { contacts: ["read"], tasks: ["read"] } });
    await assignUserRole(site.id, collab.id, role.id);

    // utente senza custom_role_id nel payload → caricato dal DB
    assert.equal(await hasPermission({ id: collab.id, role: "collaboratore" }, site.id, "contacts", "read"), true);
    assert.equal(await hasPermission({ id: collab.id, role: "collaboratore" }, site.id, "contacts", "update"), false);
    assert.equal(await hasPermission({ id: collab.id, role: "collaboratore" }, site.id, "tasks", "read"), true);
    assert.equal(await hasPermission({ id: collab.id, role: "collaboratore" }, site.id, "opportunities", "read"), false);

    // con custom_role_id esplicito nell'oggetto utente
    assert.equal(await hasPermission({ id: collab.id, role: "collaboratore", custom_role_id: role.id }, site.id, "contacts", "read"), true);
    assert.equal(await hasPermission({ id: collab.id, role: "collaboratore", custom_role_id: role.id }, site.id, "contacts", "update"), false);
  });

  test("collaboratore senza ruolo custom: read-only sui moduli conosciuti", async () => {
    const plain = await createTestUser(site.id, "collaboratore");
    const eff = await getEffectivePermissions({ id: plain.id, role: "collaboratore" }, site.id);
    assert.equal(eff.all, false);
    assert.deepEqual(eff.permissions.pages, ["read"]);
    assert.equal(await hasPermission({ id: plain.id, role: "collaboratore" }, site.id, "pages", "read"), true);
    assert.equal(await hasPermission({ id: plain.id, role: "collaboratore" }, site.id, "pages", "update"), false);
  });

  // ── (c) assignUserRole via route + verifica DB ─────────────────────────

  test("PUT /users/:id/role assegna il ruolo e aggiorna users.custom_role_id", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/users/${collab.id}/role`, {
      custom_role_id: roleReadId,
    });
    assert.equal(res.status, 200);
    const { user } = await res.json();
    assert.equal(user.custom_role_id, roleReadId);
    const dbUser = (await query("SELECT custom_role_id FROM users WHERE id = $1", [collab.id])).rows[0];
    assert.equal(dbUser.custom_role_id, roleReadId);
  });

  test("PUT /users/:id/role con null toglie il ruolo", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/users/${collab.id}/role`, {
      custom_role_id: null,
    });
    assert.equal(res.status, 200);
    const dbUser = (await query("SELECT custom_role_id FROM users WHERE id = $1", [collab.id])).rows[0];
    assert.equal(dbUser.custom_role_id, null);
  });

  test("PUT /users/:id/role con ruolo inesistente → 404", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/users/${collab.id}/role`, {
      custom_role_id: 999999,
    });
    assert.equal(res.status, 404);
  });

  test("PUT /users/:id/role su utente di altro sito → 400", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/users/${user2.id}/role`, {
      custom_role_id: roleReadId,
    });
    assert.equal(res.status, 400);
  });

  test("PUT /users/:id/role su utente inesistente → 404", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/users/999999/role`, {
      custom_role_id: roleReadId,
    });
    assert.equal(res.status, 404);
  });

  // ── (d) CRUD turno operatore ───────────────────────────────────────────

  let shiftId = null;

  test("POST /shifts crea turno", async () => {
    const res = await send("POST", `${baseUrl}/api/agent/sites/${site.id}/shifts`, {
      user_id: collab.id,
      day_of_week: 3,
      start_min: 480,
      end_min: 600,
    });
    assert.equal(res.status, 200);
    const { shift } = await res.json();
    assert.ok(shift.id);
    assert.equal(shift.day_of_week, 3);
    assert.equal(shift.start_min, 480);
    assert.equal(shift.end_min, 600);
    shiftId = shift.id;
  });

  test("POST /shifts con intervallo invalido → 400", async () => {
    const res = await send("POST", `${baseUrl}/api/agent/sites/${site.id}/shifts`, {
      user_id: collab.id,
      day_of_week: 3,
      start_min: 600,
      end_min: 480,
    });
    assert.equal(res.status, 400);
  });

  test("GET /shifts elenca i turni con nome/email operatore", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/shifts`, { headers: auth() });
    assert.equal(res.status, 200);
    const { shifts } = await res.json();
    const s = shifts.find(x => x.id === shiftId);
    assert.ok(s);
    assert.equal(s.user_id, collab.id);
    assert.equal(s.user_email, collab.email);
  });

  test("PUT /shifts/:id aggiorna il turno", async () => {
    const res = await send("PUT", `${baseUrl}/api/agent/sites/${site.id}/shifts/${shiftId}`, {
      end_min: 660,
      active: false,
    });
    assert.equal(res.status, 200);
    const { shift } = await res.json();
    assert.equal(shift.end_min, 660);
    assert.equal(shift.active, false);
  });

  test("DELETE /shifts/:id elimina il turno", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/shifts/${shiftId}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/shifts`, { headers: auth() });
    assert.equal((await list.json()).shifts.some(x => x.id === shiftId), false);
  });

  // ── (e) onDutyUsers ────────────────────────────────────────────────────

  test("onDutyUsers: turno di oggi incluso, turno di domani escluso", async () => {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const start = Math.max(nowMin - 60, 0);
    const end = Math.min(nowMin + 60, 1439);

    await createShift(site.id, { user_id: collab.id, day_of_week: now.getDay(), start_min: start, end_min: end });
    await createShift(site.id, { user_id: admin.id, day_of_week: (now.getDay() + 1) % 7, start_min: 480, end_min: 600 });

    const duty = await onDutyUsers(site.id);
    assert.ok(duty.some(o => o.id === collab.id), "l'operatore col turno di oggi deve essere in servizio");
    assert.ok(!duty.some(o => o.id === admin.id), "il turno di domani non deve comparire");

    // via HTTP
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/operators-on-duty`, { headers: auth() });
    assert.equal(res.status, 200);
    const { operators } = await res.json();
    assert.ok(operators.some(o => o.id === collab.id));
    assert.ok(operators.every(o => o.id !== admin.id));
  });

  // ── (f) searchAuditLog ─────────────────────────────────────────────────

  test("searchAuditLog trova gli eventi con i filtri", async () => {
    await auditLog({ userId: admin.id, siteId: site.id, entityType: "custom_role", entityId: 42, action: "role_create", newData: { name: "filtro" }, ipAddress: "127.0.0.1" });
    await auditLog({ userId: collab.id, siteId: site.id, entityType: "operator_shift", entityId: 7, action: "shift_update", newData: { end_min: 720 } });

    const byEntity = await searchAuditLog(site.id, { entity_type: "custom_role" });
    assert.ok(byEntity.events.length >= 1);
    assert.ok(byEntity.events.every(e => e.entity_type === "custom_role"));
    assert.ok(byEntity.total >= byEntity.events.length);

    const byUserAction = await searchAuditLog(site.id, { user_id: admin.id, action: "role_create" });
    assert.ok(byUserAction.events.length >= 1);
    assert.ok(byUserAction.events.every(e => e.user_id === admin.id && e.action === "role_create"));

    const byRange = await searchAuditLog(site.id, {
      from: new Date(Date.now() - 3600e3).toISOString(),
      to: new Date().toISOString(),
    });
    assert.ok(byRange.events.length >= 2);

    const limited = await searchAuditLog(site.id, { limit: 1 });
    assert.equal(limited.events.length, 1);
    assert.equal(limited.limit, 1);
  });

  test("GET /audit-events espone la ricerca con filtri query", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/audit-events?entity_type=operator_shift&limit=10`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.events.length >= 1);
    assert.ok(body.events.every(e => e.entity_type === "operator_shift"));
    assert.ok(body.total >= body.events.length);
  });

  // ── (a) chiusura: DELETE ruolo ─────────────────────────────────────────

  test("DELETE /roles/:id elimina il ruolo", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/roles/${roleReadId}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/roles`, { headers: auth() });
    assert.equal((await list.json()).roles.some(r => r.id === roleReadId), false);
  });
});
