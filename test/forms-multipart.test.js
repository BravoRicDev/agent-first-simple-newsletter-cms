import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import formsRouter from "../src/routes/forms.js";

// I form integrati con fetch+FormData (landing moderne) arrivano come
// multipart/form-data: senza un parser multipart express.urlencoded non
// parsaa il body e il server risponde 400 "Nessun dato ricevuto" — il
// cliente mostra "Si è verificato un errore". Regressione coperta qui.
describe("forms: submit multipart (fetch + FormData)", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("Forms Multipart Test");
    await query(
      `INSERT INTO forms (site_id, slug, name, fields)
       VALUES ($1, 'contatti', 'Contatti', $2)`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "consenso", label: "Consenso", type: "checkbox" },
      ])]
    );

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(formsRouter);

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.close(); await closeDb(); });

  test("submit multipart (FormData, come il fetch delle landing) → 200 JSON ok e contatto creato", async () => {
    const fd = new FormData();
    fd.set("nome", "Mario Multipart");
    fd.set("email", "mario.multi@example.test");
    fd.set("consenso", "1");
    // fetch serializza FormData in multipart/form-data (header automatico)
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      headers: { "Accept": "application/json" },
      body: fd,
    });
    assert.equal(res.status, 200, "multipart deve essere parsato e accettato");
    const body = await res.json();
    assert.equal(body.ok, true);
    await new Promise(r => setTimeout(r, 200));

    const row = (await query(
      "SELECT 1 FROM form_submissions WHERE site_id = $1 AND data->>'email' = 'mario.multi@example.test'",
      [site.id]
    )).rows;
    assert.equal(row.length, 1, "l'invio multipart deve essere salvato in form_submissions");
    const contact = (await query(
      "SELECT 1 FROM contacts WHERE site_id = $1 AND email = 'mario.multi@example.test'",
      [site.id]
    )).rows;
    assert.equal(contact.length, 1, "il contatto deve essere creato dal submit multipart");
  });

  test("submit multipart con honeypot → ok silenzioso, nessun salvataggio", async () => {
    const fd = new FormData();
    fd.set("nome", "Bot");
    fd.set("email", "bot.multi@example.test");
    fd.set("_honeypot", "spam");
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      headers: { "Accept": "application/json" },
      body: fd,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    await new Promise(r => setTimeout(r, 200));
    const row = (await query(
      "SELECT 1 FROM form_submissions WHERE site_id = $1 AND data->>'email' = 'bot.multi@example.test'",
      [site.id]
    )).rows;
    assert.equal(row.length, 0, "l'honeypot deve bloccare anche in multipart");
  });

  test("submit urlencoded classico continua a funzionare (nessuna regressione)", async () => {
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Carla", email: "carla.url@example.test" }),
    });
    assert.equal(res.status, 302, "browser classico: redirect come prima");
  });
});
