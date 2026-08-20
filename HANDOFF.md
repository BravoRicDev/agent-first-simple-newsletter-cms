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
- **ONDA 2 Phase 2 refinements**: prossimo blocco consigliato.

## COSTRUITO IN QUESTO RUN (commit 5969a60)
1. **Migration** — nessuna nuova migration. Tutta la configurazione slot usa
   tenant_config esistente (chiavi booking_slot_minutes, booking_hours_start,
   booking_hours_end, booking_available_days, booking_lead_time_hours,
   booking_window_days).

2. **src/services/booking-slots.js**: nuovo servizio per il calcolo degli slot
   disponibili per il booking pubblico. `computeBookingSlots(siteId, { days })`
   legge da tenant_config i parametri di disponibilità con fallback a default
   ragionevoli (slot 60 min, 9-18, lun-ven, lead 1h, finestra 14gg). Esclude
   slot passati e slot in conflitto con booking_appointments esistenti (status
   non cancellato). `groupSlotsByDay(slots)` raggruppa per giorno.

3. **src/routes/booking-public.js**: route pubbliche (nessun auth/tenant):
   - `GET /booking-public/:siteId` — form EJS con slot disponibili
   - `GET /booking-public/:siteId/slots` — JSON endpoint per slot (con `?days=`)
   - `POST /booking-public/:siteId` — crea prenotazione via createBooking
     (rate-limited, honeypot anti-spam, validazione lato server dello slot
     per DoS protection)
   - `GET /booking-public/:siteId/confirmed` — pagina di conferma

4. **views/book/booking-public-index.ejs** + **views/book/booking-public-confirmed.ejs**:
   copie dell'esistente book/index.ejs, adattate per /booking-public/

5. **test/onda2-booking-public.test.js**: 8 test — 404, form slots, JSON slots,
   POST crea, rifiuta senza email, rifiuta slot passato, conferma, days param.

6. **src/index.js**: import e mount di bookingPublicRoutes PRIMA di callsRoutes
   (evita conflitto di route Express).

## PUNTI DI VERIFICA (questo run)
- **ONDA 2 Phase 3 — Public booking page**: 8/8 test pass (onda2-booking-public).
- Suite booking completa: onda2-booking (6/6) + booking-calendar (6/6) + booking-public (8/6) = **20/20, 0 fail**.
- Suite regressiva: f0-foundations (9/9) + booking (6/6) + booking-calendar (6/6) = **21/21, 0 fail**.
- `node --check` ok su booking-slots.js, booking-public.js, index.js.
- Nessuna migrazione nuova (config via tenant_config esistente).
- Nessun nome del CRM di origine nei nuovi file (grep CRM: pulito).
- Nessun segreto/personale nel codice. Nessun push (nessun remote).
- **NOTA**: `claude-code` non loggato (fallback su tool agente profilo coding).

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 2 Phase 2 refinements** — updateCalendarEvent hook su PUT booking
   (quando start_time/end_time cambiano, aggiornare evento GC esistente).
2. **Hardening auth/rate-limit**: rate limiting surface /v1 e validazione body
   piu stretta.
3. **OpenAPI booking-public**: documentazione OpenAPI dei nuovi endpoint
   pubblici di booking.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- **Public booking page** — Phase 3 (form EJS, slot computation, route pubbliche).
- OAuth Google gia esistente (oauth.js, scopes calendar).
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
- DECISIONI_UMANE: nessuna [APERTA]. [RISOLTO] tutti gia applicati/rispettati.
- **Blocco v1 + Onda 1 + Onda 2**: 29/29 pass (f0-foundations 9, booking 6,
  booking-calendar 6, booking-public 8).
- **Import tool + webhook-out**: 5/5 pass.
- **OAuth + forms-crm + workflow**: 26/26 pass.
- Commit locale: 5969a60 su main. Working tree pulita.
- **NOTE MINORI**: 2 commenti interni citano "CRM" (src/services/opportunities.js:151,
  db/067_tracked_links.sql:5). Non sono user-facing, fix opzionale per prossimo dev.
- DB di test `cms-test-pg` up, funzionante.