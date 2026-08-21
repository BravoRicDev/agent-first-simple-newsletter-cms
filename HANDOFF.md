# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 Phase 1-5**: booking, calendar sync, public page, payments,
  conversations — tutte **COMPLETE**.
- **ONDA 2 Phase 6 — Event-driven agent conversation triggers**: **COMPLETO**.
- **REFINEMENT — Test gap + e2e event pipeline**: **COMPLETO** (questo run).

## COSTRUITO IN QUESTO RUN (nuovo commit)

### Fix test gap in v1-openapi.test.js
Aggiunte le route mancanti alla expected list nello spec OpenAPI:
- `/booking-calendar-config`
- `/payment-links`, `/payment-links/{id}`, `/payment-links/{id}/mark-paid`

Queste route erano già documentate in `openapi.js` ma non verificate dal test.
Ora il test copre tutta la surface API documentata.

### test/onda2-booking-webhook-e2e.test.js — Webhook OUT e2e (3 test)
Verifica end-to-end del flusso booking → webhook out:
1. **Creazione booking → delivery booking_created**: POST /v1/bookings genera
   una riga in webhook_deliveries per booking_created, con payload che contiene
   booking_id, title, start_time.
2. **Isolamento tenant**: tenant B (con webhook attivo per booking_created) NON
   riceve delivery per i booking di tenant A.
3. **Cancellazione booking → delivery booking_cancelled**: DELETE /v1/bookings/:id
   (soft-delete) genera delivery per booking_cancelled.

### test/onda2-runtime-event-flow.test.js — Agent Runtime Event Flow (6 test)
Verifica end-to-end del flusso triggerRuntimeForEvent con payload booking reali:
1. **booking_created → conversazione con messaggio**: 2 runtime (whatsapp + email)
   attivati, conversazioni create, messaggi in DB verificati via
   listConversationMessages, meta.event_triggered_by=booking_created.
2. **pref_email=false → runtime email saltato**: Il runtime whatsapp viene
   comunque attivato (pref_whatsapp=true), l'email skippato.
3. **Isolamento tenant B**: runtime B matcha, nessuna conversazione su A.
4. **Evento senza matching → triggered=false**: form_submitted non matcha.
5. **Runtime senza event_triggers non crasha**: graceful handling.
6. **Contatto sconosciuto non crasha**: graceful handling contatto inesistente.

### Verifica regressione
- Suite v1-OpenAPI (5 test): ✅ 5/5 pass (con gap fix)
- F0 foundations + location + rate-limit (36 test): ✅ 36/36
- ONDA 1 contacts + opportunities + custom (17 test): ✅ 17/17
- ONDA 1 webhook out (1 test): ✅ 1/1
- ONDA 2 booking + booking-calendar (15 test): ✅ 15/15
- ONDA 2 conversations + runtime-events + payments (30 test): ✅ 30/30
- **Nuovo e2e webhook (3 test)**: ✅ 3/3
- **Nuovo runtime flow (6 test)**: ✅ 6/6
- **Totale verificato: 107+ test, 0 fail**

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check` su tutti i file modificati: OK
- ✅ Test gap fix: v1-openapi.test.js ora copre tutta la surface documentata
- ✅ Nuovi test: webhook e2e (3 test) + runtime flow (6 test) — tutti pass
- ✅ Regressione zero (0 fail su 107+ test)
- ✅ Nessun segreto nel codice
- ✅ Nessun `git reset --hard` / force
- ✅ DECISIONI_UMANE: nessun [APERTA] — tutti [RISOLTO] già applicati
- ✅ `.claude-task-e2e-refinement.md` pulito (rimosso)

## PROSSIMO BLOCCO CONSIGLIATO
1. **OpenAPI per booking-public**: documentare gli endpoint pubblici di booking
   (GET /booking-public/:siteId/slots, /booking-public/:siteId, POST /booking-public/:siteId
   e /booking-public/:siteId/confirmed) in un file openapi separato o sezione
   dell'esistente.
2. **Webhook booking → n8n integration test**: testare che i webhook delivery
   vengano processati e inviati correttamente (simulando n8n via server HTTP di
   test), coprendo HMAC signature e retry.
3. **Performance/security test**: verificare che rate limiting per-tenant funzioni
   su booking e payment-links, e che i limiti di prenotazione (lead time, finestra)
   siano rispettati.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- **Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime)**.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).