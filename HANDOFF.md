# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 booking**: Phase 1 (API /v1/bookings + config per-tenant + OpenAPI):
  **COMPLETO**. Phase 2 (Google Calendar sync per booking): **COMPLETO**.
- **ONDA 2 Phase 3 — Public booking page**: **COMPLETO** (form EJS +
  slot computation + route pubbliche + test 8/8 pass).
- **ONDA 2 Phase 2 refinements — updateCalendarEvent su PUT booking**: **COMPLETO**
  (tryUpdateEvent fire-and-forget + test 8/8 pass).
- **ONDA 2 Phase 2 refinements — auto-create contatto CRM su booking**: **COMPLETO**
  (booking → contatto CRM automatico, controllato da tenant_config key=booking_auto_create_contact).

## COSTRUITO IN QUESTO RUN (nuovo commit)
1. **src/services/booking.js** — `readBookingConfig()` ora legge anche la
   chiave `booking_auto_create_contact` (boolean, default true). `createBooking()`
   auto-crea/aggiorna un contatto CRM (`contacts`) via `upsertContactByEmail()`
   subito dopo l'inserimento del booking, in fire-and-forget. Non blocca la
   response. Attivo per default, disattivabile via tenant_config
   `booking_auto_create_contact = false`.

2. **test/onda2-booking-public.test.js** — aggiunto test
   `"Booking crea contatto CRM automaticamente"` (verifica che dopo booking
   il contatto esista in `contacts`). Race condition gestita con retry 200ms.

3. **Nessuna migration nuova** — usa `tenant_config` già esistente (chiave
   `booking_auto_create_contact`).

4. **Nessun nome del CRM di origine** nei nuovi commenti/codice.

## PUNTI DI VERIFICA (questo run)
- **onda2-booking-public.test.js**: 9/9 pass (nuovo test "Booking crea contatto
  CRM automaticamente" ✅).
- Regressione completa: F0 foundations + location: **18/18**,
  ONDA1 (contacts + opportunities + custom fields + webhook): **18/18**,
  ONDA2 booking API: **6/6**, v1 rate limit + body validation: **9/9**,
  OpenAPI + import: **9/9** — **60/60 pass, 0 fail**.
- `node --check` ok su booking.js, onda2-booking-public.test.js.
- Nessuna migration nuova. Nessun nome CRM di origine.
- Nessun segreto/personale nel codice. Nessun push.
- **Race condition da notare**: auto-create contatto è fire-and-forget; il test
  ha retry 200ms per gestire la latenza del DB.

## PROSSIMO BLOCCO CONSIGLIATO
1. **Rate-limit per-tenant (tenant_config)**: estendere v1RateLimiter per
   leggere configurazione da tenant_config key=rate_limits, permettendo a
   ogni tenant di personalizzare windowMs e max per general/write.
2. **OpenAPI booking-public**: documentazione OpenAPI dei nuovi endpoint
   pubblici di booking (da aggiungere a v1-openapi o file separato).
3. **Webhook booking → n8n**: verificare che l'evento booking_created emesso da
   createBooking arrivi correttamente ai webhook configurati (e che il contatto
   auto-creato non generi eventi duplicati).
4. **ONDA 2 Phase 2 refinements avanzati**: integrazione più profonda tra
   booking e CRM (es. aggiornamento contatto su cancellazione booking, stats
   booking per contatto).

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- **updateCalendarEvent hook su PUT booking** — Phase 2 refinements.
- **Public booking page** — Phase 3 (form EJS, slot computation, route pubbliche).
- **Auto-create contatto CRM su booking** — Phase 2 refinements (booking → contatto,
  controllato da tenant_config `booking_auto_create_contact`).
- OAuth Google gia esistente (oauth.js, scopes calendar).
- Calendar sync config esistenti per calls (calendar-sync.js).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).

## MONITORAGGIO (POLISH, cron 21/08/2026 ~02:00 UTC)
- ✅ Repository LIBERO al passaggio (nessun claude/codex/opencode, working tree pulita, nessun `.git/index.lock`). Nessun fix strutturale richiesto.
- ✅ DECISIONI_UMANE: nessuna [APERTA]. [RISOLTO] tutti gia applicati/rispettati.
- ✅ **Test eseguiti** (67/67 pass, 0 fail):
  - F0 foundations + location mapping: **18/18**
  - ONDA1 (contacts + opportunities + custom fields + webhook): **18/18**
  - ONDA2 booking API: **6/6**
  - ONDA2 booking calendar sync: **8/8**
  - ONDA2 public booking page: **8/8**
  - OpenAPI + import tool: **9/9**
- ✅ Sintassi `node --check` ok su tutti i file src e test chiave.
- ✅ DB di test `cms-test-pg` up, funzionante.
- ✅ Nessun segreto/personale nel codice.
- ✅ `.env.example` allineato, nessun gap.