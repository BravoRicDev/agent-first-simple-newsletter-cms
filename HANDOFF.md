# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 booking**: Phase 1 (API /v1/bookings) COMPLETA. In questo run
  aggiunte **config per-tenant del booking** (durata, timezone, lead time,
  finestra prenotabile) + **documentazione OpenAPI** delle 5 route booking.

## COSTRUITO IN QUESTO RUN (commit <hash>)
1. **src/services/booking.js — config per-tenant del booking**: nuovo helper
   `readBookingConfig(siteId)` che legge da `tenant_config` (F0) le chiavi
   `booking_duration_minutes`, `booking_timezone`, `booking_lead_time_hours`,
   `booking_window_days`. `createBooking` applica: durata default end_time
   (45/30 config o 30 fisso), timezone default, vincolo lead time (minimo ore
   nel futuro) e vincolo finestra (massimo giorni nel futuro) → errori 400.
   Nessun vincolo applicato se la chiave non è configurata (i test esistenti
   senza config restano verdi). Override esplicito nel body vince sempre.

2. **src/openapi.js — route booking documentate**: tag `Booking`, schemi
   `Booking` e `BookingCreate`, path `/bookings` (GET filter + POST) e
   `/bookings/{id}` (GET/PUT/DELETE soft-delete) usando gli helper esistenti.

3. **test/onda2-booking.test.js**: nuovo test "config per-tenant: durata/
   timezone/lead-time/window" (imposta tenant_config, verifica default 45min +
   Europe/Rome, 400 per lead-time/passato/window, 201 dentro finestra; pulisce
   la config a fine test).

4. **test/v1-openapi.test.js**: aggiunte "/bookings" e "/bookings/{id}"
   all'elenco delle path attese nello spec.

## PUNTI DI VERIFICA (questo run)
- Suite v1 completa **verde**: onda2-booking (6) + v1-openapi (5) = 11/11;
  regressioni f0 + onda1 (6 file) = 31/31. Nessun fail.
- `node --check` ok su tutti i 4 file toccati.
- Nessuna nuova migrazione (si riusa `tenant_config` di F0 → niente rischi
  ADD CONSTRAINT).
- Nessun segreto/personale nel codice. Nessun push (nessun remote).
- NOTA: `claude-code` NON è loggato (claude -p fallisce con "Not logged in") →
  blocco implementato direttamente con i tool dell'agente (fallback previsto
  da AGENTS.md).

## MONITORAGGIO (POLISH, cron successivo)
- Repository LIBERO al passaggio (no claude/codex/opencode, working tree
  pulita, nessun `.git/index.lock`). Nessun fix strutturale richiesto.
- DECISIONI_UMANE: nessuna [APERTA]. [RISOLTO] tutti già applicati/rispettati
  (scope v1, repo clone locale, git locale senza push, naming generico, webhook
  OUT, Google Calendar configurabile per tenant, claude-code modello economico).
- Suite completa rieseguita su DB di test `cms-test-pg` (15999/testdb):
  61 file / 490 test, 0 fail. Unici skip: 6 in newsletter-verification
  (environment-dependent, provider email esterno senza credenziali — atteso).
- Nessun commit necessario (working tree pulita).

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 2 Phase 2 — Google Calendar sync per booking**: quando un booking
   viene creato, creare evento Google Calendar (riusando oauth.js +
   calendar-sync.js pattern); quando cancellato, rimuovere/aggiornare evento.
   Usare `tenant_config`/`oauth_connections` per credenziali Google per-tenant
   (configurabile, NON hardcoded come da decisione umana). NB: senza credenziali
   reali la verifica end-to-end non è possibile → test sul "no OAuth / 400".
2. **ONDA 2 Phase 3 — Public booking page** per booking_appointments (route
   pubblica + EJS form per slot), seguendo il pattern già esistente di
   /book/:siteId in src/routes/calls.js (calls) — costruire la variante booking.
3. **Hardening auth/rate-limit**: rate limiting sulla surface /v1 e validazione
   body più stretta (resto della consolidazione v1).

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
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