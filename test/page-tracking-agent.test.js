import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// GET/PUT /api/agent/sites/:siteId/pages/:pageId/tracking — override tracking
// opzionale per singola pagina (pixel/PageView/Lead), tri-state (null =
// eredita dal sito). Stesso pattern di auth (token API agent:true) degli
// altri test agent — vedi calendars-agent.test.js.
describe("agent: override tracking per-pagina", () => {
  let site, user, otherSite, server, baseUrl, token, page, otherPage;

  before(async () => {
    site = await createTestSite("Agent Page Tracking Test");
    otherSite = await createTestSite("Agent Page Tracking Other Site");
    user = await createTestUser(site.id, "admin");
    page = (await query(
      "INSERT INTO pages (site_id, url_path, title, published) VALUES ($1, '/tracking-test', 'Pagina', true) RETURNING id",
      [site.id]
    )).rows[0];
    otherPage = (await query(
      "INSERT INTO pages (site_id, url_path, title, published) VALUES ($1, '/altro-sito', 'Altra', true) RETURNING id",
      [otherSite.id]
    )).rows[0];
    const created = await createApiToken(user.id, "agent page tracking test", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);

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

  test("GET senza override: nessun campo impostato (eredita) — undefined omessi dal JSON", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/tracking`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    // getPageTrackingOverride({}) → tutti i campi undefined → JSON.stringify
    // li omette: il body è {} (non {pixelEnabled:null,...}). Nessuno dei 3
    // campi deve valere true/false: tutti "assente" = eredita dal sito.
    assert.equal(body.pixelEnabled, undefined);
    assert.equal(body.trackPageview, undefined);
    assert.equal(body.trackLead, undefined);
  });

  test("PUT imposta un override parziale, GET lo restituisce", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/tracking`, {
      method: "PUT", headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ pixelEnabled: false, trackLead: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pixelEnabled, false);
    assert.equal(body.trackPageview, null, "campo non inviato: resta eredita");
    assert.equal(body.trackLead, true);

    const getRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/tracking`, { headers: auth() });
    const getBody = await getRes.json();
    assert.deepEqual(getBody, body, "GET dopo PUT coerente");
  });

  test("PUT con null esplicito resetta a eredita", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/tracking`, {
      method: "PUT", headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ pixelEnabled: null }),
    });
    const body = await res.json();
    assert.equal(body.pixelEnabled, null, "resettato");
    assert.equal(body.trackLead, true, "campo non toccato in questa chiamata: resta come prima");
  });

  test("pagina inesistente: 404", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/999999999/tracking`, { headers: auth() });
    assert.equal(res.status, 404);
  });

  test("IDOR guard: pagina di un altro sito → 404 (non deve essere raggiungibile/scrivibile passando siteId proprio)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${otherPage.id}/tracking`, { headers: auth() });
    assert.equal(res.status, 404, "la pagina non appartiene al sito indicato");
  });

  test("senza token: 401", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${page.id}/tracking`);
    assert.equal(res.status, 401);
  });
});
