import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import { cloneContactsFromSibling } from "../../src/services/source-sync/clone-sibling.js";

// Regression guard SINTOMO-NOTE-CLONE.md: cloneContactsFromSibling faceva
// UN SOLO INSERT...SELECT bulk per i contatti, con ON CONFLICT solo su
// (site_id, source_id). Ma `contacts` ha ANCHE UNIQUE(site_id, email): se il
// sito target aveva già un contatto con la STESSA email ma un source_id
// diverso (dati residui pre-slave, o due contatti sorgente distinti con
// stessa email), l'INSERT bulk falliva su QUELLA riga e mandava in eccezione
// TUTTA la funzione — bloccando la clonazione di note/task/opportunità/
// conversazioni/appuntamenti/custom-values per OGNI contatto del giro, non
// solo quello in conflitto. Verificato dal vivo in produzione: 341 contatti
// (siti 21/22) con note sul master e zero sullo slave per questo motivo.

function makeCtx(siteId) {
  const stats = {};
  return {
    siteId,
    addStat: (res, key, n = 1) => {
      stats[res] = stats[res] || {};
      stats[res][key] = (stats[res][key] || 0) + n;
    },
    stats,
    knownContacts: new Set(),
    log: () => {},
  };
}

describe("cloneContactsFromSibling — conflitto email non blocca il giro (SINTOMO-NOTE-CLONE.md)", () => {
  let master, slave;

  before(async () => {
    master = await createTestSite("Clone Sibling Master");
    slave = await createTestSite("Clone Sibling Slave");
  });

  after(async () => {
    await query("DELETE FROM contact_notes WHERE site_id = ANY($1)", [[master.id, slave.id]]);
    await query("DELETE FROM contacts WHERE site_id = ANY($1)", [[master.id, slave.id]]);
    await closeDb();
  });

  test("un contatto in conflitto email viene saltato (loggato), TUTTI gli altri (e le loro note) si clonano comunque", async () => {
    const suf = crypto.randomBytes(4).toString("hex");
    const okEmail1 = `ok1-${suf}@example.test`;
    const okEmail2 = `ok2-${suf}@example.test`;
    const conflictEmail = `conflict-${suf}@example.test`;

    // 2 contatti "normali" sul master, senza omologo sul target.
    const ok1 = (await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', 'active', '', NOW(), NOW()) RETURNING id`,
      [master.id, `src-ok1-${suf}`, okEmail1]
    )).rows[0];
    const ok2 = (await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', 'active', '', NOW(), NOW()) RETURNING id`,
      [master.id, `src-ok2-${suf}`, okEmail2]
    )).rows[0];

    // Contatto sul master la cui email COLLIDE con un contatto GIÀ presente
    // sul target, ma con un source_id DIVERSO — riproduce esattamente il bug.
    await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', 'active', '', NOW(), NOW())`,
      [master.id, `src-master-side-${suf}`, conflictEmail]
    );
    await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', 'active', '', NOW(), NOW())`,
      [slave.id, `src-slave-side-${suf}`, conflictEmail]
    );

    // Note sui 2 contatti "normali" del master — devono propagarsi al target.
    await query(
      `INSERT INTO contact_notes (site_id, source_id, contact_email, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [master.id, `note-ok1-${suf}`, okEmail1, "Nota sul contatto 1"]
    );
    await query(
      `INSERT INTO contact_notes (site_id, source_id, contact_email, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [master.id, `note-ok2-${suf}`, okEmail2, "Nota sul contatto 2"]
    );

    const ctx = makeCtx(slave.id);
    // Prima del fix: questa chiamata lanciava un'eccezione (unique violation)
    // e nessun contatto/nota veniva clonato. Dopo il fix: non deve lanciare.
    await assert.doesNotReject(() => cloneContactsFromSibling(ctx, master.id));

    const cloned1 = (await query("SELECT id FROM contacts WHERE site_id = $1 AND source_id = $2", [slave.id, `src-ok1-${suf}`])).rows[0];
    const cloned2 = (await query("SELECT id FROM contacts WHERE site_id = $1 AND source_id = $2", [slave.id, `src-ok2-${suf}`])).rows[0];
    assert.ok(cloned1, "contatto 1 clonato nonostante il conflitto altrove nello stesso giro");
    assert.ok(cloned2, "contatto 2 clonato nonostante il conflitto altrove nello stesso giro");

    // Il contatto in conflitto NON deve essere stato duplicato: sul target
    // resta SOLO la riga preesistente (src-slave-side-*), non src-master-side-*.
    const conflictRows = (await query("SELECT source_id FROM contacts WHERE site_id = $1 AND email = $2", [slave.id, conflictEmail])).rows;
    assert.equal(conflictRows.length, 1, "nessun duplicato email sul sito target");
    assert.equal(conflictRows[0].source_id, `src-slave-side-${suf}`, "resta la riga preesistente del target, non sovrascritta");

    const notes1 = (await query("SELECT body FROM contact_notes WHERE site_id = $1 AND contact_id = $2", [slave.id, cloned1.id])).rows;
    const notes2 = (await query("SELECT body FROM contact_notes WHERE site_id = $1 AND contact_id = $2", [slave.id, cloned2.id])).rows;
    assert.equal(notes1.length, 1, "nota del contatto 1 clonata");
    assert.equal(notes1[0].body, "Nota sul contatto 1");
    assert.equal(notes2.length, 1, "nota del contatto 2 clonata");
    assert.equal(notes2[0].body, "Nota sul contatto 2");

    // addStat("contacts", "upserted", ...) accumula su una chiave sola sia i
    // contatti che le note/task/ecc. clonati nello stesso giro: 2 contatti +
    // 2 note (nessun task/opportunità/ecc. seminato in questo test) = 4.
    assert.equal(ctx.stats.contacts.upserted, 4, "2 contatti + 2 note senza conflitto contano come upserted");
    assert.ok(ctx.stats.contacts.errors >= 1, "il conflitto viene comunque contato come errore, non ignorato in silenzio");
  });

  test("giro senza conflitti: contatti e note si clonano normalmente (nessuna regressione)", async () => {
    const suf = crypto.randomBytes(4).toString("hex");
    const email = `clean-${suf}@example.test`;
    const contact = (await query(
      `INSERT INTO contacts (site_id, source_id, email, tags, status, notes, created_at, updated_at)
       VALUES ($1, $2, $3, '{}', 'active', '', NOW(), NOW()) RETURNING id`,
      [master.id, `src-clean-${suf}`, email]
    )).rows[0];
    await query(
      `INSERT INTO contact_notes (site_id, source_id, contact_email, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())`,
      [master.id, `note-clean-${suf}`, email, "Nota pulita"]
    );

    const ctx = makeCtx(slave.id);
    await cloneContactsFromSibling(ctx, master.id);

    const cloned = (await query("SELECT id FROM contacts WHERE site_id = $1 AND source_id = $2", [slave.id, `src-clean-${suf}`])).rows[0];
    assert.ok(cloned, "contatto clonato");
    const notes = (await query("SELECT body FROM contact_notes WHERE site_id = $1 AND contact_id = $2", [slave.id, cloned.id])).rows;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].body, "Nota pulita");
  });
});
