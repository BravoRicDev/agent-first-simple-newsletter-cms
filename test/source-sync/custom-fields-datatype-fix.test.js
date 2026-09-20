import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { createMockSource } from "./helpers/mock-source.mjs";
import { createSourceClient } from "../../src/services/source-sync/client.js";
import * as customFieldsMapper from "../../src/services/source-sync/mappers/custom-fields.js";
import { listCustomFields } from "../../src/services/custom-fields.js";
import { serializeCustomFieldGhlList } from "../../src/serializers/custom-field.js";
import { compareCustomFieldsLists } from "../../src/routes/api-clone/custom-fields.js";

// Regression guard: il motore di shadow-comparison (services/ghl-parity.js)
// ha rilevato dal vivo in produzione che mapFieldType() in mappers/
// custom-fields.js non riconosceva i dataType REALI di GHL "RADIO",
// "SINGLE_OPTIONS" e "NUMERICAL" (usava un dialetto storico mai verificato:
// NUMBER/DROPDOWN/MULTISELECT), facendoli cadere tutti sul default "text" —
// 19 campi su un account reale avevano dataType disallineato. "MONETORY"
// resta invece un'approssimazione VOLUTA (nessun tipo locale equivalente,
// vedi serializers/custom-field.js): il comparatore della rotta GHL-true
// deve tollerarla, non è un mismatch.

const uuid = () => crypto.randomUUID();

describe("custom-fields: mapping dataType reali (RADIO/SINGLE_OPTIONS/NUMERICAL) + tolleranza MONETORY nella parità", () => {
  let site, mock, client, cfg;
  const cfRadio = uuid();
  const cfSingleOptions = uuid();
  const cfNumerical = uuid();
  const cfMonetory = uuid();

  before(async () => {
    site = await createTestSite("Custom Fields DataType Fix");
    mock = await createMockSource({
      customFieldsContact: [
        { id: cfRadio, fieldKey: "contact.scelta_radio", name: "Scelta radio", dataType: "RADIO", dateAdded: "2026-01-01T00:00:00.000Z", picklistOptions: [{ id: "a", name: "A" }] },
        { id: cfSingleOptions, fieldKey: "contact.scelta_singola", name: "Scelta singola", dataType: "SINGLE_OPTIONS", dateAdded: "2026-01-01T00:00:00.000Z", picklistOptions: [{ id: "b", name: "B" }] },
        { id: cfNumerical, fieldKey: "contact.importo_numerico", name: "Importo numerico", dataType: "NUMERICAL", dateAdded: "2026-01-01T00:00:00.000Z" },
        { id: cfMonetory, fieldKey: "contact.importo_pagato", name: "Importo pagato", dataType: "MONETORY", dateAdded: "2026-01-01T00:00:00.000Z" },
      ],
      customFieldsOpportunity: [],
    });
    cfg = {
      site_id: site.id,
      base_url: mock.url,
      location_id: "loc-cf-datatype-fix",
      company_id: "company-test",
      token: "test-token",
      throttle_rps: 200,
      daily_quota: 1000000,
      budget_percent: 30,
    };
    client = createSourceClient(cfg);
  });

  after(async () => {
    await mock.close();
    await query("DELETE FROM custom_fields WHERE site_id = $1", [site.id]);
    await closeDb();
  });

  test("syncAll mappa i dataType REALI di GHL sui tipi locali corretti (RADIO->radio, SINGLE_OPTIONS->select, NUMERICAL->number)", async () => {
    const stats = {};
    const addStat = (res, key, n = 1) => {
      stats[res] = stats[res] || { fetched: 0, upserted: 0, updated: 0, skipped: 0, errors: 0 };
      stats[res][key] = (stats[res][key] || 0) + n;
    };
    const ctx = { siteId: site.id, cfg, client, dryRun: false, stats, addStat, log: () => {} };

    await customFieldsMapper.syncAll(ctx);
    assert.equal(stats["custom-fields"].upserted, 4);

    const rows = (await query(
      "SELECT field_key, type FROM custom_fields WHERE site_id = $1 ORDER BY field_key",
      [site.id]
    )).rows;
    const byKey = Object.fromEntries(rows.map((r) => [r.field_key, r.type]));
    assert.equal(byKey["scelta_radio"], "radio", "RADIO deve mappare a 'radio', non al default 'text'");
    assert.equal(byKey["scelta_singola"], "select", "SINGLE_OPTIONS deve mappare a 'select', non al default 'text'");
    assert.equal(byKey["importo_numerico"], "number", "NUMERICAL (vocabolario reale) deve mappare a 'number' come NUMERIC/NUMBER");
    assert.equal(byKey["importo_pagato"], "text", "MONETORY resta 'text': approssimazione voluta, nessun tipo locale equivalente");
  });

  test("rotta GHL-true: dopo il fix, id+fieldKey+dataType coincidono con GHL per tutti i campi rappresentabili", async () => {
    const ghlRes = await client.get(`/locations/${cfg.location_id}/customFields`, {}, { sendLocationId: false });
    const ghlFields = ghlRes?.customFields || ghlRes || [];
    const rows = await listCustomFields(site.id, {});
    const clone = serializeCustomFieldGhlList(rows, cfg.location_id);

    const byId = Object.fromEntries(clone.map((f) => [f.id, f]));
    assert.equal(byId[cfRadio].dataType, "RADIO");
    assert.equal(byId[cfSingleOptions].dataType, "SINGLE_OPTIONS");
    assert.equal(byId[cfNumerical].dataType, "NUMERICAL");
    // MONETORY resta un mismatch di dataType ATTESO a livello di dato grezzo
    // (nessun tipo locale "currency"): lo tollera solo il comparatore della
    // rotta (compareCustomFieldsLists + APPROXIMATED_GHL_DATATYPES), testato
    // a parte in ghl-parity-wiring.test.js — qui verifichiamo solo che il
    // dato grezzo sia quello atteso (TEXT, non un valore a caso).
    assert.equal(byId[cfMonetory].dataType, "TEXT");
    assert.equal(ghlFields.find((f) => f.id === cfMonetory).dataType, "MONETORY");

    // Il comparatore della rotta (compareCustomFieldsLists) deve TOLLERARE
    // questo scarto (MONETORY approssimato a TEXT è un limite noto, non una
    // vera divergenza) e riportare comunque equivalent=true, a differenza di
    // un vero mismatch (es. fieldKey diverso) che deve continuare a fallire.
    const clonePayload = clone;
    const ghlPayload = { customFields: ghlFields };
    const result = compareCustomFieldsLists(clonePayload, ghlPayload);
    assert.equal(result.equivalent, true, "MONETORY approssimato a TEXT non deve bloccare la parità");

    const brokenGhl = { customFields: ghlFields.map((f) => (f.id === cfRadio ? { ...f, fieldKey: "contact.altro_fieldkey" } : f)) };
    const brokenResult = compareCustomFieldsLists(clonePayload, brokenGhl);
    assert.equal(brokenResult.equivalent, false, "una vera divergenza (fieldKey) deve continuare a essere rilevata");
  });
});
