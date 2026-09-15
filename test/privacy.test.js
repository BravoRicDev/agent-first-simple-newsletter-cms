import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { upsertContact, setContactFields } from "../src/services/contacts.js";
import { scheduleCallManually } from "../src/services/calls.js";
import { exportContactData, eraseContactData } from "../src/services/privacy.js";

describe("GDPR: export e cancellazione dati di un contatto sparsi su più tabelle", () => {
  let site;
  const email = "gdpr-test@example.test";

  before(async () => {
    site = await createTestSite("Privacy Test");

    // dati sparsi come nella realtà: un form, un contatto con tag/note, una
    // chiamata, un'iscrizione newsletter
    await query("INSERT INTO forms (site_id, slug, name, fields) VALUES ($1, 'contatti', 'Contatti', $2)", [
      site.id, JSON.stringify([{ key: "email", label: "Email", type: "email", required: true }]),
    ]);
    await query("INSERT INTO form_submissions (site_id, form_slug, data) VALUES ($1, 'contatti', $2)", [
      site.id, JSON.stringify({ email, messaggio: "Ciao" }),
    ]);
    await upsertContact(site.id, email);
    await setContactFields(site.id, email, { tags: ["vip"], status: "lead", notes: "nota privata", value_estimate: 100 });
    await scheduleCallManually(site.id, { email, name: "Test", start: new Date(Date.now() + 86400000), durationMinutes: 30 });
    await query(
      "INSERT INTO newsletter_subscribers (site_id, email, status, token) VALUES ($1, $2, 'confirmed', 'tok-gdpr-test')",
      [site.id, email]
    );
  });

  after(async () => { await closeDb(); });

  test("exportContactData raccoglie i dati da tutte le tabelle", async () => {
    const data = await exportContactData(site.id, email);
    assert.equal(data.email, email);
    assert.equal(data.contact.tags.includes("vip"), true);
    assert.equal(data.form_submissions.length, 1);
    assert.equal(data.form_submissions[0].data.messaggio, "Ciao");
    assert.equal(data.calls.length, 1);
    assert.ok(data.newsletter_subscription);
    assert.equal(data.newsletter_subscription.status, "confirmed");
  });

  test("eraseContactData cancella davvero da tutte le tabelle", async () => {
    const deleted = await eraseContactData(site.id, email);
    assert.equal(deleted.form_submissions, 1);
    assert.equal(deleted.calls, 1);
    assert.equal(deleted.contact, 1);
    assert.equal(deleted.newsletter_subscriber, 1);

    const remaining = await Promise.all([
      query("SELECT 1 FROM form_submissions WHERE site_id = $1 AND data->>'email' = $2", [site.id, email]),
      query("SELECT 1 FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email]),
      query("SELECT 1 FROM calls WHERE site_id = $1 AND email = $2", [site.id, email]),
      query("SELECT 1 FROM newsletter_subscribers WHERE site_id = $1 AND email = $2", [site.id, email]),
    ]);
    assert.ok(remaining.every(r => r.rows.length === 0), "non deve restare nessuna riga in nessuna tabella");
  });

  test("dopo la cancellazione, l'export è vuoto (nessun errore su contatto inesistente)", async () => {
    const data = await exportContactData(site.id, email);
    assert.equal(data.form_submissions.length, 0);
    assert.equal(data.calls.length, 0);
    assert.equal(data.newsletter_subscription, null);
  });
});
