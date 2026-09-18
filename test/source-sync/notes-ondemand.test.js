import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { encryptSecret } from "../../src/services/crypto.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { getContactNotes } from "../../src/services/contacts-clone.js";

// Regression guard SINTOMO-NOTE-CLONE.md: un contatto già sincronizzato e
// recente (dateUpdated non vecchio) può avere 0 note locali perché il fix
// delle note può essere arrivato dopo l'ultimo sync di QUEL contatto — un
// gap che il sync periodico non ripara da solo. getContactNotes ora tenta
// un sync on-demand SOLO quando la lettura locale è sospetta (0 note) e
// solo se l'ultimo tentativo per quel contatto è più vecchio di 20 minuti.

async function setupConfig(siteId, mockUrl) {
  await query(
    // shadow_daily_quota = 0: questo file testa SOLO il refresh on-demand
    // (refreshContactNotesOnDemand), non la shadow-comparison di parità
    // (services/ghl-parity.js, vedi ghl-parity.test.js/ghl-parity-wiring.test.js
    // per quella). getContactNotes schedula ANCHE un confronto di parità in
    // background ad ogni chiamata: senza azzerare qui il suo budget,
    // inquinerebbe mock.calls con chiamate asincrone extra che i test qui
    // sotto non si aspettano, rendendo gli assert su callsBefore/callsAfter
    // intermittenti in base al timing del fire-and-forget.
    `INSERT INTO source_sync_config (site_id, enabled, base_url, location_id, token_enc, throttle_rps, daily_quota, budget_percent, shadow_daily_quota)
     VALUES ($1, true, $2, $3, $4, 100, 250000, 100, 0)
     ON CONFLICT (site_id) DO UPDATE SET
       enabled = true, base_url = EXCLUDED.base_url, location_id = EXCLUDED.location_id,
       token_enc = EXCLUDED.token_enc, shadow_daily_quota = 0`,
    [siteId, mockUrl, "loc-notes-ondemand-test", encryptSecret("test-token")]
  );
}

async function insertContact(siteId, sourceId, { notesyncedAt = null } = {}) {
  const email = `ondemand-${crypto.randomBytes(4).toString("hex")}@example.test`;
  const row = (await query(
    `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, notes_synced_at, created_at, updated_at)
     VALUES ($1, $2, $3, '{}', 'active', '', $4, NOW(), NOW()) RETURNING *`,
    [siteId, sourceId, email, notesyncedAt]
  )).rows[0];
  return row;
}

describe("getContactNotes — sync on-demand con throttle 20 minuti (SINTOMO-NOTE-CLONE.md)", () => {
  let site, mock;

  before(async () => {
    site = await createTestSite("Notes OnDemand Test");
    mock = await createMockSource({
      contacts: [
        {
          id: "src-ondemand-001",
          notes: [
            { id: "note-a", body: "Prima nota reale su GHL", authorType: "human", authorName: "Op1", dateAdded: "2026-09-10T10:00:00.000Z" },
            { id: "note-b", body: "Seconda nota reale su GHL", authorType: "human", authorName: "Op2", dateAdded: "2026-09-11T10:00:00.000Z" },
          ],
        },
        { id: "src-throttled-001", notes: [{ id: "note-c", body: "Non deve arrivare, throttle attivo", dateAdded: "2026-09-10T10:00:00.000Z" }] },
        { id: "src-stale-001", notes: [{ id: "note-d", body: "Deve arrivare, ultimo tentativo vecchio", dateAdded: "2026-09-10T10:00:00.000Z" }] },
      ],
    });
    await setupConfig(site.id, mock.url);
  });

  after(async () => {
    await mock.close();
    await query("DELETE FROM contact_notes WHERE site_id = $1", [site.id]);
    await query("DELETE FROM contacts WHERE site_id = $1", [site.id]);
    await query("DELETE FROM source_sync_config WHERE site_id = $1", [site.id]);
    await closeDb();
  });

  test("contatto sincronizzato ma con 0 note locali → sync on-demand, note recuperate da GHL", async () => {
    const contact = await insertContact(site.id, "src-ondemand-001");
    const callsBefore = mock.calls.filter((c) => c.path === "/contacts/src-ondemand-001/notes").length;

    const notes = await getContactNotes(site.id, "src-ondemand-001");
    assert.equal(notes.length, 2, "le 2 note reali devono essere recuperate on-demand");
    assert.ok(notes.some((n) => n.body === "Prima nota reale su GHL"));
    assert.ok(notes.some((n) => n.body === "Seconda nota reale su GHL"));

    const callsAfter = mock.calls.filter((c) => c.path === "/contacts/src-ondemand-001/notes").length;
    assert.equal(callsAfter - callsBefore, 1, "una sola chiamata a GHL per il refresh");

    const refreshed = (await query("SELECT notes_synced_at FROM contacts WHERE id = $1", [contact.id])).rows[0];
    assert.ok(refreshed.notes_synced_at, "notes_synced_at aggiornato dopo il tentativo");
  });

  test("secondo giro sulla stessa scheda: le note sono già locali, NESSUNA nuova chiamata a GHL", async () => {
    const callsBefore = mock.calls.filter((c) => c.path === "/contacts/src-ondemand-001/notes").length;
    const notes = await getContactNotes(site.id, "src-ondemand-001");
    assert.equal(notes.length, 2);
    const callsAfter = mock.calls.filter((c) => c.path === "/contacts/src-ondemand-001/notes").length;
    assert.equal(callsAfter, callsBefore, "note già presenti localmente: nessun refresh, nessuna nuova chiamata");
  });

  test("throttle 20 minuti: tentativo recente (5 minuti fa) → NESSUNA nuova chiamata, note restano vuote", async () => {
    await insertContact(site.id, "src-throttled-001", {
      notesyncedAt: new Date(Date.now() - 5 * 60 * 1000),
    });
    const callsBefore = mock.calls.filter((c) => c.path === "/contacts/src-throttled-001/notes").length;

    const notes = await getContactNotes(site.id, "src-throttled-001");
    assert.equal(notes.length, 0, "throttle attivo: niente refresh, niente note");

    const callsAfter = mock.calls.filter((c) => c.path === "/contacts/src-throttled-001/notes").length;
    assert.equal(callsAfter, callsBefore, "nessuna chiamata a GHL entro i 20 minuti dal tentativo precedente");
  });

  test("throttle scaduto: ultimo tentativo 30 minuti fa → nuovo sync on-demand, note recuperate", async () => {
    await insertContact(site.id, "src-stale-001", {
      notesyncedAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const notes = await getContactNotes(site.id, "src-stale-001");
    assert.equal(notes.length, 1, "throttle scaduto: il refresh deve avvenire");
    assert.equal(notes[0].body, "Deve arrivare, ultimo tentativo vecchio");
  });

  test("sito senza source-sync configurato: nessun crash, nessuna nota, nessuna chiamata a GHL", async () => {
    const otherSite = await createTestSite("Notes OnDemand No Config");
    const contact = await insertContact(otherSite.id, "src-no-config-001");
    const callsBefore = mock.calls.length;

    const notes = await getContactNotes(otherSite.id, "src-no-config-001");
    assert.equal(notes.length, 0);
    assert.equal(mock.calls.length, callsBefore, "nessuna chiamata a GHL per un sito senza source-sync");

    await query("DELETE FROM contacts WHERE site_id = $1", [otherSite.id]);
  });
});
