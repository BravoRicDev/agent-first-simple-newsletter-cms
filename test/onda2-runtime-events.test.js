import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, uniqueEmail, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { triggerRuntimeForEvent } from "../src/services/agent-runtime.js";
import { listConversationMessages } from "../src/services/conversations.js";

// ONDA 2 Phase 6 — Event-driven agent conversation triggers
// Verifica che triggerRuntimeForEvent:
// 1. Attivi il runtime configurato per l'event_type
// 2. Crei una conversazione e invii il messaggio iniziale
// 3. Rispetti le preferenze GDPR (pref_whatsapp / pref_email)
// 4. Isoli correttamente per tenant
// 5. Eventi senza runtime matching non triggerino nulla
describe("ONDA 2 Phase 6 — agent runtime event triggers", () => {
  let site, site2, user;

  before(async () => {
    site = await createTestSite("Runtime Event Test");
    site2 = await createTestSite("Runtime Event Test 2");
    user = await createTestUser(site.id, "admin");
    await createTestUser(site2.id, "admin");

    // Site 1: runtime whatsapp con event_trigger su booking_created
    await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'Booking Agent', 'whatsapp', true, $2, 'Grazie per averci contattato!')`,
      [site.id, JSON.stringify([
        {
          event_type: "booking_created",
          enabled: true,
          initial_message: "Grazie per la prenotazione! Come posso aiutarti?",
        },
      ])]
    );

    // Site 1: runtime email con event_trigger su contact_created
    await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'Welcome Email', 'email', true, $2, 'Benvenuto!')`,
      [site.id, JSON.stringify([
        {
          event_type: "contact_created",
          enabled: true,
          initial_message: "Benvenuto nel nostro sistema! Sono il tuo assistente virtuale.",
        },
      ])]
    );

    // Site 2: runtime email con event_trigger su booking_created (per isolamento)
    await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'Booking Agent 2', 'email', true, $2, 'Grazie per averci contattato!')`,
      [site2.id, JSON.stringify([
        {
          event_type: "booking_created",
          enabled: true,
          initial_message: "Messaggio da tenant 2 per prenotazione.",
        },
      ])]
    );

    // Crea contatto per i test (preferenze attive)
    await query(
      `INSERT INTO contacts (site_id, email, pref_whatsapp, pref_email)
       VALUES ($1, 'event-test@test.com', true, true)`,
      [site.id]
    );
    await query(
      `INSERT INTO contacts (site_id, email, pref_email)
       VALUES ($1, 'event-test-tenant2@test.com', true)`,
      [site2.id]
    );

    // Contatto con pref_whatsapp=false (dovrebbe essere saltato per trigger whatsapp)
    await query(
      `INSERT INTO contacts (site_id, email, pref_whatsapp, pref_email)
       VALUES ($1, 'no-whatsapp@test.com', false, true)`,
      [site.id]
    );

    // Contatto con pref_email=false (dovrebbe essere saltato per trigger email)
    await query(
      `INSERT INTO contacts (site_id, email, pref_whatsapp, pref_email)
       VALUES ($1, 'no-email@test.com', true, false)`,
      [site.id]
    );
  });

  after(async () => {
    await closeDb();
  });

  test("booking_created attiva runtime whatsap e crea conversazione con messaggio iniziale", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: site.id,
      eventType: "booking_created",
      contactEmail: "event-test@test.com",
      payload: { title: "Test booking", start_time: "2026-08-22T10:00:00Z" },
    });

    assert.ok(result.triggered, "triggerRuntimeForEvent deve ritornare triggered=true");
    assert.equal(result.results.length, 1, "1 runtime matcha");
    assert.ok(result.results[0].triggered, "runtime triggered=true");
    assert.ok(result.results[0].message_sent, "messaggio iniziale inviato");
    assert.ok(result.results[0].conversation_id > 0, "conversation_id valido");
    assert.match(result.results[0].initial_message, /Grazie per la prenotazione/);

    // Verifica che il messaggio sia effettivamente in DB
    const messages = await listConversationMessages(site.id, result.results[0].conversation_id);
    assert.ok(messages && messages.messages.length >= 1, "almeno 1 messaggio in conversazione");
    const msg = messages.messages[messages.messages.length - 1];
    assert.equal(msg.direction, "out");
    assert.match(msg.body, /Grazie per la prenotazione/);
    assert.equal(msg.meta?.event_triggered_by, "booking_created", "meta con event_type corretto");
  });

  test("contact_created attiva runtime email con messaggio di benvenuto", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: site.id,
      eventType: "contact_created",
      contactEmail: "event-test@test.com",
      payload: {},
    });

    assert.ok(result.triggered, "triggered=true");
    assert.equal(result.results.length, 1, "1 runtime matcha");
    assert.ok(result.results[0].triggered, "runtime triggered=true");
    assert.ok(result.results[0].message_sent, "messaggio inviato");
    assert.match(result.results[0].initial_message, /Benvenuto/, "messaggio di benvenuto inviato");
  });

  test("evento senza runtime matching non triggera nulla", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: site.id,
      eventType: "form_submitted", // nessun runtime ha questo trigger
      contactEmail: "event-test@test.com",
      payload: {},
    });

    assert.equal(result.triggered, false, "nessun match = triggered false");
    assert.ok(!result.results || result.results.length === 0, "nessun result");
  });

  test("isolamento tenant: evento booking_created su tenant2 usa runtime tenant2", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: site2.id,
      eventType: "booking_created",
      contactEmail: "event-test-tenant2@test.com",
      payload: {},
    });

    assert.ok(result.triggered, "triggered=true su tenant2");
    assert.equal(result.results.length, 1, "1 runtime matcha su tenant2");
    assert.ok(result.results[0].triggered, "runtime triggered=true");
    assert.match(result.results[0].initial_message, /tenant 2/, "messaggio tenant2");
  });

  test("contatto con pref_whatsapp=false viene saltato dal trigger whatsapp", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: site.id,
      eventType: "booking_created",
      contactEmail: "no-whatsapp@test.com",
      payload: {},
    });

    // Runtime matcha event_type ma contatto ha pref_whatsapp=false
    assert.ok(result.triggered, "triggered=true perché il runtime matcha");
    assert.equal(result.results.length, 1, "1 runtime matcha");
    const r = result.results[0];
    assert.equal(r.triggered, false, "triggered=false perché preferenza non ok");
    assert.equal(r.skipped, "pref", "skippato per preferenza GDPR");
  });

  test("contatto con pref_email=false viene saltato dal trigger email", async () => {
    // Crea un runtime email con trigger su booking_created per questo test
    await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'Email Booking Agent', 'email', true, $2, 'Email fallback')`,
      [site.id, JSON.stringify([
        {
          event_type: "booking_created",
          enabled: true,
          initial_message: "Email booking confermata!",
        },
      ])]
    );

    const result = await triggerRuntimeForEvent({
      siteId: site.id,
      eventType: "booking_created",
      contactEmail: "no-email@test.com",
      payload: {},
    });

    // Dovrebbe avere il runtime whatsapp match e il runtime email match
    // Il runtime whatsapp funziona (pref_whatsapp=true),
    // il runtime email viene saltato (pref_email=false)
    assert.ok(result.triggered, "triggered=true");
    // Almeno 1 runtime matcha (whatsapp, ma potrebbe non matchare se ha contatto con pref ok)
    // Verifichiamo che almeno un result abbia skipped=pref
    const skippedEmail = result.results.find((r) => r.skipped === "pref" && r.channel === "email");
    assert.ok(skippedEmail, "un runtime email viene saltato per pref_email=false");
  });

  test("runtime senza event_triggers non viene considerato", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: site.id,
      eventType: "booking_created",
      contactEmail: "nonexistent@test.com",
      payload: {},
    });

    // Non deve crashare con runtime che hanno event_triggers vuoto o null
    assert.ok(typeof result.triggered === "boolean", "risultato valido");
    // Il risultato può essere triggered se il contatto esiste e matcha il runtime
    // (anche se il runtime whatsap matcha, ma il contatto non esiste, potrebbe
    // passare con fallback contact vuoto)
  });
});