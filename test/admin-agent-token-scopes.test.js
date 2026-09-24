import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import serveRoutes from "../src/routes/serve.js";

// UI /admin/agent/token: il backend supporta scopes (read/write) e role_cap
// da tempo (services/api-tokens.js), ma il form non li esponeva — segnalato
// dall'utente. Qui si verifica che il POST del form (checkbox "scopes" +
// select "role_cap") arrivi effettivamente fino a createApiToken() e che il
// token creato porti i permessi scelti, non solo il default ["read"].
//
// res.render è sostituito con res.json (stesso trucco di altri test UI:
// evita di dipendere dal layout EJS completo, che non è oggetto di questa
// verifica) per leggere direttamente i `locals` passati alla view.
describe("UI /admin/agent/token: permessi (scopes + role_cap) dal form", () => {
  let site, superadmin, server, baseUrl, jwtToken;

  before(async () => {
    site = await createTestSite("Agent Token Scopes UI Test");
    superadmin = await createTestUser(site.id, "superadmin");
    const uv = (await query("SELECT token_version FROM users WHERE id = $1", [superadmin.id])).rows[0].token_version;
    jwtToken = jwt.sign(
      { sub: superadmin.id, email: superadmin.email, name: "Test Superadmin", role: "superadmin", site_id: superadmin.site_id, token_version: uv },
      config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" }
    );

    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use((req, res, next) => { res.render = (view, locals) => res.json(locals); next(); });
    app.use(serveRoutes);
    app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });

    await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); }); });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  // Un browser invia checkbox con lo stesso name ripetute (scopes=read&scopes=write),
  // non un valore unico "read,write" — URLSearchParams(obj) con un array la
  // stringificherebbe sbagliato, quindi costruiamo il body a mano.
  const postForm = (body) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      for (const val of (Array.isArray(v) ? v : [v])) params.append(k, val);
    }
    return fetch(`${baseUrl}/admin/agent/token`, {
      method: "POST",
      headers: { cookie: `token=${jwtToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
  };

  test("checkbox 'scopes=write' + select 'role_cap' arrivano al token creato", async () => {
    const res = await postForm({ name: "Agente con scrittura", expires_days: "30", scopes: ["read", "write"], role_cap: "admin" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.newToken, "un token deve essere stato creato");
    assert.deepEqual([...body.newToken.scopes].sort(), ["read", "write"], "entrambe le scope selezionate nel form devono finire sul token");
    assert.equal(body.newToken.roleCap, "admin", "il tetto ruolo scelto nel form deve finire sul token");

    const row = (await query("SELECT scopes, role_cap FROM api_tokens WHERE id = $1", [body.newToken.id])).rows[0];
    assert.deepEqual([...row.scopes].sort(), ["read", "write"]);
    assert.equal(row.role_cap, "admin");
  });

  test("senza checkbox 'scopes' selezionata (solo lettura) → token resta read-only", async () => {
    // Un browser NON invia una checkbox deselezionata: il body non conterrà
    // affatto 'scopes' in quel caso. Il default deve restare sola lettura,
    // mai un token senza scope o con scrittura implicita.
    const res = await postForm({ name: "Agente sola lettura", expires_days: "30" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.newToken.scopes, ["read"]);
    assert.equal(body.newToken.roleCap, null);
  });

  test("role_cap vuoto ('nessuno') → tetto ruolo NULL, non un valore invalido", async () => {
    const res = await postForm({ name: "Agente senza tetto", expires_days: "30", scopes: "write", role_cap: "" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.newToken.roleCap, null);
  });

  test("un solo utente non-superadmin riceve 403 (nessun bypass introdotto dal form permessi)", async () => {
    const collaboratore = await createTestUser(site.id, "collaboratore");
    const uv = (await query("SELECT token_version FROM users WHERE id = $1", [collaboratore.id])).rows[0].token_version;
    const collabJwt = jwt.sign(
      { sub: collaboratore.id, email: collaboratore.email, name: "Test Collab", role: "collaboratore", site_id: collaboratore.site_id, token_version: uv },
      config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" }
    );
    const res = await fetch(`${baseUrl}/admin/agent/token`, {
      method: "POST",
      headers: { cookie: `token=${collabJwt}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name: "x", expires_days: "30", scopes: "write", role_cap: "admin" }),
    });
    assert.equal(res.status, 403);
  });
});
