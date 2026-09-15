import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import formsRouter from "../src/routes/forms.js";

// Pagina di ringraziamento (redirect_url) configurata dal builder: il
// browser classico viene reindirizzato lì, i client AJAX la ricevono nel
// JSON. Il redirect configurato ha priorità su _redirect e referer.
describe("forms: redirect post-invio (pagina di ringraziamento)", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("Forms Redirect Test");
    await query(
      `INSERT INTO forms (site_id, slug, name, fields, redirect_url)
       VALUES ($1, 'contatti', 'Contatti', $2, '/grazie')`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
      ])]
    );
    await query(
      `INSERT INTO forms (site_id, slug, name, fields)
       VALUES ($1, 'semplice', 'Semplice', $2)`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
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

  test("browser classico con redirect_url configurato → 302 alla pagina di ringraziamento", async () => {
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Mario", email: "mario.redir@example.test" }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/grazie");
  });

  test("AJAX con redirect_url configurato → JSON con redirect", async () => {
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({ nome: "Luigi", email: "luigi.redir@example.test" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.redirect, "/grazie");
  });

  test("SICUREZZA: un _redirect esterno forgiato nel form NON sovrascrive la pagina configurata", async () => {
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Anna", email: "anna.redir@example.test", _redirect: "https://evil.example" }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/grazie", "la pagina configurata deve avere priorità");
  });

  test("form senza redirect_url: comportamento invariato (redirect al referer)", async () => {
    const res = await fetch(`${baseUrl}/forms/${site.id}/semplice`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": `${baseUrl}/pagina-form` },
      body: new URLSearchParams({ nome: "Carla", email: "carla.redir@example.test" }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `${baseUrl}/pagina-form`);
  });
});
