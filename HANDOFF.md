# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 booking**: Phase 1, 2, 3 + refinements **COMPLETO**.
- **ONDA 2 Phase 4 — Payments API su /v1**: **COMPLETO** (payment-links CRUD +
  mark-paid + OpenAPI + test 9/9 pass).

## COSTRUITO IN QUESTO RUN (nuovo commit)

### v1 Payment Links API (ONDA 2 Phase 4)

1. **src/routes/v1.js** — Aggiunte 6 route payment-links:
   - `POST /v1/payment-links` → createPaymentLink
   - `GET /v1/payment-links` → listPaymentLinks (filtri status/limit/offset)
   - `GET /v1/payment-links/:id` → getPaymentLink
   - `PUT /v1/payment-links/:id` → updatePaymentLink
   - `DELETE /v1/payment-links/:id` → deletePaymentLink
   - `POST /v1/payment-links/:id/mark-paid` → markPaid (route statica PRIMA di /:id)
   
   Enveloping: `{ paymentLink: {...} }`, `{ paymentLinks: [...], total }`, `{ deleted: true, id }`.
   `mark-paid` ritorna `{ paymentLink, already: boolean }`.

2. **src/openapi.js** — Documentazione OpenAPI:
   - Schemas: `PaymentLink`, `PaymentLinkCreate`
   - Tag: "Payment Links"
   - Paths: `/payment-links` (GET+POST), `/payment-links/{id}` (GET+PUT+DELETE),
     `/payment-links/{id}/mark-paid` (POST)

3. **test/v1-payments.test.js** — Nuovo test file (9 test):
   - POST create → 201 con paymentLink
   - GET list → 200 con array (amount come number)
   - GET by id → 200 e 404
   - PUT update → 200
   - POST mark-paid → 200 con already:false
   - mark-paid due volte → already:true
   - DELETE → 200, poi GET → 404
   - 401 senza credenziali
   - Isolamento tenant (link di tenant B non visibile ad A)

4. **Nessuna migration nuova** — usa tabella `payment_links` (057) già esistente.

## PUNTI DI VERIFICA (questo run)
- **v1-payments.test.js**: **9/9 pass** ✅
- Regressione v1-openapi.test.js: **5/5** ✅
- Regressione onda2-booking.test.js: **6/6** ✅
- Regressioni F0 + ONDA1 (f0-location-mapping, onda1-contacts, onda1-opportunities-v1,
  onda1-opportunity-custom-fields, onda1-webhook-out): **27/27** ✅
- **Totale verificato: 47/47 pass, 0 fail**.
- `node --check` ok su v1.js, openapi.js, v1-payments.test.js.
- Nessuna migration nuova. Nessun nome CRM di origine.
- Nessun segreto/personale nel codice. Nessun push.
- `.claude-task-v1-payments.md` rimosso (temp non committato).

## PROSSIMO BLOCCO CONSIGLIATO
1. **Rate-limit per-tenant (tenant_config)**: estendere v1RateLimiter per leggere
   configurazione da tenant_config key=rate_limits, permettendo a ogni tenant di
   personalizzare windowMs e max per general/write.
2. **OpenAPI booking-public**: documentazione OpenAPI degli endpoint pubblici di
   booking (da aggiungere a v1-openapi o file separato).
3. **Webhook booking → n8n**: verificare che l'evento booking_created emesso da
   createBooking arrivi correttamente ai webhook configurati (e che il contatto
   auto-creato non generi eventi duplicati).
4. **ONDA 2 Phase 5 — Outbound conversations**: implementare conversazioni
   outbound per i contatti.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- updateCalendarEvent hook su PUT booking — Phase 2 refinements.
- Public booking page — Phase 3 (form EJS, slot computation, route pubbliche).
- Auto-create contatto CRM su booking — Phase 2 refinements.
- **v1 Payment Links API** — Phase 4 (payment-links CRUD + mark-paid + OpenAPI).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).

## MONITORAGGIO (POLISH, fine run)
- ✅ Repository LIBERO (working tree in attesa di commit).
- ✅ DECISIONI_UMANE: nessuna [APERTA]. [RISOLTO] tutti gia applicati/rispettati.
- ✅ **Test verificati** (47/47 pass, 0 fail):
  - F0 + location mapping: 18/18 (inclusi in regressione batch)
  - ONDA1 contacts + opportunities + custom fields + webhook: 27/27
  - v1 OpenAPI: 5/5
  - v1 Payments: 9/9
- ✅ DB di test `cms-test-pg` up, funzionante.
- ✅ Nessun segreto/personale nel codice.
- ✅ `.env.example` allineato.
- ✅ Nessun leak di naming CRM di origine nel codice.