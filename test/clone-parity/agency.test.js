import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda G: Agency/Users/Teams/Locations clone API — CRUD con contratto shape completo.
describe("Onda G — Agency clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let locationId;
  let userId;
  let teamId;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    // Auth dialetto moderno: Bearer api-key + locationId in query
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = await res.json();
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Agency Clone");
    apiKey = await mkKey(site.id, "test key");

    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── LOCATIONS ────────────────────────────────────────────────────────

  test("Location: create → list meta → get → PUT business-info", async () => {
    // Create location
    const createRes = await fetch("/locations", {
      method: "POST",
      body: JSON.stringify({ name: "Agenzia Roma", businessInfo: { city: "Roma" } }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.location);
    assert(createRes.data.location.id);
    assert(createRes.data.location.locationId);
    assert.equal(createRes.data.location.name, "Agenzia Roma");
    assert.equal(typeof createRes.data.location.businessInfo, "object");
    assert(createRes.data.location.dateAdded);
    locationId = createRes.data.location.id;

    // GET location by id
    const getRes = await fetch(`/locations/${locationId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.location.id, locationId);
    assert.equal(getRes.data.location.name, "Agenzia Roma");

    // PUT business-info
    const putRes = await fetch(`/locations/${locationId}/business-info`, {
      method: "PUT",
      body: JSON.stringify({ businessInfo: { city: "Roma", address: "Via del Corso" } }),
    });
    assert.equal(putRes.status, 200);
    assert(putRes.data.location.businessInfo);
    assert.equal(putRes.data.location.businessInfo.city, "Roma");
    assert.equal(putRes.data.location.businessInfo.address, "Via del Corso");
  });

  test("Location: 404 not found", async () => {
    const notFoundId = crypto.randomUUID();
    const res = await fetch(`/locations/${notFoundId}`);
    assert.equal(res.status, 404);
    assert.equal(res.data.statusCode, 404);
  });

  // ── USERS ────────────────────────────────────────────────────────────

  test("User: create → list meta → get → update → delete", async () => {
    // Create user
    const createRes = await fetch("/users", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Mario",
        lastName: "Rossi",
        email: `mario-${crypto.randomBytes(4).toString("hex")}@test.local`,
        roles: ["admin"],
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.user);
    assert(createRes.data.user.id);
    assert.equal(createRes.data.user.firstName, "Mario");
    assert.equal(createRes.data.user.lastName, "Rossi");
    assert(Array.isArray(createRes.data.user.roles));
    assert.equal(createRes.data.user.roles[0], "admin");
    assert(createRes.data.user.dateAdded);
    userId = createRes.data.user.id;

    // List users
    const listRes = await fetch("/users");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.users));
    assert(listRes.data.meta);
    assert(typeof listRes.data.meta.total === "number");
    assert(listRes.data.users.some((u) => u.id === userId));

    // GET user
    const getRes = await fetch(`/users/${userId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.user.id, userId);
    assert.equal(getRes.data.user.firstName, "Mario");

    // Update user
    const updateRes = await fetch(`/users/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ firstName: "Luigi", roles: ["collaboratore"] }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.user.firstName, "Luigi");
    assert.equal(updateRes.data.user.roles[0], "collaboratore");

    // Delete user
    const deleteRes = await fetch(`/users/${userId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Verify deleted
    const verifyRes = await fetch(`/users/${userId}`);
    assert.equal(verifyRes.status, 404);
  });

  test("User: search by email", async () => {
    const testEmail = `search-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const createRes = await fetch("/users", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Anna",
        lastName: "Bianchi",
        email: testEmail,
        roles: ["collaboratore"],
      }),
    });
    assert.equal(createRes.status, 201);

    const searchRes = await fetch("/users/search", {
      method: "POST",
      body: JSON.stringify({ email: testEmail }),
    });
    assert.equal(searchRes.status, 200);
    assert(Array.isArray(searchRes.data.users));
    assert(searchRes.data.users.some((u) => u.email === testEmail));
  });

  test("User: 404 not found", async () => {
    const notFoundId = crypto.randomUUID();
    const res = await fetch(`/users/${notFoundId}`);
    assert.equal(res.status, 404);
  });

  test("User: email obbligatoria", async () => {
    const res = await fetch("/users", {
      method: "POST",
      body: JSON.stringify({ firstName: "Mario", lastName: "Rossi" }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.statusCode, 400);
  });

  // Parity ghl_id: round-trip su utente (le location/team NON hanno ghl_id,
  // restano fuori scope).
  test("Parity ghl_id: round-trip GET/PUT/DELETE utente col ghl_id reale", async () => {
    const createRes = await fetch("/users", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Rt",
        lastName: "User",
        email: `rtuser-${crypto.randomBytes(4).toString("hex")}@test.local`,
        roles: ["collaboratore"],
      }),
    });
    assert.equal(createRes.status, 201);
    const created = createRes.data.user;
    assert.ok(created.id, "uuid assente");

    const realGhlId = "ghlUSERparity001";
    await query("UPDATE users SET ghl_id = $1 WHERE external_id = $2", [realGhlId, created.id]);

    const getRes = await fetch(`/users/${realGhlId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.user.id, realGhlId, "id risposta deve essere il ghl_id reale");

    const putRes = await fetch(`/users/${realGhlId}`, {
      method: "PUT",
      body: JSON.stringify({ firstName: "RtUpdated" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.user.firstName, "RtUpdated");

    const deleteRes = await fetch(`/users/${realGhlId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);

    const getAfterDel = await fetch(`/users/${realGhlId}`);
    assert.equal(getAfterDel.status, 404);
  });

  test("Parity ghl_id: id utente malformato (300 char) → 400", async () => {
    const res = await fetch(`/users/${"x".repeat(300)}`);
    assert.equal(res.status, 400);
  });

  // ── TEAMS ────────────────────────────────────────────────────────────

  test("Team: create con member → list meta → get → update members → delete", async () => {
    // Create user per il team
    const userRes = await fetch("/users", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Luigi",
        lastName: "Verdi",
        email: `luigi-${crypto.randomBytes(4).toString("hex")}@test.local`,
        roles: ["collaboratore"],
      }),
    });
    assert.equal(userRes.status, 201, `User creation failed: ${JSON.stringify(userRes.data)}`);
    const memberId = userRes.data.user.id;

    // Create team
    const createRes = await fetch("/teams", {
      method: "POST",
      body: JSON.stringify({
        name: "Sales Team",
        members: [{ userId: memberId, role: "member" }],
      }),
    });
    assert.equal(createRes.status, 201, `Team creation failed: ${JSON.stringify(createRes.data)}`);
    assert(createRes.data.team);
    assert(createRes.data.team.id);
    assert.equal(createRes.data.team.name, "Sales Team");
    assert(Array.isArray(createRes.data.team.members));
    assert.equal(createRes.data.team.members.length, 1);
    assert.equal(createRes.data.team.members[0].role, "member");
    assert(createRes.data.team.dateAdded);
    assert(createRes.data.team.dateUpdated);
    teamId = createRes.data.team.id;

    // List teams
    const listRes = await fetch("/teams");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.teams));
    assert(listRes.data.meta);
    assert(typeof listRes.data.meta.total === "number");
    assert(listRes.data.teams.some((t) => t.id === teamId));

    // GET team
    const getRes = await fetch(`/teams/${teamId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.team.id, teamId);
    assert.equal(getRes.data.team.name, "Sales Team");
    assert.equal(getRes.data.team.members.length, 1);

    // Update team name
    const updateRes = await fetch(`/teams/${teamId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "Marketing Team" }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.team.name, "Marketing Team");

    // Delete team
    const deleteRes = await fetch(`/teams/${teamId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Verify deleted
    const verifyRes = await fetch(`/teams/${teamId}`);
    assert.equal(verifyRes.status, 404);
  });

  test("Team: 404 not found", async () => {
    const notFoundId = crypto.randomUUID();
    const res = await fetch(`/teams/${notFoundId}`);
    assert.equal(res.status, 404);
  });

  test("Team: nome obbligatorio", async () => {
    const res = await fetch("/teams", {
      method: "POST",
      body: JSON.stringify({ members: [] }),
    });
    assert.equal(res.status, 400);
  });

  // ── Parity location id (round 15) ──────────────────────────────────────
  // sites NON ha colonna ghl_id: l'equivalente del "location id" di GHL è
  // location_external_id. Un'automazione n8n ha in mano QUEL id (20 char
  // alfanumerici, non UUID): deve poterlo usare in GET/PUT e vederlo
  // esposto come id/locazione in output. Prima di questo round:
  // - GET /locations/{idGHL} andava in ERRORE 500 (confronto uuid = testo
  //   non-UUID → 22P02) o 404 a seconda del formato;
  // - PUT business-info risolveva SOLO l'UUID interno del site.

  test("Parity location: id GHL reale (non-UUID) accettato in GET/PUT ed esposto", async () => {
    const createRes = await fetch("/locations", {
      method: "POST",
      body: JSON.stringify({ name: "Sede GHL parity" }),
    });
    assert.equal(createRes.status, 201);
    // NB: dopo il round 15 location.id ESPONE già il location_external_id
    // (per le location create da noi è un UUID generato in createLocation).
    const genLocationId = createRes.data.location.id;

    // UUID interno del site (colonna external_id) — preso dal DB, non dalla
    // risposta, che ora espone l'id pubblico GHL-facing.
    const siteUuid = (await query(
      "SELECT external_id::text AS ext FROM sites WHERE location_external_id = $1",
      [genLocationId]
    )).rows[0].ext;
    assert.ok(siteUuid, "site appena creato deve esistere");

    // Simuliamo una location SINCRONIZZATA da GHL: location_external_id =
    // id reale stile GHL (20 char alfanumerici, NON uuid-valid). Casuale
    // per run: sites.location_external_id ha un UNIQUE globale e il volume
    // di test persiste tra un'esecuzione e l'altra.
    const realGhlLocationId = "eMjq" + crypto.randomBytes(8).toString("hex");
    await query(
      "UPDATE sites SET location_external_id = $1 WHERE external_id = $2",
      [realGhlLocationId, siteUuid]
    );

    // GET col ghl_id reale → 200 (PRIMA: 500 per 22P02 su uuid=text) e
    // l'id esposto è il ghl_id reale, non l'UUID interno.
    const getRes = await fetch(`/locations/${realGhlLocationId}`);
    assert.equal(getRes.status, 200, "GET con location id GHL reale deve funzionare");
    assert.equal(getRes.data.location.id, realGhlLocationId, "id in output = ghl location id reale");
    assert.equal(getRes.data.location.locationId, realGhlLocationId);

    // PUT business-info col ghl_id reale (prima risolveva solo l'UUID)
    const putRes = await fetch(`/locations/${realGhlLocationId}/business-info`, {
      method: "PUT",
      body: JSON.stringify({ businessInfo: { city: "Milano" } }),
    });
    assert.equal(putRes.status, 200, "PUT business-info con ghl location id deve funzionare");
    assert.equal(putRes.data.location.businessInfo.city, "Milano");
    assert.equal(putRes.data.location.id, realGhlLocationId);

    // Anche l'UUID interno del site continua a risolvere (hot-swap non
    // regressivo per chi già lo usava).
    const byUuid = await fetch(`/locations/${siteUuid}`);
    assert.equal(byUuid.status, 200);
    assert.equal(byUuid.data.location.id, realGhlLocationId, "UUID interno risolve, id esposto resta il ghl");

    // Id inesistente ma ben formato → 404 (non 500)
    const missing = await fetch("/locations/ghlLocationIdMancante");
    assert.equal(missing.status, 404);
  });
});
