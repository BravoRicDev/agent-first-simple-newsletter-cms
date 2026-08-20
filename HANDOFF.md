# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 booking**: Phase 1 (API /v1/bookings + config per-tenant + OpenAPI):
  **COMPLETO**. Phase 2 (Google Calendar sync per booking): **COMPLETO**.
- **ONDA 2 Phase 3 — Public booking page**: prossimo blocco consigliato.

## COSTRUITO IN QUESTO RUN (commit 8c95db2)
1. **Migration 079 — booking_calendar_config**: per-tenant config che collega
   booking a Google Calendar tramite connessione OAuth (feature 36). Tabella
   idempotente (IF NOT EXISTS), nessuna FK verso oauth_connections (verifica
   a runtime). Index su site_id + active.

2. **src/services/booking-calendar.js**: servizio di sync booking → Google
   Calendar. Funzioni `createCalendarEvent`, `updateCalendarEvent`,
   `deleteCalendarEvent` (chiamate HTTP a Google API con fetch nativo, timeout
   15s, mai throw → ritornano {error}). `tryCreateEvent` e `tryDeleteEvent`
   fire-and-forget: leggono la config per-tenant, se OAuth non attivo saltano
   senza errori, loggano e basta.

3. **Hook in booking.js**: `createBooking` chiama `tryCreateEvent(booking)`
   dopo la creazione (dopo webhook booking_created). `cancelBooking` chiama
   `tryDeleteEvent(booking)` dopo l'aggiornamento status (dopo webhook
   booking_cancelled). Entrambi import dinamici fire-and-forget con catch
   — mai bloccano il booking, mai errore 500.

4. **Route /v1/booking-calendar-config**: GET (config attiva o null), POST
   (crea, disattiva precedente), PUT (aggiorna una sola volta), DELETE
   (disattiva). Validazione 400 per oauth_connection_id mancante/non valido.

5. **OpenAPI**: schema `BookingCalendarConfig` + path `/booking-calendar-config`
   con get/post/put/delete documentati sotto tag Booking.

6. **test/onda2-booking-calendar.test.js**: 6 test — booking senza config
   (skip fire-and-forget), CRUD GET/POST/GET/PUT/DELETE della config, booking
   con config ma OAuth non attivo (graceful skip Google Calendar), 400 su POST
   senza oauth_connection_id, 404 su DELETE/PUT senza config attiva.

## PUNTI DI VERIFICA (questo run)
- Suite blocco **verde** su DB di test: onda2-booking-calendar (6/6) +
  onda2-booking (6/6) + v1-openapi (5/5) + f0-foundations (9/9) +
  onda1-contacts/opportunities/custom-fields (9/9) = **35/35, 0 fail**.
- `node --check` ok su tutti i file toccati.
- Migrazione 079 idempotente (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF
  NOT EXISTS — nessun "ADD CONSTRAINT IF NOT EXISTS").
- Nessun nome del CRM di origine nei file del blocco (grep CRM: pulito).
- Nessun segreto/personale nel codice. Nessun push (nessun remote).
- **NOTA**: `claude-code` NON loggato (fallback su tool agente profilo coding).

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 2 Phase 3 — Public booking page**: route pubblica + EJS form per
   selezione slot, seguendo il pattern di /book/:siteId in src/routes/calls.js.
2. **ONDA 2 Phase 2 refinements** — updateCalendarEvent hook su PUT booking
   (quando start_time/end_time cambiano, aggiornare evento GC esistente).
3. **Hardening auth/rate-limit**: rate limiting surface /v1 e validazione body
   più stretta.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- OAuth Google già esistente (oauth.js, scopes calendar).
- Calendar sync config esistenti per calls (calendar-sync.js).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).

## MONITORAGGIO (POLISH, cron successivo)
- Repository LIBERO al passaggio (nessun claude/codex/opencode, working tree
  pulita, nessun `.git/index.lock`). Nessun fix strutturale richiesto.
- DECISIONI_UMANE: nessuna [APERTA]. [RISOLTO] tutti già applicati/rispettati.
- **Blocco v1 + Onda 1 + Onda 2**: 43/43 pass (f0-foundations 9, contatti 8,
  opportunità-v1 4, custom-fields 5, booking 6, booking-calendar 6, openapi 5).
- **Import tool + webhook-out**: 5/5 pass.
- **OAuth + forms-crm + workflow**: 26/26 pass.
- Commit locale: 8c95db2 su main. Working tree pulita.
- **NOTE MINORI**: 2 commenti interni citano "CRM" (src/services/opportunities.js:151,
  db/067_tracked_links.sql:5). Non sono user-facing, fix opzionale per prossimo dev.
- DB di test `cms-test-pg` up da 5 giorni, funzionante.