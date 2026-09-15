import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import salesApiRoutes from "../src/routes/sales-api.js";

// Scrittura dati dai moduli satellite (sales-api): POST/PUT opportunità e
// contatti, protetti da scope "write" del token. Perimetro sempre il
// site_id del token: mai cross-tenant.
describe("write API satellite: opportunità + contatti con scope token", () => {
  let site, otherSite, rwToken, roToken, server, baseUrl;

  before(async () => {
    site = await createTestSite("Sales Write Test");
    otherSite = await createTestSite("Sales Write Other");
    const user = await createTestUser(site.id, "superadmin");
    rwToken = (await createApiToken(user.id, "rw", 30, ["read", "write"])).token;
    roToken = (await createApiToken(user.id, "ro", 30, ["read"])).token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(salesApiRoutes);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  test("POST /api/opportunities crea con alias value→amount (201)", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ title: "Deal satellite", email: "deal@example.test", value: "1500.50", stage: "nuovo" }),
    });
    assert.equal(res.status, 201);
    const opp = await res.json();
    assert.equal(opp.title, "Deal satellite");
    assert.equal(opp.amount, 1500.5);
    assert.equal(opp.contactEmail, "deal@example.test");

    const row = (await query(
      "SELECT amount FROM opportunities WHERE id = $1 AND site_id = $2", [opp.id, site.id]
    )).rows[0];
    assert.equal(Number(row.amount), 1500.5);
  });

  test("PUT /api/opportunities/:id aggiorna lo stage (200)", async () => {
    const created = await fetch(`${baseUrl}/api/opportunities`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ title: "Da aggiornare", email: "upd@example.test", stage: "nuovo" }),
    });
    const opp = await created.json();

    const res = await fetch(`${baseUrl}/api/opportunities/${opp.id}`, {
      method: "PUT",
      headers: auth(rwToken),
      body: JSON.stringify({ stage: "proposta", value: 2500 }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.stage, "proposta");
    assert.equal(updated.amount, 2500);
  });

  test("PUT su opportunità di un altro tenant → 404 (mai cross-tenant)", async () => {
    const foreign = (await query(
      "INSERT INTO opportunities (site_id, contact_email, title, stage) VALUES ($1,$2,$3,$4) RETURNING id",
      [otherSite.id, "other@example.test", "Altro tenant", "nuovo"]
    )).rows[0];
    const res = await fetch(`${baseUrl}/api/opportunities/${foreign.id}`, {
      method: "PUT",
      headers: auth(rwToken),
      body: JSON.stringify({ title: "hijack" }),
    });
    assert.equal(res.status, 404);
  });

  test("token read-only → 403 token_scope_required su tutte le scritture", async () => {
    for (const [method, path, body] of [
      ["POST", "/api/opportunities", { title: "x", email: "x@example.test" }],
      ["PUT", "/api/opportunities/1", { title: "y" }],
      ["POST", "/api/contacts", { email: "c@example.test" }],
      ["PUT", "/api/contacts/1", { status: "attivo" }],
    ]) {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: auth(roToken), body: JSON.stringify(body) });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal((await res.json()).error, "token_scope_required");
    }
  });

  test("POST /api/contacts crea contatto; duplicato → 409 con contact_id", async () => {
    const email = `contatto-${Date.now()}@example.test`;
    const first = await fetch(`${baseUrl}/api/contacts`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ email, name: "Mario Rossi", tags: ["customer"], status: "attivo" }),
    });
    assert.equal(first.status, 201);
    const contact = await first.json();
    assert.equal(contact.email, email);
    assert.ok(contact.id);

    const dup = await fetch(`${baseUrl}/api/contacts`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ email, name: "Mario Rossi" }),
    });
    assert.equal(dup.status, 409);
    const dupBody = await dup.json();
    assert.equal(dupBody.error, "contact_exists");
    assert.equal(dupBody.contact_id, contact.id);
  });

  test("PUT /api/contacts/:id aggiorna i tag (200); input non valido → 400", async () => {
    const email = `upd-${Date.now()}@example.test`;
    const created = await fetch(`${baseUrl}/api/contacts`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ email, name: "Luca Bianchi" }),
    });
    const contact = await created.json();

    const ok = await fetch(`${baseUrl}/api/contacts/${contact.id}`, {
      method: "PUT",
      headers: auth(rwToken),
      body: JSON.stringify({ status: "cliente", companyName: "Acme Srl" }),
    });
    assert.equal(ok.status, 200);
    const updated = await ok.json();
    assert.equal(updated.status, "cliente");
    assert.equal(updated.companyName, "Acme Srl");

    const bad = await fetch(`${baseUrl}/api/contacts`, {
      method: "POST",
      headers: auth(rwToken),
      body: JSON.stringify({ email: "nope", unexpected_field: true }),
    });
    assert.equal(bad.status, 400);

    const missing = await fetch(`${baseUrl}/api/contacts/${contact.id + 100000}`, {
      method: "PUT",
      headers: auth(rwToken),
      body: JSON.stringify({ status: "x" }),
    });
    assert.equal(missing.status, 404);
  });
});
