import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerClientServicesRoutes } from "../src/routes/agent-client-services.js";

// ─────────────────────────────────────────────────────────────────────────
// Area clienti GENERICA: clienti (contatti marcati) + catalogo servizi +
// stato servizio per cliente + verifica accesso (per un servizio esterno).
// ─────────────────────────────────────────────────────────────────────────

describe("clienti + servizi (area clienti generica)", () => {
  let site, user, token, server, baseUrl;
  let contactA, contactB;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const json = (extra = {}) => ({ ...auth(), "Content-Type": "application/json", ...extra });
  const clientsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/clients${extra}`;
  const catalogUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/services-catalog${extra}`;

  async function createContact(email) {
    const r = await query(
      "INSERT INTO contacts (site_id, email) VALUES ($1, $2) RETURNING id, email",
      [site.id, email]
    );
    return r.rows[0];
  }

  before(async () => {
    site = await createTestSite("Clienti Servizi Test");
    user = await createTestUser(site.id, "admin");
    token = (await createApiToken(user.id, "client-services test", 30)).token;

    // Il DB di test non viene ripulito tra i run: il catalogo servizi è una
    // tabella di configurazione, la svuotiamo (cascade su client_services).
    await query("DELETE FROM services_catalog");

    contactA = await createContact(uniqueEmail("clientea"));
    contactB = await createContact(uniqueEmail("clienteb"));

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerClientServicesRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use((err, req, res, next) => {
      // eslint-disable-next-line no-console
      console.log("ERR", req.method, req.path, err.status, err.message);
      res.status(err.status || 500).json({ error: err.message });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  test("catalogo: crea, lista, aggiorna, elimina servizio", async () => {
    const created = await fetch(catalogUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ key: "portale", label: "Portale clienti", description: "Accesso area clienti" }),
    });
    assert.equal(created.status, 200);
    const { service } = await created.json();
    assert.equal(service.key, "portale");
    assert.equal(service.label, "Portale clienti");

    const created2 = await fetch(catalogUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ key: "whatsapp", label: "WhatsApp" }),
    });
    assert.equal(created2.status, 200);

    const list = await fetch(catalogUrl(), { headers: auth() });
    const { services } = await list.json();
    assert.ok(services.some((s) => s.key === "portale"));
    assert.ok(services.some((s) => s.key === "whatsapp"));

    const upd = await fetch(catalogUrl("/portale"), {
      method: "PATCH", headers: json(),
      body: JSON.stringify({ active: false }),
    });
    assert.equal(upd.status, 200);
    assert.equal((await upd.json()).service.active, false);

    const del = await fetch(catalogUrl("/whatsapp"), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    const after = await fetch(catalogUrl(), { headers: auth() });
    assert.ok(!(await after.json()).services.some((s) => s.key === "whatsapp"));
  });

  test("mark cliente: marca/smarca con status", async () => {
    const mark = await fetch(clientsUrl(`/${contactA.id}/mark`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ is_client: true, client_status: "active" }),
    });
    assert.equal(mark.status, 200);
    const { client } = await mark.json();
    assert.equal(client.is_client, true);
    assert.equal(client.client_status, "active");

    const markB = await fetch(clientsUrl(`/${contactB.id}/mark`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ is_client: true, client_status: "suspended" }),
    });
    assert.equal(markB.status, 200);

    // Smarca → status torna inactive.
    const unmark = await fetch(clientsUrl(`/${contactB.id}/mark`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ is_client: false }),
    });
    assert.equal((await unmark.json()).client.client_status, "inactive");
  });

  test("set servizio per cliente: attiva/disattiva", async () => {
    // Riattivo il catalogo (era stato disattivato nel primo test).
    await fetch(catalogUrl("/portale"), {
      method: "PATCH", headers: json(),
      body: JSON.stringify({ active: true }),
    });

    const on = await fetch(clientsUrl(`/${contactA.id}/services/portale/set`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ active: true }),
    });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).assignment.active, true);

    const list = await fetch(clientsUrl(`/${contactA.id}/services`), { headers: auth() });
    const { services } = await list.json();
    const portale = services.find((s) => s.key === "portale");
    assert.ok(portale, "portale presente nella lista");
    assert.equal(portale.active, true);

    const off = await fetch(clientsUrl(`/${contactA.id}/services/portale/set`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ active: false }),
    });
    const offBody = await off.json();
    assert.equal(offBody.assignment.active, false);
    assert.ok(offBody.assignment.deactivated_at);

    // Riattivo per i test di accesso.
    await fetch(clientsUrl(`/${contactA.id}/services/portale/set`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ active: true }),
    });
  });

  test("access check: cliente attivo + servizio attivo + assegnato → has_access true", async () => {
    const res = await fetch(clientsUrl(`/${contactA.id}/access/portale`), { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.has_access, true, JSON.stringify(body));
  });

  test("access check: servizio disattivato per il cliente → false", async () => {
    await fetch(clientsUrl(`/${contactA.id}/services/portale/set`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ active: false }),
    });
    const res = await fetch(clientsUrl(`/${contactA.id}/access/portale`), { headers: auth() });
    assert.equal((await res.json()).has_access, false);
    // riattivo
    await fetch(clientsUrl(`/${contactA.id}/services/portale/set`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ active: true }),
    });
  });

  test("access check: servizio non assegnato / non esistente / cliente sospeso → false", async () => {
    // Non assegnato (contactA non ha 'mailing').
    const notAssigned = await fetch(clientsUrl(`/${contactA.id}/access/mailing`), { headers: auth() });
    assert.equal((await notAssigned.json()).has_access, false);

    // Servizio inesistente.
    const unknown = await fetch(clientsUrl(`/${contactA.id}/access/nope`), { headers: auth() });
    assert.equal((await unknown.json()).has_access, false);

    // Cliente sospeso.
    await fetch(clientsUrl(`/${contactA.id}/mark`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ client_status: "suspended" }),
    });
    const suspended = await fetch(clientsUrl(`/${contactA.id}/access/portale`), { headers: auth() });
    assert.equal((await suspended.json()).has_access, false);
    // riattivo
    await fetch(clientsUrl(`/${contactA.id}/mark`), {
      method: "POST", headers: json(),
      body: JSON.stringify({ client_status: "active" }),
    });
  });

  test("access check by email (per servizio esterno)", async () => {
    const res = await fetch(`${clientsUrl("/access-by-email")}?email=${encodeURIComponent(contactA.email)}&service=portale`, {
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.has_access, true, JSON.stringify(body));

    // Email inesistente → false.
    const noEmail = await fetch(`${clientsUrl("/access-by-email")}?email=${encodeURIComponent("nobody@example.test")}&service=portale`, {
      headers: auth(),
    });
    assert.equal((await noEmail.json()).has_access, false);
  });

  test("clients list: filtra clienti attivi e include i servizi attivi", async () => {
    const res = await fetch(clientsUrl("?status=active"), { headers: auth() });
    assert.equal(res.status, 200);
    const { clients } = await res.json();
    assert.ok(clients.some((c) => c.id === contactA.id), "contactA presente tra i clienti attivi");
    const a = clients.find((c) => c.id === contactA.id);
    assert.ok((a.active_services || []).includes("portale"), `servizi attivi: ${JSON.stringify(a.active_services)}`);
    assert.ok(!clients.some((c) => c.id === contactB.id), "contactB non è cliente attivo");
  });

  test("opportunità vinta → il contatto diventa automaticamente cliente", async () => {
    const { createOpportunity, updateOpportunity } = await import("../src/services/opportunities.js");
    const c = await createContact(uniqueEmail("auto"));
    const opportunity = await createOpportunity(site.id, { email: c.email, title: "Vendita", amount: 1000 });
    assert.ok(opportunity, "opportunità creata");

    const won = await updateOpportunity(site.id, opportunity.id, { status: "won" });
    assert.equal(won.status, "won");

    const row = (await query("SELECT is_client, client_status FROM contacts WHERE id = $1", [c.id])).rows[0];
    assert.equal(row.is_client, true, "contatto marcato cliente");
    assert.equal(row.client_status, "active");
  });
});
