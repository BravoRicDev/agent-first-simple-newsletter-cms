import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import formsRouter from "../src/routes/forms.js";

// ─────────────────────────────────────────────────────────────────────────
// Tracciamento UTM STANDARD (Meta/Google Ads): 5 parametri
//   utm_source / utm_medium / utm_campaign / utm_term / utm_content
// I provengono:
//   - dal widget {{form:slug}} come HIDDEN INPUT iniettati dal client (non
//     dichiarati nel builder) → la whitelist li accetta comunque;
//   - oppure come query param sull'URL del POST (?utm_*=...).
// Regola: PRIMA origine vince (COALESCE) e i dati sono persistiti su
// contacts + form_submissions.data.
// ─────────────────────────────────────────────────────────────────────────

describe("UTM standard su form e contatti", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("UTM Tracking Test");
    await query(
      `INSERT INTO forms (site_id, slug, name, fields)
       VALUES ($1, 'utmform', 'UTM Form', $2)`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
      ])]
    );

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(formsRouter);
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });

  test("hidden input UTM non dichiarati (standard) → salvati su contatto e submission", async () => {
    const body = new URLSearchParams({
      nome: "Uttore",
      email: "utm.first@example.test",
      // Campi NON dichiarati nel builder: devono passare la whitelist (utm_*).
      utm_source: "meta",
      utm_medium: "cpc",
      utm_campaign: "campagna-estate",
      utm_term: "scarpe+rosse",
      utm_content: "banner-top",
    });
    const res = await fetch(`${baseUrl}/forms/${site.id}/utmform`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    await new Promise((r) => setTimeout(r, 250));

    const sub = (await query(
      "SELECT data FROM form_submissions WHERE site_id=$1 AND data->>'email'='utm.first@example.test'",
      [site.id]
    )).rows[0];
    assert.ok(sub, "submission salvata");
    assert.equal(sub.data.utm_source, "meta");
    assert.equal(sub.data.utm_content, "banner-top");

    const contact = (await query(
      "SELECT utm_source, utm_medium, utm_campaign, utm_term, utm_content, first_source FROM contacts WHERE site_id=$1 AND email='utm.first@example.test'",
      [site.id]
    )).rows[0];
    assert.ok(contact, "contatto creato");
    assert.equal(contact.utm_source, "meta");
    assert.equal(contact.utm_medium, "cpc");
    assert.equal(contact.utm_campaign, "campagna-estate");
    assert.equal(contact.utm_term, "scarpe+rosse");
    assert.equal(contact.utm_content, "banner-top");
    assert.equal(contact.first_source, "meta", "first_source = prima origine");
  });

  test("prima origine vince: un secondo invio con UTM diversi non sovrascrive", async () => {
    const body = new URLSearchParams({
      nome: "Uttore",
      email: "utm.first@example.test",
      utm_source: "google",
      utm_medium: "organic",
      utm_campaign: "campagna-diversa",
      utm_term: "parola2",
      utm_content: "banner-bottom",
    });
    const res = await fetch(`${baseUrl}/forms/${site.id}/utmform`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 250));

    const contact = (await query(
      "SELECT utm_source, utm_medium, utm_campaign, utm_term, utm_content FROM contacts WHERE site_id=$1 AND email='utm.first@example.test'",
      [site.id]
    )).rows[0];
    assert.equal(contact.utm_source, "meta", "prima origine (meta) mantiene");
    assert.equal(contact.utm_medium, "cpc");
    assert.equal(contact.utm_campaign, "campagna-estate");
    assert.equal(contact.utm_term, "scarpe+rosse");
    assert.equal(contact.utm_content, "banner-top");
  });

  test("query param sull'URL del POST (fallback server-side) → catturato", async () => {
    const body = new URLSearchParams({ nome: "Q", email: "utm.q@example.test" });
    const res = await fetch(`${baseUrl}/forms/${site.id}/utmform?utm_source=google&utm_campaign=ads-q&utm_term=t1`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
      body,
    });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 250));
    const contact = (await query(
      "SELECT utm_source, utm_campaign, utm_term FROM contacts WHERE site_id=$1 AND email='utm.q@example.test'",
      [site.id]
    )).rows[0];
    assert.ok(contact);
    assert.equal(contact.utm_source, "google");
    assert.equal(contact.utm_campaign, "ads-q");
    assert.equal(contact.utm_term, "t1");
  });
});