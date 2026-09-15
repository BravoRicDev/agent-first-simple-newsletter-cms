import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import bugReportsRoutes from "../src/routes/bug-reports.js";
import agentRouter from "../src/routes/agent.js";
import config from "../src/config.js";
import { resetTransporter } from "../src/services/email.js";

// SMTP nei test: stesso pattern di test/channel-limits.test.js. Senza questo,
// con le vere credenziali SMTP di produzione in .env, notifyStatusChange()
// aprirebbe connessioni TLS reali verso il relay SMTP reale (lente, e senza
// --test-force-exit il processo può restare appeso in attesa che si
// chiudano) invece di fallire subito con ECONNREFUSED come atteso qui.
config.smtpHost = "127.0.0.1";
resetTransporter();

describe("segnalazioni bug: CRUD self-service + admin, notifica email, esposizione MCP", () => {
  let site, admin, collaboratore, server, baseUrl, adminToken, collabToken;

  before(async () => {
    site = await createTestSite("Bug Reports Test");
    admin = await createTestUser(site.id, "admin");
    collaboratore = await createTestUser(site.id, "collaboratore");
    adminToken = (await createApiToken(admin.id, "admin test", 30)).token;
    collabToken = (await createApiToken(collaboratore.id, "collab test", 30)).token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(bugReportsRoutes);
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

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  test("POST /api/bug-reports: qualunque utente autenticato può aprirne una", async () => {
    const res = await fetch(`${baseUrl}/api/bug-reports`, {
      method: "POST", headers: { ...auth(collabToken), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Il pulsante salva non fa nulla", categoria: "ui" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "aperto");
    assert.equal(body.priority, "normale");
    assert.equal(body.description, "Il pulsante salva non fa nulla");
    assert.equal(body.user_id, collaboratore.id);
  });

  test("POST /api/bug-reports: description mancante → 400", async () => {
    const res = await fetch(`${baseUrl}/api/bug-reports`, {
      method: "POST", headers: { ...auth(collabToken), "Content-Type": "application/json" },
      body: JSON.stringify({ categoria: "ui" }),
    });
    assert.equal(res.status, 400);
  });

  test("GET /api/bug-reports/mine: vede solo le proprie, non deve essere catturata da /:id", async () => {
    await fetch(`${baseUrl}/api/bug-reports`, {
      method: "POST", headers: { ...auth(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "segnalazione dell'admin" }),
    });
    const res = await fetch(`${baseUrl}/api/bug-reports/mine`, { headers: auth(collabToken) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.length >= 1);
    assert.ok(body.data.every(r => r.user_id === collaboratore.id));
  });

  test("GET /api/bug-reports (lista globale): collaboratore → 403, admin → 200", async () => {
    const forbidden = await fetch(`${baseUrl}/api/bug-reports`, { headers: auth(collabToken) });
    assert.equal(forbidden.status, 403);

    const ok = await fetch(`${baseUrl}/api/bug-reports`, { headers: auth(adminToken) });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.total >= 2);
    assert.ok(body.data.some(r => r.user_id === collaboratore.id));
  });

  test("GET/PUT /api/bug-reports/:id: 404 se inesistente, 403 per collaboratore, admin può aggiornare status/priority/nota", async () => {
    const created = await (await fetch(`${baseUrl}/api/bug-reports`, {
      method: "POST", headers: { ...auth(collabToken), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "da aggiornare" }),
    })).json();

    const notFound = await fetch(`${baseUrl}/api/bug-reports/999999999`, { headers: auth(adminToken) });
    assert.equal(notFound.status, 404);

    const forbidden = await fetch(`${baseUrl}/api/bug-reports/${created.id}`, { headers: auth(collabToken) });
    assert.equal(forbidden.status, 403);

    const updateForbidden = await fetch(`${baseUrl}/api/bug-reports/${created.id}`, {
      method: "PUT", headers: { ...auth(collabToken), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "risolto" }),
    });
    assert.equal(updateForbidden.status, 403);

    const updated = await fetch(`${baseUrl}/api/bug-reports/${created.id}`, {
      method: "PUT", headers: { ...auth(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "risolto", priority: "alta", note_sviluppatore: "Risolto nel deploy di oggi" }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    assert.equal(updatedBody.status, "risolto");
    assert.equal(updatedBody.priority, "alta");
    assert.equal(updatedBody.note_sviluppatore, "Risolto nel deploy di oggi");
  });

  test("PUT /api/bug-reports/:id senza campi → 400", async () => {
    const created = await (await fetch(`${baseUrl}/api/bug-reports`, {
      method: "POST", headers: { ...auth(collabToken), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "vuota" }),
    })).json();
    const res = await fetch(`${baseUrl}/api/bug-reports/${created.id}`, {
      method: "PUT", headers: { ...auth(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test("stesse operazioni via /api/agent/bug-reports (percorso MCP): create + mine + lista admin", async () => {
    const created = await (await fetch(`${baseUrl}/api/agent/bug-reports`, {
      method: "POST", headers: { ...auth(collabToken), "Content-Type": "application/json" },
      body: JSON.stringify({ description: "via agente MCP" }),
    })).json();
    assert.equal(created.description, "via agente MCP");

    const mine = await (await fetch(`${baseUrl}/api/agent/bug-reports/mine`, { headers: auth(collabToken) })).json();
    assert.ok(mine.data.some(r => r.id === created.id));

    const forbidden = await fetch(`${baseUrl}/api/agent/bug-reports`, { headers: auth(collabToken) });
    assert.equal(forbidden.status, 403);

    const list = await fetch(`${baseUrl}/api/agent/bug-reports`, { headers: auth(adminToken) });
    assert.equal(list.status, 200);

    const updated = await fetch(`${baseUrl}/api/agent/bug-reports/${created.id}`, {
      method: "PUT", headers: { ...auth(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_lavorazione" }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).status, "in_lavorazione");
  });
});
