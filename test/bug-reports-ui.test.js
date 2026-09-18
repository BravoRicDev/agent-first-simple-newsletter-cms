import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import bugReportsRoutes from "../src/routes/bug-reports.js";
import { resetTransporter } from "../src/services/email.js";

// SMTP nei test: stesso pattern di test/bug-reports.test.js e
// test/channel-limits.test.js. Senza questo, con le vere credenziali SMTP
// di produzione in .env, notifyStatusChange() aprirebbe connessioni TLS
// reali verso il relay SMTP reale (lente) a ogni segnalazione creata/
// aggiornata, invece di fallire subito con ECONNREFUSED come atteso qui.
config.smtpHost = "127.0.0.1";
resetTransporter();

describe("UI segnalazioni bug (admin)", () => {
  let site, admin, collaboratore, server, baseUrl, adminJwt, collabJwt, adminApiToken, collabApiToken;

  before(async () => {
    site = await createTestSite("Bug Reports UI Test");
    admin = await createTestUser(site.id, "admin");
    collaboratore = await createTestUser(site.id, "collaboratore");

    // JWT per sessione cookie (come nell'admin-crawl.test.js)
    const adminUv = (await query("SELECT token_version FROM users WHERE id = $1", [admin.id])).rows[0].token_version;
    const collabUv = (await query("SELECT token_version FROM users WHERE id = $1", [collaboratore.id])).rows[0].token_version;

    adminJwt = jwt.sign(
      { sub: admin.id, email: admin.email, name: "Test Admin", role: "admin", site_id: admin.site_id, token_version: adminUv },
      config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" }
    );
    collabJwt = jwt.sign(
      { sub: collaboratore.id, email: collaboratore.email, name: "Test Collab", role: "collaboratore", site_id: collaboratore.site_id, token_version: collabUv },
      config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" }
    );

    // API token per le route /api/bug-reports (come in bug-reports.test.js)
    adminApiToken = (await createApiToken(admin.id, "admin test", 30, ["read", "write"])).token;
    collabApiToken = (await createApiToken(collaboratore.id, "collab test", 30, ["read", "write"])).token;

    const app = express();
    app.set("view engine", "ejs");
    app.set("views", new URL("../views", import.meta.url).pathname);
    app.use(cookieParser());
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(bugReportsRoutes);
    app.use((err, req, res, next) => {
      console.error("500 ERR:", err.message);
      res.status(500).json({ error: err.message });
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

  // Helper: GET con cookie JWT (sessione admin)
  const get = (path, token) => {
    return fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { cookie: `token=${token}`, "Accept": "text/html" },
    });
  };

  // Helper: POST /admin/bug-reports con cookie JWT (form UI)
  const post = (path, token, body) => {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { cookie: `token=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  };

  // Helper: POST /api/bug-reports con Authorization Bearer API token (creazione test)
  const postApi = (path, apiToken, body) => {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  // Helper: POST /admin/bug-reports/:id/update con cookie JWT
  const postUpdate = (path, token, body) => {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { cookie: `token=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    });
  };

  test("GET /admin/bug-reports con utente admin -> 200, mostra segnalazioni di TUTTI gli utenti e i controlli di update", async () => {
    await postApi("/api/bug-reports", adminApiToken, { description: "Segnalazione admin per test", categoria: "ui" });
    await postApi("/api/bug-reports", collabApiToken, { description: "Segnalazione collaboratore per test", categoria: "ui" });

    const res = await get("/admin/bug-reports", adminJwt);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes("Segnalazione admin per test"), "Dovrebbe mostrare la segnalazione dell'admin");
    assert.ok(html.includes("Segnalazione collaboratore per test"), "Dovrebbe mostrare la segnalazione del collaboratore");
    assert.ok(html.includes("name=\"status\""), "Dovrebbe avere il select status");
    assert.ok(html.includes("name=\"priority\""), "Dovrebbe avere il select priority");
    assert.ok(html.includes("name=\"note_sviluppatore\""), "Dovrebbe avere il campo nota_sviluppatore");
    assert.ok(html.includes("Aggiorna"), "Dovrebbe avere il bottone Aggiorna");
  });

  test("GET /admin/bug-reports con utente collaboratore -> 200, ma NON deve contenere segnalazioni di ALTRI utenti", async () => {
    await postApi("/api/bug-reports", adminApiToken, { description: "Segnalazione admin privata", categoria: "ui" });
    await postApi("/api/bug-reports", collabApiToken, { description: "Segnalazione collaboratore privata", categoria: "ui" });

    const res = await get("/admin/bug-reports", collabJwt);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes("Segnalazione collaboratore privata"), "Dovrebbe mostrare la propria segnalazione");
    assert.ok(!html.includes("Segnalazione admin privata"), "NON dovrebbe mostrare la segnalazione di un altro utente");
    assert.ok(!html.includes("name=\"status\""), "NON dovrebbe avere il select status per collaboratore");
    assert.ok(!html.includes("name=\"priority\""), "NON dovrebbe avere il select priority per collaboratore");
    assert.ok(!html.includes("name=\"note_sviluppatore\""), "NON dovrebbe avere il campo nota_sviluppatore per collaboratore");
    assert.ok(!html.includes("Aggiorna"), "NON dovrebbe avere il bottone Aggiorna per collaboratore");
  });

  test("POST /admin/bug-reports con un utente qualunque crea una nuova segnalazione", async () => {
    await post("/admin/bug-reports", collabJwt, { description: "Nuova segnalazione dal form UI", categoria: "performance" });

    const res = await get("/admin/bug-reports", adminJwt);
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.ok(html.includes("Nuova segnalazione dal form UI"), "La nuova segnalazione dovrebbe comparire nella lista admin");
    assert.ok(html.includes("performance"), "Dovrebbe avere la categoria performance");
  });

  test("POST /admin/bug-reports/:id/update con utente collaboratore -> 403", async () => {
    const resp = await postApi("/api/bug-reports", collabApiToken, { description: "da aggiornare", categoria: "ui" });
    const created = await resp.json();
    assert.ok(created.id, "Il report creato dovrebbe avere un id");

    const res = await postUpdate(`/admin/bug-reports/${created.id}/update`, collabJwt, {
      status: "in_lavorazione", priority: "alta", note_sviluppatore: "Nota collaboratore",
    });
    assert.equal(res.status, 403, "Il collaboratore non dovrebbe poter aggiornare le segnalazioni");
  });

  test("POST /admin/bug-reports/:id/update con utente admin -> redirect/200 e stato aggiornato", async () => {
    const resp = await postApi("/api/bug-reports", adminApiToken, { description: "da aggiornare", categoria: "ui" });
    const created = await resp.json();
    assert.ok(created.id, "Il report creato dovrebbe avere un id");

    const res = await postUpdate(`/admin/bug-reports/${created.id}/update`, adminJwt, {
      status: "risolto", priority: "alta", note_sviluppatore: "Risolto nella release corrente",
    });
    assert.ok(res.status === 200 || res.status === 302, `Admin dovrebbe ottenere 200 o redirect, got ${res.status}`);

    const getRes = await get("/admin/bug-reports", adminJwt);
    const html = await getRes.text();
    assert.ok(html.includes("risolto"), "Lo stato dovrebbe risultare 'risolto'");
    // Senza apostrofo: <%= %> di EJS esegue html-escape (l'apostrofo
    // diventerebbe &#39;), un confronto letterale con l'apostrofo
    // fallirebbe pur essendo il rendering corretto/sicuro.
    assert.ok(html.includes("Risolto nella release corrente"), "La nota sviluppatore dovrebbe essere visibile");
  });

  test("GET /admin/bug-reports con ?error=1 mostra banner alert", async () => {
    const res = await get("/admin/bug-reports?error=1", adminJwt);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('class="alert"'), "Dovrebbe mostrare il banner alert");
    assert.ok(html.includes("Attenzione"), "Dovrebbe contenere un messaggio di avviso");
  });
});