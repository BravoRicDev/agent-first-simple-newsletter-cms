import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken, verifyApiToken, revokeApiToken, isApiTokenFormat } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";

describe("token API di lunga durata: creazione, verifica, revoca, integrazione con requireAuth", () => {
  let site, user, server, baseUrl;

  before(async () => {
    site = await createTestSite("API Tokens Test");
    user = await createTestUser(site.id, "admin");

    const app = express();
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.get("/api/whoami", requireAuth, (req, res) => res.json({ user: req.user }));

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.close(); await closeDb(); });

  test("il token generato ha il prefisso atteso ed è riconosciuto come tale", async () => {
    const created = await createApiToken(user.id, "test token", 30);
    assert.ok(isApiTokenFormat(created.token));
    assert.ok(created.token.startsWith("agtok_"));
  });

  test("requireAuth accetta un token valido via header Authorization", async () => {
    const created = await createApiToken(user.id, "http test", 30);
    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { Authorization: `Bearer ${created.token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, user.email);
    assert.equal(body.user.agent, true, "un token API deve comportarsi come un agente (accesso alle route /api/agent)");
  });

  test("un token inventato viene rifiutato (401)", async () => {
    const res = await fetch(`${baseUrl}/api/whoami`, { headers: { Authorization: "Bearer agtok_" + "0".repeat(64) } });
    assert.equal(res.status, 401);
  });

  test("un token revocato smette immediatamente di funzionare", async () => {
    const created = await createApiToken(user.id, "revoke test", 30);
    assert.ok(await verifyApiToken(created.token));

    await revokeApiToken(user.id, created.id);
    assert.equal(await verifyApiToken(created.token), null);
  });

  test("revocare il token di un altro utente non ha effetto (IDOR)", async () => {
    const otherUser = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "isolato", 30);

    await revokeApiToken(otherUser.id, created.id); // tenta di revocare un token non suo
    assert.ok(await verifyApiToken(created.token), "il token del legittimo proprietario deve restare valido");
  });
});
