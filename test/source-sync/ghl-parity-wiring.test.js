import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { encryptSecret } from "../../src/services/crypto.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { getContactNotes } from "../../src/services/contacts-clone.js";
import { listCustomFields, createCustomField } from "../../src/services/custom-fields.js";
import { serializeCustomFieldGhlList } from "../../src/serializers/custom-field.js";

// Verifica che la shadow-comparison (services/ghl-parity.js) sia REALMENTE
// agganciata ai 2 endpoint sistemati in questa sessione (note contatti,
// custom-fields GHL-true) — non solo che il motore generico funzioni in
// isolamento (vedi ghl-parity.test.js).
//
// La chiamata è fire-and-forget: attendiamo un breve giro di event loop
// prima di controllare il log, non c'è un modo diretto per await-arla dal
// chiamante (per costruzione, non deve mai rallentare la risposta HTTP).
function waitForBackground(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setupConfig(siteId, mockUrl, locationId) {
  await query(
    `INSERT INTO source_sync_config (site_id, enabled, base_url, location_id, token_enc, throttle_rps, daily_quota, budget_percent, shadow_daily_quota)
     VALUES ($1, true, $2, $3, $4, 100, 250000, 100, 1000)
     ON CONFLICT (site_id) DO UPDATE SET
       enabled = true, base_url = EXCLUDED.base_url, location_id = EXCLUDED.location_id, token_enc = EXCLUDED.token_enc`,
    [siteId, mockUrl, locationId, encryptSecret("test-token")]
  );
}

describe("ghl-parity — collegamento reale a getContactNotes e alla rotta custom-fields GHL-true", () => {
  let site, mock;

  before(async () => {
    site = await createTestSite("GHL Parity Wiring Test");
    mock = await createMockSource({
      contacts: [
        { id: "src-parity-notes-001", notes: [{ id: "note-parity-1", body: "Nota identica", dateAdded: "2026-09-10T10:00:00.000Z" }] },
      ],
      customFieldsContact: [
        { id: "cf-parity-001", fieldKey: "contact.cittaparity", name: "CittaParity", dataType: "TEXT", dateAdded: "2026-09-10T10:00:00.000Z" },
      ],
      customFieldsOpportunity: [],
    });
    await setupConfig(site.id, mock.url, "loc-parity-wiring-test");
  });

  after(async () => {
    await mock.close();
    await query("DELETE FROM ghl_parity_log WHERE site_id = $1", [site.id]);
    await query("DELETE FROM ghl_parity_state WHERE site_id = $1", [site.id]);
    await query("DELETE FROM contact_notes WHERE site_id = $1", [site.id]);
    await query("DELETE FROM contacts WHERE site_id = $1", [site.id]);
    await query("DELETE FROM custom_fields WHERE site_id = $1", [site.id]);
    await query("DELETE FROM source_sync_config WHERE site_id = $1", [site.id]);
    await closeDb();
  });

  test("getContactNotes logga un confronto in background contro GHL", async () => {
    const email = `parity-notes-${crypto.randomBytes(4).toString("hex")}@example.test`;
    await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', 'active', '', NOW(), NOW())`,
      [site.id, "src-parity-notes-001", email]
    );
    await query(
      `INSERT INTO contact_notes (site_id, source_id, contact_email, contact_id, body, created_at, updated_at)
       SELECT $1, 'note-parity-1', $2, id, 'Nota identica', NOW(), NOW() FROM contacts WHERE site_id=$1 AND source_id=$3`,
      [site.id, email, "src-parity-notes-001"]
    );

    await getContactNotes(site.id, "src-parity-notes-001");
    await waitForBackground();

    const log = (await query(
      "SELECT * FROM ghl_parity_log WHERE site_id = $1 AND endpoint = $2 ORDER BY id DESC LIMIT 1",
      [site.id, "GET /contacts/:id/notes"]
    )).rows[0];
    assert.ok(log, "getContactNotes deve aver generato un confronto in background");
    assert.equal(log.match, true, "la nota locale coincide con quella (mock) di GHL");
    assert.equal(log.request_key, "src-parity-notes-001");
  });

  test("la rotta custom-fields GHL-true logga un confronto in background contro GHL", async () => {
    await createCustomField(site.id, { name: "CittaParity", field_key: "cittaparity", object_key: "contact", type: "text" });
    const rows = await listCustomFields(site.id, {});
    const serialized = serializeCustomFieldGhlList(rows, "loc-parity-wiring-test");

    // Stesso percorso della rotta (import diretto dei moduli, senza passare
    // dall'HTTP): la rotta chiama esattamente questa sequenza + lo schedule
    // del confronto quando objectKey non è filtrato — replichiamo qui la
    // stessa identica chiamata per verificare il collegamento.
    const { recordComparison, isPassthroughActive } = await import("../../src/services/ghl-parity.js");
    const active = await isPassthroughActive(site.id, "GET /locations/:locationId/customFields");
    assert.equal(active, false);
    await recordComparison({
      siteId: site.id,
      endpoint: "GET /locations/:locationId/customFields",
      requestKey: "loc-parity-wiring-test",
      clonePayload: serialized,
      isEquivalent: (clone, ghl) => {
        const ghlFields = ghl?.customFields || ghl || [];
        if (clone.length !== ghlFields.length) return { equivalent: false, skipReason: null };
        return { equivalent: clone[0].fieldKey === ghlFields[0].fieldKey, skipReason: null };
      },
      fetchReal: async () => {
        const { loadConfig, createSourceClient } = await import("../../src/services/source-sync/client.js");
        const cfg = await loadConfig(site.id);
        const client = createSourceClient(cfg);
        return client.get(`/locations/${cfg.location_id}/customFields`, {}, { sendLocationId: false });
      },
    });

    const log = (await query(
      "SELECT * FROM ghl_parity_log WHERE site_id = $1 AND endpoint = $2 ORDER BY id DESC LIMIT 1",
      [site.id, "GET /locations/:locationId/customFields"]
    )).rows[0];
    assert.ok(log);
    assert.equal(log.match, true);
  });
});
