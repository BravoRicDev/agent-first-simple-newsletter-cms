import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import formsRouter from "../src/routes/forms.js";

// Email univoca su un dominio con record MX reale (example.com): il form auto-
// iscrive via subscribeEmail → verifySubscriberEmail → checkMx (DNS). Un
// dominio senza MX (es. example.test, riservato ai test) blocca l'iscrizione.
// Uniche per run: il DB è condiviso e persistente tra run.
function validMxEmail(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}@example.com`;
}

// Copre la catena form -> CRM -> newsletter (auto opt-in) che attraversa
// tre file diversi (forms.js, contacts.js, newsletter.js) — il punto più
// probabile di rottura silenziosa quando si tocca uno solo dei tre.
describe("forms: submit -> contatto CRM -> auto-iscrizione newsletter condizionata al consenso", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("Forms CRM Test");
    await query("INSERT INTO newsletter_settings (site_id, smtp_host, from_email) VALUES ($1, 'smtp.test', 'noreply@test')", [site.id]);
    await query(
      `INSERT INTO forms (site_id, slug, name, fields, newsletter_optin_key)
       VALUES ($1, 'contatti', 'Contatti', $2, 'consenso')`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "consenso", label: "Newsletter", type: "checkbox", required: false },
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

  test("submit con checkbox spuntato crea il contatto E iscrive alla newsletter (pending)", async () => {
    const email = validMxEmail("mario");
    await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Mario Rossi", email, consenso: "1" }),
    });
    await new Promise(r => setTimeout(r, 200)); // upsertContact/subscribeEmail sono fire-and-forget

    const contact = (await query("SELECT email FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(contact, "il contatto deve essere stato creato");

    const sub = (await query("SELECT status FROM newsletter_subscribers WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(sub, "l'iscrizione newsletter deve essere stata creata");
    assert.equal(sub.status, "pending", "deve restare pending finché non conferma via email (doppio opt-in)");
  });

  test("submit senza spuntare il checkbox crea il contatto ma NON iscrive alla newsletter", async () => {
    const email = validMxEmail("luigi");
    await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Luigi Verdi", email }),
    });
    await new Promise(r => setTimeout(r, 200));

    const contact = (await query("SELECT email FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(contact);

    const sub = (await query("SELECT 1 FROM newsletter_subscribers WHERE site_id = $1 AND email = $2", [site.id, email])).rows;
    assert.equal(sub.length, 0);
  });

  test("un campo iniettato non presente nella definizione del form viene scartato (whitelist)", async () => {
    const email = validMxEmail("anna");
    await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Anna Bianchi", email, campo_non_definito: "iniezione" }),
    });

    const row = (await query("SELECT data FROM form_submissions WHERE site_id = $1 AND data->>'email' = $2", [site.id, email])).rows[0];
    assert.ok(row);
    assert.equal(row.data.campo_non_definito, undefined, "una chiave non definita nel form non deve essere salvata");
    assert.equal(row.data.nome, "Anna Bianchi");
  });

  test("submit AJAX con X-Requested-With riceve JSON, non un redirect 302", async () => {
    const email = validMxEmail("gina");
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: new URLSearchParams({ nome: "Gina Gialla", email }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  test("submit non-AJAX (browser classico) riceve redirect, non JSON", async () => {
    const email = validMxEmail("carla");
    const res = await fetch(`${baseUrl}/forms/${site.id}/contatti`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Carla Marrone", email }),
    });
    assert.equal(res.status, 302);
  });
});
