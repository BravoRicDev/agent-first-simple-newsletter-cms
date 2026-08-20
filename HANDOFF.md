# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **F0 tenancy — mapping Location ↔ Site**: COMPLETO (migrazione 078 + route
  `/v1/location` + middleware). Ultimo sotto-blocco F0 della tenancy risolto.
- **ONDA 2 booking**: Phase 1 (API /v1/bookings) + config per-tenant + OpenAPI.

## COSTRUITO IN QUESTO RUN (commit <hash>)
1. **Mapping Location ↔ Site (migrazione 078)** — ri-implementazione del
   mapping precedentemente revertito con **naming generico**:
   - `db/078_location_external_id.sql`: `sites.location_external_id` (VARCHAR
     255, UNIQUE parziale, nullable) — identificativo esterno della location
     associato al sito/tenant. Naming generico ("API compatibili con CRM
     diffusi", nessun nome del CRM di origine: la versione revertita usava
     `crm_location_id`, in violazione di AGENTS.md).
   - `src/middleware/tenant-api.js`: `requireTenant` quando `Location-Id` non è
     numerico prova prima il `domain` del sito e poi `location_external_id`;
     `req.tenant.locationExternalId` esposto verso i consumer (es. n8n).
   - `src/routes/v1.js`: `GET/PUT/DELETE /v1/location` per gestire ed esporre il
     mapping (PUT accetta `externalId` o `locationId`; 409 se già usato da altro
     tenant; DELETE azzera).
   - `src/openapi.js`: path `/location` (get/put/delete) documentata.
   - `test/f0-location-mapping.test.js`: 9 test (risoluzione UUID, 401 cross-
     tenant, 404 inesistente, GET/PUT/DELETE, 409/400, persistenza/unicità).
   - `test/v1-openapi.test.js`: aggiunta `/location` alle path attese.

## PUNTI DI VERIFICA (questo run)
- Suite blocco **verde** su DB di test `cms-test-pg` (15999/testdb), gruppi
  isolati: f0-location-mapping (9) + v1-openapi (5) + f0-foundations/contacts
  (17) + opportunities/custom-fields/webhook-out (10) + booking/api-tokens (11)
  + crm-suite/import-crm-tool (14) = **66/66, 0 fail**.
- `node --check` ok su tutti i file toccati.
- Migrazione 078 idempotente (ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF
  NOT EXISTS — nessun "ADD CONSTRAINT IF NOT EXISTS").
- Nessun nome del CRM di origine nei file del blocco (grep CRM: pulito sui file
  nuovi/toccati; i riferimenti pre-esistenti in altri file stile-CRM non sono
  parte di questo blocco).
- Nessun segreto/personale nel codice. Nessun push (nessun remote).
- NOTA: `claude-code` NON è loggato (claude -p: "Not logged in") → blocco
  implementato direttamente con i tool dell'agente (fallback previsto da
  AGENTS.md).

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

### MONITORAGGIO (POLISH, cron successivo #2)
- Repository LIBERO al passaggio (no claude/codex/opencode attivo, working tree
  pulita, nessun `.git/index.lock`). Nessun fix strutturale richiesto.
- `.env.example` verificato ALLINEATO a `src/config.js`: presenti tutte le
  chiavi lette (DATABASE_URL, JWT_SECRET, SMTP_*, OPENAI_API_KEY, LLM_*,
  CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN, TWITTER_BEARER_TOKEN,
  FACEBOOK_PAGE_TOKEN, GROQ_API_KEY, GROQ_BASE_URL, WHISPER_MODEL,
  STRIPE_SECRET_KEY). Nessun allineamento mancante.
- Migrazioni: `db/migrate.js` gira da `scripts/test.sh` a ogni run senza errori
  → nessuna migrazione pendente/non applicata.
- DECISIONI_UMANE: nessuna [APERTA]; tutti i [RISOLTO] applicati/rispettati.
- Suite rieseguita a campione su DB di test in gruppi isolati, TUTTI VERDI:
  * onda2-booking + v1-openapi = 11/11
  * f0-foundations + onda1-contacts = 17/17
  * onda1-opportunities-v1 + custom-fields + webhook-out = 10/10
  (totale 38/38, 0 fail). `node --check` ok sui 4 file dell'ultimo blocco.
- Nessun commit necessario (working tree pulita). Nessun segreto nel codice.

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
- Mapping Location ↔ Site (migrazione 078) + route /v1/location.
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- OAuth Google già esistente (oauth.js, scopes calendar).
- Calendar sync config esistenti (calendar-sync.js).
- Webhook OUT già attivo su contact_created, opportunity_stage_changed e ora
  booking_created/booking_cancelled.
- Migrazione 078 mapping location + 077 booking_appointments.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).