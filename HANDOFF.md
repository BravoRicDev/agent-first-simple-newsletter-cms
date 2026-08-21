# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 booking**: Phase 1, 2, 3 + refinements **COMPLETO**.
- **ONDA 2 Phase 4 — Payments API su /v1**: **COMPLETO** (payment-links CRUD +
  mark-paid + OpenAPI + test 9/9 pass).
- **ONDA 2 Phase 4 ext — Rate-limit per-tenant**: **COMPLETO** (tenant_config
  key=rate_limits con cache TTL 60s, keyGenerator tenant-isolato, skip loopback
  configurabile, test 13/13 pass).
- **ONDA 2 Phase 5 — v1 Conversations API**: **COMPLETO** (route GET/POST/PUT/DELETE
  conversazioni + messaggi outbound + OpenAPI + test 14/14 pass).

## COSTRUITO IN QUESTO RUN (nuovo commit)

### ONDA 2 Phase 5 — v1 Conversations API (outbound)

1. **src/routes/v1.js** — Aggiunte 6 route per conversazioni su /v1:
   - `GET /v1/conversations` — lista con filtri ?email, ?channel, ?status
   - `GET /v1/conversations/{id}` — dettaglio conversazione (404 se inesistente)
   - `GET /v1/conversations/{id}/messages` — lista messaggi in ordine cronologico
   - `POST /v1/conversations/{id}/messages` — aggiunge messaggio outbound (direction
     default "out"; verifica esistenza conversazione prima di scrivere)
   - `PUT /v1/conversations/{id}/status` — setta status (open|pending|closed, validato)
   - `DELETE /v1/conversations/{id}` — elimina conversazione (cascade su messaggi)
   - Riutilizza `src/services/conversations.js` senza modifiche al servizio.
   - Route statiche (GET /conversations) PRIMA di quelle con parametro :id.

2. **src/openapi.js** — Aggiunti:
   - Tag: `Conversazioni` (ONDA 2 — conversazioni outbound)
   - Schemas: `Conversation`, `ConversationMessage`, `ConversationMessageCreate`
   - Paths: `/conversations` (GET), `/conversations/{id}` (GET+DELETE),
     `/conversations/{id}/messages` (GET+POST), `/conversations/{id}/status` (PUT)

3. **test/v1-openapi.test.js** — Aggiunte route conversazioni all'array expected.

4. **test/onda2-conversations-v1.test.js** — Nuovo file con 14 test:
   - Lista vuota, lista con dati, dettaglio, 404, messaggi, add messaggio,
     add messaggio 404, cambio status, status non valido, filtro status,
     delete, delete-get-404, isolamento tenant, filtro email, filtro whatsapp

### Verifica regressione
- v1-openapi.test.js: **5/5** ✅
- onda2-conversations-v1.test.js: **14/14** ✅
- crm-conversations.test.js: **12/12** ✅ (regressione zero)
- onda1-contacts.test.js: **8/8** ✅
- onda1-opportunities-v1.test.js: **4/4** ✅
- v1-payments.test.js: **9/9** ✅
- onda2-booking.test.js: **6/6** ✅
- v1-rate-limit.test.js: **13/13** ✅
- f0-foundations.test.js: **9/9** ✅
- onda1-webhook-out.test.js: **1/1** ✅
- **Totale parziale: 81/81 pass, 0 fail**

## PUNTI DI VERIFICA (questo run — 21/08/2026)
- ✅ `node --check` su src/routes/v1.js, src/openapi.js, v1-openapi.test.js,
     onda2-conversations-v1.test.js: sintassi OK
- ✅ Tutti i test nuovi e vecchi passano (81/81, 0 fail)
- ✅ Nessun segreto nel codice
- ✅ Nessun `git reset --hard` / force
- ✅ DECISIONI_UMANE: nessun [APERTA] — tutti [RISOLTO] già applicati

## PROSSIMO BLOCCO CONSIGLIATO
1. **OpenAPI booking-public**: documentazione OpenAPI degli endpoint pubblici di
   booking (da aggiungere a v1-openapi o file separato).
2. **Webhook booking → n8n**: verificare che l'evento booking_created emesso da
   createBooking arrivi correttamente ai webhook configurati (e che il contatto
   auto-creato non generi eventi duplicati).
3. **ONDA 2 Phase 6 — Agent runtime extension**: estendere il runtime agente per
   supportare conversation triggering da eventi webhook/booking.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- updateCalendarEvent hook su PUT booking — Phase 2 refinements.
- Public booking page — Phase 3 (form EJS, slot computation, route pubbliche).
- Auto-create contatto CRM su booking — Phase 2 refinements.
- **v1 Payment Links API** — Phase 4 (payment-links CRUD + mark-paid + OpenAPI).
- **Rate-limit per-tenant** — Phase 4 ext (tenant_config key=rate_limits).
- **v1 Conversations API** — Phase 5 (conversazioni CRUD + messaggi outbound + OpenAPI).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).