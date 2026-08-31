import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { encryptSecret } from "../src/services/crypto.js";
import { enqueuePush, processPushQueue } from "../src/services/source-sync/push.js";
import { enqueueForEvent, deliverPending } from "../src/services/webhooks.js";
import { upsertContact, addContactTag } from "../src/services/contacts.js";

// ─────────────────────────────────────────────────────────────────────────
// Sync bidirezionale con GoHighLevel + "fire unico" in cluster.
//
// Verifica:
//  1. ANTI-ECHO: una mutata con origine 'ghl_in'/'import' NON crea righe
//     nella push queue (evita cascade A→GHL→A).
//  2. processPushQueue invia il contatto a GHL (PUT /contacts/upsert),
//     marca la riga 'sent' e salva external_id sul contatto locale.
//  3. FIRE-UNICO: due processPushQueue/process webhook OUT concorrenti
//     non duplicano MAI una consegna (advisory lock + FOR UPDATE SKIP LOCKED).
//  4. NO-IMPORT: con un source_sync_runs 'running' il push non parte.
// ─────────────────────────────────────────────────────────────────────────

describe("GHL sync bidirezionale + single-fire cluster", () => {
  let site, user, server, baseUrl;
  const received = [];
  let webhookOutId = null;

  before(async () => {
    site = await createTestSite("GHL Push Test");
    user = await createTestUser(site.id, "admin");

    // "CRM sorgente" finto: espone gli endpoint usati dal push e registra
    // ogni richiesta in `received`.
    const app = express();
    app.use(express.json());
    app.post("/contacts/upsert", (req, res) => {
      received.push({ path: "/contacts/upsert", body: req.body });
      res.json({ contact: { id: "ghl-contact-" + crypto.randomBytes(4).toString("hex") } });
    });
    app.put("/contacts/upsert", (req, res) => {
      received.push({ path: "/contacts/upsert", body: req.body });
      res.json({ contact: { id: "ghl-contact-" + crypto.randomBytes(4).toString("hex") } });
    });
    app.put("/contacts/:id", (req, res) => {
      received.push({ path: "/contacts/" + req.params.id, body: req.body });
      res.json({ success: true });
    });
    app.post("/opportunities", (req, res) => {
      received.push({ path: "/opportunities", body: req.body });
      res.json({ opportunity: { id: "ghl-opp-" + crypto.randomBytes(4).toString("hex") } });
    });
    app.put("/opportunities/:id", (req, res) => {
      received.push({ path: "/opportunities/" + req.params.id, body: req.body });
      res.json({ success: true });
    });
    app.delete("/contacts/:id", (req, res) => {
      received.push({ path: "/contacts/" + req.params.id + " (delete)", body: null });
      res.json({ success: true });
    });
    app.delete("/opportunities/:id", (req, res) => {
      received.push({ path: "/opportunities/" + req.params.id + " (delete)", body: null });
      res.json({ success: true });
    });
    app.use((req, res) => res.status(404).json({ error: "nope" }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });

    // Config source-sync con push abilitato verso il "CRM" finto.
    await query(
      `INSERT INTO source_sync_config
         (site_id, enabled, base_url, location_id, token_enc, push_enabled, push_direction, push_events)
       VALUES ($1, true, $2, $3, $4, true, 'bidirectional', $5)
       ON CONFLICT (site_id) DO UPDATE SET
         enabled = true, base_url = $2, location_id = $3,
         token_enc = COALESCE(EXCLUDED.token_enc, source_sync_config.token_enc),
         push_enabled = true, push_direction = 'bidirectional', push_events = $5`,
      [site.id, baseUrl, "loc123", encryptSecret("test-token"), JSON.stringify(["contact", "opportunity"])]
    );

    // Webhook OUT per il test single-fire della delivery.
    const wh = (
      await query(
        `INSERT INTO webhooks (site_id, name, direction, url, secret, events, active)
         VALUES ($1, 'out-ghl', 'out', $2, '', '["contact_created"]', true)
         RETURNING id`,
        [site.id, `${baseUrl}/contacts/upsert`]
      )
    ).rows[0];
    webhookOutId = wh.id;
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  test("anti-echo: mutata origin ghl_in non crea righe in source_push_queue", async () => {
    await upsertContact(site.id, "echo@example.test", { origin: "ghl_in" });
    await addContactTag(site.id, "echo@example.test", "lead", { origin: "ghl_in" });
    await new Promise((r) => setTimeout(r, 50));
    const rows = (await query(
      "SELECT * FROM source_push_queue WHERE site_id = $1 AND entity_type = 'contact'",
      [site.id]
    )).rows;
    assert.equal(rows.length, 0, "nessuna riga push per mutate originate da GHL");
  });

  test("mutata origin cms accoda una riga push", async () => {
    await upsertContact(site.id, "cms@example.test", { origin: "cms" });
    await new Promise((r) => setTimeout(r, 80));
    // entity_id risolto via email: la riga deve esserci.
    const contact = (await query(
      "SELECT id FROM contacts WHERE LOWER(email)=LOWER($1) AND site_id=$2", ["cms@example.test", site.id]
    )).rows[0];
    assert.ok(contact, "contatto creato");
    const mine = (await query(
      "SELECT * FROM source_push_queue WHERE site_id=$1 AND entity_id=$2 AND status='pending'",
      [site.id, contact.id]
    )).rows;
    assert.ok(mine.length >= 1, "deve esserci una riga push pending");
  });

  test("processPushQueue invia il contatto a GHL e salva external_id", async () => {
    // Isolamento: chiudi le righe pending lasciate dai test precedenti.
    await query("UPDATE source_push_queue SET status='sent', updated_at=NOW() WHERE site_id=$1 AND status='pending'", [site.id]);
    await upsertContact(site.id, "pushme@example.test", { origin: "cms" });
    await new Promise((r) => setTimeout(r, 80));
    const contact = (await query(
      "SELECT id, external_id FROM contacts WHERE LOWER(email)=LOWER($1) AND site_id=$2",
      ["pushme@example.test", site.id]
    )).rows[0];
    assert.ok(contact, "contatto creato");

    const beforeCount = received.filter((r) => r.path === "/contacts/upsert").length;
    const res = await processPushQueue({ siteId: site.id, limit: 20 });
    assert.ok(res.processed >= 1, "deve processare almeno una riga");
    const afterCount = received.filter((r) => r.path === "/contacts/upsert").length;
    assert.equal(afterCount, beforeCount + 1, "GHL deve ricevere esattamente una upsert");

    const updated = (await query(
      "SELECT ghl_id FROM contacts WHERE id=$1", [contact.id]
    )).rows[0];
    assert.match(updated.ghl_id, /^ghl-contact-/, "ghl_id salvato dal push");

    const row = (await query(
      "SELECT status FROM source_push_queue WHERE site_id=$1 AND entity_id=$2 AND entity_type='contact'",
      [site.id, contact.id]
    )).rows[0];
    assert.equal(row.status, "sent", "riga marcata sent");
  });

  test("fire-unico: processPushQueue concorrenti non duplicano l'invio", async () => {
    // Pulizia: marca sent le righe pregresse e accoda una nuova mutata.
    await query("UPDATE source_push_queue SET status='sent' WHERE site_id=$1", [site.id]);
    const email = "once@example.test";
    await upsertContact(site.id, email, { origin: "cms" });
    await new Promise((r) => setTimeout(r, 80));
    const contact = (await query(
      "SELECT id FROM contacts WHERE LOWER(email)=LOWER($1) AND site_id=$2", [email, site.id]
    )).rows[0];

    const beforeCount = received.filter((r) => r.path === "/contacts/upsert").length;
    await Promise.all([
      processPushQueue({ siteId: site.id, limit: 20 }),
      processPushQueue({ siteId: site.id, limit: 20 }),
      processPushQueue({ siteId: site.id, limit: 20 }),
    ]);
    const afterCount = received.filter((r) => r.path === "/contacts/upsert").length;
    assert.equal(afterCount, beforeCount + 1, "esattamente UNA upsert verso GHL nonostante 3 worker concorrenti");
    const rows = (await query(
      "SELECT COUNT(*)::int AS n FROM source_push_queue WHERE site_id=$1 AND entity_id=$2 AND status='sent'",
      [site.id, contact.id]
    )).rows[0];
    assert.equal(rows.n, 1);
  });

  test("no-import: con un source_sync_runs running il push non parte", async () => {
    await query("UPDATE source_push_queue SET status='pending', next_attempt_at=NOW() WHERE site_id=$1", [site.id]);
    await query(
      `INSERT INTO source_sync_runs (site_id, mode, resources, status) VALUES ($1,'full','{contacts}','running')`,
      [site.id]
    );
    try {
      const beforeCount = received.filter((r) => r.path.startsWith("/contacts")).length;
      const res = await processPushQueue({ siteId: site.id, limit: 20 });
      const afterCount = received.filter((r) => r.path.startsWith("/contacts")).length;
      assert.equal(afterCount, beforeCount, "nessun invio mentre l'import è in corso");
      assert.equal(res.sent, 0);
    } finally {
      await query("DELETE FROM source_sync_runs WHERE site_id=$1 AND status='running'", [site.id]);
    }
  });

  test("fire-unico webhook OUT: deliverPending concorrenti inviano una sola volta", async () => {
    await query("DELETE FROM webhook_deliveries WHERE site_id=$1", [site.id]);
    await enqueueForEvent(site.id, "contact_created", { email: "single@example.test" });
    await new Promise((r) => setTimeout(r, 50));
    const beforeCount = received.filter((r) => r.path === "/contacts/upsert").length;
    await Promise.all([
      deliverPending(10, { siteId: site.id, allowPrivate: true }),
      deliverPending(10, { siteId: site.id, allowPrivate: true }),
    ]);
    const afterCount = received.filter((r) => r.path === "/contacts/upsert").length;
    assert.equal(afterCount, beforeCount + 1, "webhook out consegnato una sola volta con 2 worker");
    const delivered = (await query(
      "SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE site_id=$1 AND status='sent'", [site.id]
    )).rows[0];
    assert.equal(delivered.n, 1);
  });
});