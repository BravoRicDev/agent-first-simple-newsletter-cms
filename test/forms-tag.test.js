import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import formsRouter from "../src/routes/forms.js";

// Copre la catena form -> CRM -> tag contatto (newsletter_tag_key): le
// sequenze/campagne con target_tag partono solo se il contatto ha il tag.
// File separato da forms-crm.test.js perché il rate limiter dei form è
// condiviso tra le richieste dello stesso processo (max 5/min per IP).
describe("forms: submit -> tag contatto (newsletter_tag_key)", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("Forms Tag Test");
    await query(
      `INSERT INTO forms (site_id, slug, name, fields, newsletter_tag_key)
       VALUES ($1, 'lead', 'Lead', $2, 'settore')`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "settore", label: "Settore", type: "select", options: ["01-ferramenta", "02-idraulica"] },
      ])]
    );
    await query(
      `INSERT INTO forms (site_id, slug, name, fields, newsletter_tag_key, newsletter_tag_value)
       VALUES ($1, 'demo', 'Demo', $2, 'info_demo', 'demo')`,
      [site.id, JSON.stringify([
        { key: "nome", label: "Nome", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "info_demo", label: "Voglio provare la demo", type: "checkbox" },
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

  async function tagsFor(email) {
    const row = (await query("SELECT tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    return row ? row.tags : null;
  }

  test("select valorizzato senza tag fisso → il tag è il valore scelto", async () => {
    await fetch(`${baseUrl}/forms/${site.id}/lead`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Mario Rossi", email: "mario.tag@example.test", settore: "01-ferramenta" }),
    });
    await new Promise(r => setTimeout(r, 200));
    const tags = await tagsFor("mario.tag@example.test");
    assert.ok(tags && tags.includes("01-ferramenta"), `atteso tag 01-ferramenta, trovato ${JSON.stringify(tags)}`);
  });

  test("stesso form compilato due volte → il tag non si duplica", async () => {
    const email = "luigi.tag@example.test";
    for (let i = 0; i < 2; i++) {
      await fetch(`${baseUrl}/forms/${site.id}/lead`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ nome: "Luigi Verdi", email, settore: "02-idraulica" }),
      });
    }
    await new Promise(r => setTimeout(r, 200));
    const tags = await tagsFor(email);
    const count = tags.filter(t => t === "02-idraulica").length;
    assert.equal(count, 1, `il tag deve comparire una sola volta, trovato ${count} volte`);
  });

  test("checkbox spuntato con tag fisso → assegna il tag fisso", async () => {
    await fetch(`${baseUrl}/forms/${site.id}/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Anna Bianchi", email: "anna.tag@example.test", info_demo: "1" }),
    });
    await new Promise(r => setTimeout(r, 200));
    const tags = await tagsFor("anna.tag@example.test");
    assert.ok(tags && tags.includes("demo"), `atteso tag demo, trovato ${JSON.stringify(tags)}`);
  });

  test("checkbox NON spuntato → nessun tag", async () => {
    await fetch(`${baseUrl}/forms/${site.id}/demo`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ nome: "Carla Marrone", email: "carla.tag@example.test" }),
    });
    await new Promise(r => setTimeout(r, 200));
    const tags = await tagsFor("carla.tag@example.test");
    assert.deepEqual(tags, [], `atteso nessun tag, trovato ${JSON.stringify(tags)}`);
  });
});
