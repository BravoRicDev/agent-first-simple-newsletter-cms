# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 iniziata**: booking API su /v1 (Phase 1 del calendario/booking).
  Migrazione 077 applicata, servizio booking.js, 5 route booking in v1.js,
  test onda2-booking (5 pass).

## COSTRUITO IN QUESTO RUN (commit <hash>)
1. **docs/ONDA2_SPEC.md** — spec per Phase 1 del booking system: tabella
   `booking_appointments`, servizio CRUD, route /v1/bookings, test pattern.
   Definisce scope Phase 2 (Google Calendar sync) e Phase 3 (public booking
   page) per il futuro.

2. **db/077_booking_system.sql** — migrazione idempotente (IF NOT EXISTS):
   tabella `booking_appointments` con id SERIAL, site_id FK, contact_*,
   title/description, start_time/end_time, status, timezone, google_event_id
   (per sync futuro), cancelled_at. Indici su site/status/time, email, e UNIQUE
   parziale su google_event_id (WHERE NOT NULL).

3. **src/services/booking.js** — CRUD completo:
   - `listBookings(siteId, { status, contactEmail, limit, offset })` — con
     count totale e filtri.
   - `getBooking(siteId, id)` — dettaglio singolo.
   - `createBooking(siteId, data)` — validazione (contact_email/title/start_time
     obbligatori, end_time default +30 min), emette evento `booking_created` via
     emitContactEvent → webhook OUT.
   - `updateBooking(siteId, id, data)` — update parziale di tutti i campi.
   - `cancelBooking(siteId, id)` — soft-delete (status='cancelled' +
     cancelled_at = NOW()), emette `booking_cancelled`.

4. **src/routes/v1.js** — 5 nuove route booking dopo le route opportunità:
   - `POST /v1/bookings` (201)
   - `GET /v1/bookings` (filtri via `q[status]`, `q[contactEmail]`, `q[limit]`,
     `q[offset]`)
   - `GET /v1/bookings/:id` (200/404)
   - `PUT /v1/bookings/:id` (200/404)
   - `DELETE /v1/bookings/:id` (soft-delete, 200)
   Tutte passano da requireTenant() (header Location-Id + Bearer).

5. **test/onda2-booking.test.js** — 5 subtests (pattern identico a
   f0-foundations): 401 senza credenziali, CRUD + isolamento tenant,
   validazione contact_email obbligatorio, validazione title obbligatorio,
   filtri list.

## PUNTI DI VERIFICA (questo run)
- Suite v1 completa = **41 test / 8 file / 0 fail** (f0 + onda1-contatti +
  onda1-opportunità + custom-fields-opportunità + webhook-out + openapi +
  import-tool + onda2-booking). Nessuna regressione.
- `node --check` ok su tutti i file toccati (booking.js, v1.js,
  onda2-booking.test.js).
- Migrazione 077 idempotente (doppia esecuzione: nessun errore).
- Nessun segreto/personale nel codice.
- Nessun push (nessun remote); commit locale.

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 2 Phase 2 — Google Calendar sync per booking**: quando un booking
   viene creato, creare evento Google Calendar (riusando oauth.js +
   calendar-sync.js); quando cancellato, rimuovere/aggiornare evento. Usare
   `tenant_config` per credenziali Google per-tenant.
2. **ONDA 2 Phase 3 — Public booking page**: route pubblica
   `/book/:bookingSlug` per permettere a contatti/lead di prenotare slot (EJS
   form + POST pubblico senza auth).
3. **OpenAPI update**: aggiungere specifica OpenAPI per le 5 route booking
   in `src/openapi.js`.
4. **Hardening auth/rate-limit**: rate limiting sulla surface /v1 e validazione
   body più stretta (resto della consolidazione v1).

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1.
- OAuth Google già esistente (oauth.js, scopes calendar).
- Calendar sync config esistenti (calendar-sync.js).
- Webhook OUT già attivo su contact_created, opportunity_stage_changed e ora
  booking_created/booking_cancelled.
- Migrazione 077 booking_appointments.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).