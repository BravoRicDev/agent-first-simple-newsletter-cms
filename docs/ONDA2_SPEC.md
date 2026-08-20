# ONDA 2 — Calendar Booking + Google Calendar + Automations (SPEC per agente)

Leggi OBBLIGATORIAMENTE `AGENTS.md`, `HANDOFF.md`, `DECISIONI_UMANE.md`,
`ROADMAP.md`, `docs/F0_SPEC.md`, `docs/ONDA1_SPEC.md` e `docs/ONDA2_SPEC.md`
prima di iniziare. Rispetta i VINCOLI di `AGENTS.md`.

## OBIETTIVO DEL BLOCCO (questa fase)
Costruire il **Booking System** su surface /v1:
1. **Booking API**: CRUD appuntamenti prenotati da un contatto.
2. **Config per-tenant**: durata default, fuso orario, lead time, finestra
   prenotabile (giorni avanti), slot gap.
3. **Schema migrazione 077**: tabella `booking_appointments`.

NON include in questa fase:
- Google Calendar sync in tempo reale (creazione evento Google all'atto della
  prenotazione). Sarà Phase 2.
- Public booking page (/book/:slug). Sarà Phase 3.
- Pagamenti/payments. Sarà Phase 4.
- Conversazioni outbound. Sarà Phase 5.
- Funnels. Sarà Phase 6.

## DECISIONI UMANE GIÀ PRESE (applica)
- [RISOLTO] Google Calendar: credenziali NON hardcoded — la funzionalità di
  Onda 2 (Google Calendar sync) deve essere CONFIGURABILE per tenant (campo di
  config). Riutilizzare `tenant_config` e `oauth_connections` esistenti.
- [RISOLTO] Naming: "API compatibili con CRM diffusi" — MAI il nome del CRM
  di origine.

## CONTESTO PROGETTO rilevante
- Stack: Node 22, Express 4, ESM (`"type":"module"`), PostgreSQL 16 (pg).
- `src/routes/v1.js` già montato su `/v1` con `router.use(requireTenant())`.
- OAuth Google già esistente: `src/services/oauth.js` (flusso Authorization
  Code, scopes includono `https://www.googleapis.com/auth/calendar`).
- Calendar sync config: `src/services/calendar-sync.js` (tabella
  `calendar_sync_configs`, sync bidirezionale chiamate↔Google Calendar).
- Oauth connections: `oauth_connections` (tabella con access_token/refresh_token).
- Config per-tenant: `tenant_config` (tabella F0, chiave/valore JSONB).
- Webhook OUT già attivo su `contact_created` e `opportunity_stage_changed`.
- Event system: `src/services/events.js` → `src/services/webhooks.js`.

## SCHEMA SQL — db/077_booking_system.sql (idempotente)

### `CREATE TABLE IF NOT EXISTS booking_appointments`
```
id              SERIAL PRIMARY KEY
site_id         INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE
contact_name    VARCHAR(255) NOT NULL DEFAULT ''
contact_email   VARCHAR(255) NOT NULL
contact_phone   VARCHAR(50) NOT NULL DEFAULT ''
title           VARCHAR(255) NOT NULL
description     TEXT NOT NULL DEFAULT ''
start_time      TIMESTAMPTZ NOT NULL
end_time        TIMESTAMPTZ NOT NULL
status          VARCHAR(30) NOT NULL DEFAULT 'confirmed'
                -- CHECK: 'pending' | 'confirmed' | 'cancelled' | 'completed'
                -- NO CONSTRAINT, validated at app layer for flexibility
timezone       VARCHAR(50) NOT NULL DEFAULT 'UTC'
google_event_id VARCHAR(255) DEFAULT NULL     -- per future sync
cancelled_at   TIMESTAMPTZ DEFAULT NULL
created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()

UNIQUE(site_id, id)
CREATE INDEX IF NOT EXISTS idx_booking_appts_site ON booking_appointments(site_id, status, start_time)
CREATE INDEX IF NOT EXISTS idx_booking_appts_email ON booking_appointments(site_id, contact_email)
```

NOTA: `google_event_id` ha UNIQUE parziale (solo dove NOT NULL). NON usare
`ADD CONSTRAINT IF NOT EXISTS` — pitfall 069. Usa CREATE UNIQUE INDEX IF NOT
EXISTS ... WHERE google_event_id IS NOT NULL.

## FILE DA CREARE/MODIFICARE

### 1. `db/077_booking_system.sql` — migrazione idempotente
Vedi schema sopra. Idempotenza: `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE`.

### 2. `docs/ONDA2_SPEC.md` — questa spec (da aggiornare ad ogni fase)

### 3. `src/services/booking.js` — servizio CRUD prenotazioni
```
listBookings(siteId, { status?, contactEmail?, limit?, offset? })
getBooking(siteId, id)
createBooking(siteId, data)  -- { contactName, contactEmail, contactPhone?,
                              --   title, description?, startTime, endTime?,
                              --   timezone? }
updateBooking(siteId, id, data)
cancelBooking(siteId, id)
```
- Validazione: start_time obbligatorio, end_time opzionale (default = start_time
  + 30 min), titolo obbligatorio, contact_email obbligatorio.
- Status: create → 'confirmed', cancel → 'cancelled' + cancelled_at.
- Emette evento `booking_created` via events.js su create (→ webhook out).

### 4. `src/routes/v1.js` — AGGIUNGERE le route booking
```
POST   /v1/bookings          → createBooking
GET    /v1/bookings           → listBookings (?status=&contactEmail=&limit=&offset=)
GET    /v1/bookings/:id       → getBooking
PUT    /v1/bookings/:id       → updateBooking
DELETE /v1/bookings/:id       → cancelBooking
```
Tutte passano da requireTenant() (già presente). Risposte enveloping:
`{ booking: {...} }` o `{ bookings: [...], total }`.
Route statiche PRIMA di /:id (nessuna qui, booking non ha sub-route statiche).

NOTA: le route /v1/bookings/:id/{cancel} non servono — /v1/bookings/:id con
DELETE fa già soft-delete (cancella via cancelBooking).

### 5. `test/onda2-booking.test.js` — test CRUD booking
Pattern identico a test/f0-foundations.test.js (app di test con v1Routes).
- Creazione booking: 201 con dati corretti
- Lista bookings con filtri
- Get booking per id: 200 + 404
- Update booking: modifica titolo/ora
- Cancel booking: status 'cancelled' + cancelled_at popolato
- 401 senza credenziali
- Isolamento tenant (booking di tenant B non visibile ad A)

## VINCOLI TECNICI
- ESM: import/export.
- SQL idempotente: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
  MAI `ADD CONSTRAINT IF NOT EXISTS` (pitfall 069).
- Non rompere route esistenti / v1.js.
- `node --check` su ogni file creato/modificato.
- Style: try/catch + next(err), helper http, enveloping.
- Niente segreti hardcoded.

## DEFINIZIONE DI COMPLETATO
- docs/ONDA2_SPEC.md creato (questa fase).
- Migrazione 077 applicata (doppia esecuzione ok).
- src/services/booking.js — CRUD funzionante.
- src/routes/v1.js — 5 route booking aggiunte, senza rompere route esistenti.
- test/onda2-booking.test.js — TUTTI i subtests PASS.
- Regressioni: test/f0-foundations.test.js, test/onda1-contacts.test.js,
  test/onda1-opportunities-v1.test.js, test/onda1-webhook-out.test.js PASS.
- `node --check` ok sui file toccati.
- Aggiornare HANDOFF.md (fase Onda 2, task fatti, prossimo blocco Phase 2).
- Nessun [APERTA] da risolvere.