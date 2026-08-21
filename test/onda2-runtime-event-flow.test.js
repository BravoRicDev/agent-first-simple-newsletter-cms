import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "./helpers.js";
import { triggerRuntimeForEvent } from "../src/services/agent-runtime.js";
import { listConversationMessages } from "../src/services/conversations.js";

// ONDA 2 Phase 6 — Event flow e2e: verifica che il flusso eventi completo
// (booking_created → events.js → triggerRuntimeForEvent) funzioni.
//
// Il flusso reale:
// POST /v1/bookings → services/booking.js → createBooking →
// emitContactEvent("booking_created") → events.js →
// triggerRuntimeForEvent({ siteId, eventType: "booking_created", contactEmail, payload })
//
// Testa triggerRuntimeForEvent direttamente con argomenti realistici,
// verificando: creazione conversazione, invio messaggio iniziale,
// rispetto preferenze GDPR, isolamento tenant, gestione graceful di contatti
// inesistenti.
describe("ONDA 2 Phase 6 — event flow e2e (booking_created → agent runtime)", () => {
  let siteA, siteB;
  let runtimeWhatsappId, runtimeEmailId;

  before(async () => {
    siteA = await createTestSite("E2E Runtime Flow A");
    siteB = await createTestSite("E2E Runtime Flow B");

    // Crea utenti admin (necessari per runtime sync)
    await query(
      "INSERT INTO users (site_id, email, name, role, status) VALUES ($1, $2, $3, $4, 'active')",
      [siteA.id, uniqueEmail("admin-a"), "Admin A", "admin"]
    );
    await query(
      "INSERT INTO users (site_id, email, name, role, status) VALUES ($1, $2, $3, $4, 'active')",
      [siteB.id, uniqueEmail("admin-b"), "Admin B", "admin"]
    );

    // Crea contatti con preferenze attive
    await query(
      `INSERT INTO contacts (site_id, email, pref_whatsapp, pref_email)
       VALUES ($1, $2, true, true)`,
      [siteA.id, "e2e-runtime@example.test"]
    );
    await query(
      `INSERT INTO contacts (site_id, email, pref_whatsapp, pref_email)
       VALUES ($1, $2, true, false)`,
      [siteA.id, "e2e-noemail@example.test"]
    );
    await query(
      `INSERT INTO contacts (site_id, email, pref_email)
       VALUES ($1, $2, true)`,
      [siteB.id, "e2e-tenantb@example.test"]
    );

    // Runtime su siteA: trigger whatsapp per booking_created
    const r1 = await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'E2E Booking WhatsApp', 'whatsapp', true, $2, 'Grazie per il contatto!')
       RETURNING id`,
      [siteA.id, JSON.stringify([{
        event_type: "booking_created",
        enabled: true,
        initial_message: "Grazie per la prenotazione via WhatsApp! Il tuo appuntamento è confermato.",
      }])]
    );
    runtimeWhatsappId = r1.rows[0].id;

    // Runtime su siteA: trigger email per booking_created
    const r2 = await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'E2E Booking Email', 'email', true, $2, 'Email fallback')
       RETURNING id`,
      [siteA.id, JSON.stringify([{
        event_type: "booking_created",
        enabled: true,
        initial_message: "La tua prenotazione è confermata. Riceverai una email di riepilogo.",
      }])]
    );
    runtimeEmailId = r2.rows[0].id;

    // Runtime su siteB (per isolamento): trigger email per booking_created
    await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, event_triggers, fallback_text)
       VALUES ($1, 'E2E Booking Email B', 'email', true, $2, 'B fallback')`,
      [siteB.id, JSON.stringify([{
        event_type: "booking_created",
        enabled: true,
        initial_message: "Messaggio da tenant B per prenotazione.",
      }])]
    );

    // Runtime senza event_triggers (default [])
    await query(
      `INSERT INTO agent_runtimes (site_id, name, channel, enabled, fallback_text)
       VALUES ($1, 'E2E No Triggers', 'email', true, 'Niente trigger')`,
      [siteA.id]
    );
  });

  after(async () => {
    await closeDb();
  });

  test("triggerRuntimeForEvent: booking_created attiva runtime con messaggio iniziale e conversazione", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: siteA.id,
      eventType: "booking_created",
      contactEmail: "e2e-runtime@example.test",
      payload: {
        booking_id: 999,
        title: "E2E Test Booking",
        start_time: "2026-08-25T10:00:00Z",
        status: "confirmed",
      },
    });

    assert.ok(result.triggered, "triggered=true");
    assert.ok(result.results && result.results.length >= 2, "almeno 2 runtime matchano");

    // Verifica che il runtime whatsapp sia stato attivato
    const whatsappRun = result.results.find(r => r.runtime_id === runtimeWhatsappId);
    assert.ok(whatsappRun, "runtime whatsapp trovato");
    assert.ok(whatsappRun.triggered, "runtime whatsapp triggered=true");
    assert.ok(whatsappRun.conversation_id > 0, "conversation_id valido per whatsapp");
    assert.ok(whatsappRun.message_sent, "messaggio whatsapp inviato");
    assert.match(whatsappRun.initial_message || "", /WhatsApp/);

    // Verifica che il runtime email sia stato attivato
    const emailRun = result.results.find(r => r.runtime_id === runtimeEmailId);
    assert.ok(emailRun, "runtime email trovato");
    assert.ok(emailRun.triggered, "runtime email triggered=true");
    assert.ok(emailRun.conversation_id > 0, "conversation_id valido per email");
    assert.ok(emailRun.message_sent, "messaggio email inviato");
    assert.match(emailRun.initial_message || "", /confermata/);

    // Verifica che i messaggi siano effettivamente in DB per la conversazione whatsapp
    const messages = await listConversationMessages(siteA.id, whatsappRun.conversation_id);
    assert.ok(messages && messages.messages.length >= 1, "almeno 1 messaggio in DB");
    const msg = messages.messages[messages.messages.length - 1];
    assert.equal(msg.direction, "out");
    assert.match(msg.body, /WhatsApp/);
    assert.ok(msg.meta?.event_triggered_by === "booking_created", "meta.event_triggered_by corretto");
  });

  test("contatto con pref_email=false viene saltato dal trigger email", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: siteA.id,
      eventType: "booking_created",
      contactEmail: "e2e-noemail@example.test",
      payload: { booking_id: 1000, title: "Pref test booking" },
    });

    assert.ok(result.triggered, "triggered=true (almeno whatsapp matcha)");

    // Il runtime whatsapp matcha (pref_whatsapp=true), l'email viene saltato
    const whatsappRun = result.results.find(r => r.runtime_id === runtimeWhatsappId);
    assert.ok(whatsappRun, "runtime whatsapp trovato");
    assert.ok(whatsappRun.triggered, "runtime whatsapp attivato nonostante pref_email=false");

    // Il runtime email DEVE essere saltato
    const emailRun = result.results.find(r => r.runtime_id === runtimeEmailId);
    assert.ok(emailRun, "runtime email trovato");
    assert.equal(emailRun.triggered, false, "runtime email NON attivato per pref_email=false");
  });

  test("isolamento tenant: tenant B usa runtime B e non crea conversazioni su A", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: siteB.id,
      eventType: "booking_created",
      contactEmail: "e2e-tenantb@example.test",
      payload: { booking_id: 2000, title: "Tenant B booking" },
    });

    assert.ok(result.triggered, "triggered=true su tenant B");
    assert.ok(result.results && result.results.length >= 1, "almeno 1 runtime matcha su B");
    assert.ok(result.results[0].triggered, "runtime triggered=true su B");

    // Verifica che su siteA non ci siano conversazioni per l'email di B
    const convsA = (await query(
      "SELECT id FROM conversations WHERE site_id = $1 AND contact_email = $2",
      [siteA.id, "e2e-tenantb@example.test"]
    )).rows;
    assert.equal(convsA.length, 0, "nessuna conversazione su A per contatto B");
  });

  test("evento senza runtime matching non triggera nulla", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: siteA.id,
      eventType: "form_submitted", // nessun runtime ha questo trigger
      contactEmail: "e2e-runtime@example.test",
      payload: {},
    });

    assert.equal(result.triggered, false, "nessun match = triggered false");
    // results array può essere vuoto o undefined — entrambi ok
    const count = Array.isArray(result.results) ? result.results.length : 0;
    assert.equal(count, 0, "nessun result");
  });

  test("runtime senza event_triggers non crasha", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: siteA.id,
      eventType: "booking_created",
      contactEmail: "e2e-runtime@example.test",
      payload: {},
    });

    assert.ok(typeof result.triggered === "boolean", "non crasha");
    // I runtime configurati (con trigger) devono matchare
    assert.ok(result.results && result.results.length >= 2, "almeno 2 runtime con trigger configurati matchano");
  });

  test("contatto sconosciuto non causa crash", async () => {
    const result = await triggerRuntimeForEvent({
      siteId: siteA.id,
      eventType: "booking_created",
      contactEmail: "mai-visto-prima@example.test",
      payload: { booking_id: 3000, title: "Nuovo contatto" },
    });

    // Il contatto non esiste in DB → triggerRuntimeForEvent deve comunque
    // processare (o skippare) senza crashare
    assert.ok(typeof result.triggered === "boolean", "non crasha con contatto sconosciuto");
  });
});