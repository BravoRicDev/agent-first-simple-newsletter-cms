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
- **ONDA 2 Phase 2 refinements — updateCalendarEvent su PUT booking**:
  **COMPLETO** (tryUpdateEvent fire-and-forget + test 8/8 pass).

## COSTRUITO IN QUESTO RUN (nuovo commit)
1. **Migration** — nessuna nuova migration.

2. **src/services/booking-calendar.js**: nuova funzione `tryUpdateEvent(booking)`:
   fire-and-forget wrapper per aggiornare evento Google Calendar esistente.
   Legge config calendar, se non configurata o booking senza google_event_id
   → return silenzioso. Chiama `updateCalendarEvent(booking, config)`, logga
   warning su fallimento (mai throw). Non modifica google_event_id (già presente).

3. **src/services/booking.js — updateBooking()**: dopo l'UPDATE, se
   `existing.google_event_id` è valorizzato, importa dinamicamente `tryUpdateEvent`
   da `./booking-calendar.js` e lo chiama fire-and-forget. Pattern identico a
   createBooking/tryCreateEvent e cancelBooking/tryDeleteEvent.

4. **test/onda2-booking-calendar.test.js**: 2 nuovi test (ora 8 totali):
   - "booking update con google_event_id ma senza config → graceful skip"
   - "booking update con google_event_id e config attiva ma OAuth fittizio → graceful skip"

## PUNTI DI VERIFICA (questo run)
- **ONDA 2 Phase 2 refinements**: 8/8 test pass (onda2-booking-calendar).
- Suite booking completa: onda2-booking (6/6) + booking-calendar (8/8) + booking-public (8/8) = **22/22, 0 fail**.
- Suite regressiva: f0-foundations (9/9) + onda1-contacts (8/8) = **17/17, 0 fail**.
- `node --check` ok su booking-calendar.js, booking.js, test file.
- Nessuna migrazione nuova.
- Nessun nome del CRM di origine nei nuovi file.
- Nessun segreto/personale nel codice. Nessun push (nessun remote).
- **NOTA**: `claude-code` non loggato (fallback su tool agente profilo coding).

## PROSSIMO BLOCCO CONSIGLIATO
1. **Hardening auth/rate-limit**: rate limiting surface /v1 e validazione body
   piu stretta.
2. **OpenAPI booking-public**: documentazione OpenAPI dei nuovi endpoint
   pubblici di booking.
3. **ONDA 2 Phase 2 refinements avanzati**: creazione contatto CRM al momento
   del booking (booking → contatto) o altre integrazioni.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- **updateCalendarEvent hook su PUT booking** — Phase 2 refinements.
- **Public booking page** — Phase 3 (form EJS, slot computation, route pubbliche).
- OAuth Google gia esistente (oauth.js, scopes calendar).
- Calendar sync config esistenti per calls (calendar-sync.js).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).

## MONITORAGGIO (POLISH, cron 21/08/2026 01:51 UTC)
- ✅ Repository LIBERO al passaggio (nessun claude/codex/opencode, working tree
  pulita dopo commit, nessun `.git/index.lock`). Nessun fix strutturale richiesto.
- ✅ DECISIONI_UMANE: nessuna [APERTA]. [RISOLTO] tutti gia applicati/rispettati.
- ✅ **Test eseguiti**: booking ONDA 2 (onda2-booking 6 + booking-calendar 8 + booking-public 8): **22/22 pass, 0 fail**. Regressioni F0 (f0-foundations 9) + Onda 1 (onda1-contacts 8): **17/17 pass**.
- ✅ Commit locale: nuovo commit su main. Working tree pulita.
- ✅ Nessun segreto/personale nel codice (solo colonne DB access_token/refresh_token).
- ✅ DB di test `cms-test-pg` up, funzionante.