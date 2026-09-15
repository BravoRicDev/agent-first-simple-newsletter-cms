import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { ensureExternalId, getExternalId, findByExternalId } from "../src/services/external-ids.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("external-ids — UUID esterni lazy per-risorsa", () => {
  after(closeDb);

  test("un contatto senza external_id lo riceve solo quando richiesto", async () => {
    // La colonna ha DEFAULT gen_random_uuid(): i nuovi insert "normali" hanno
    // già un uuid. Qui simuliamo una riga pre-migrazione (external_id NULL
    // esplicito) per testare il backfill lazy di ensureExternalId.
    const site = await createTestSite("Ext IDs");
    const contact = (await query(
      "INSERT INTO contacts (site_id, email, external_id) VALUES ($1, $2, NULL) RETURNING id, external_id",
      [site.id, "ext-ids@example.test"]
    )).rows[0];
    assert.equal(contact.external_id, null);

    const uuid1 = await ensureExternalId("contacts", contact.id);
    assert.match(uuid1, UUID_RE);

    const uuid2 = await ensureExternalId("contacts", contact.id);
    assert.equal(uuid2, uuid1);

    const uuid3 = await getExternalId("contacts", contact.id);
    assert.equal(uuid3, uuid1);

    const row = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
    assert.equal(row.rows[0].external_id, uuid1);
  });

  test("findByExternalId trova la riga con uuid valido", async () => {
    const site = await createTestSite("Ext IDs Find");
    const contact = (await query(
      "INSERT INTO contacts (site_id, email) VALUES ($1, $2) RETURNING id",
      [site.id, "ext-ids-find@example.test"]
    )).rows[0];
    const uuid = await ensureExternalId("contacts", contact.id);

    const found = await findByExternalId("contacts", uuid);
    assert.ok(found);
    assert.equal(found.id, contact.id);
  });

  test("findByExternalId con stringa non-uuid lancia errore 400", async () => {
    await assert.rejects(
      () => findByExternalId("contacts", "non-e-un-uuid"),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.message, "Identificatore non valido");
        return true;
      }
    );
  });

  test("tabella non in whitelist lancia errore", async () => {
    await assert.rejects(() => ensureExternalId("pg_catalog", 1));
    await assert.rejects(() => findByExternalId("pg_catalog", "00000000-0000-0000-0000-000000000000"));
  });
});
