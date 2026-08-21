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

## COSTRUITO IN QUESTO RUN (nuovo commit: 6f7d423)
1. **Migration** — nessuna nuova migration.

2. **src/middleware/rate-limit-v1.js**: nuovo middleware `v1RateLimiter()`.
   Due limiters statici (creati a init): generalLimiter (120 req/min per GET)
   e writeLimiter (60 req/min per POST/PUT/DELETE). Skip loopback. Headers
   standard RateLimit-Remaining/Reset. Messaggio errore italiano. Per-tenant
   configurabilita futura (via tenant_config key=rate_limits).

3. **src/middleware/body-validate-v1.js**: nuovo middleware `v1BodyValidator()`.
   POST/PUT: verifica Content-Type application/json → 415 altrimenti.
   POST: body non vuoto → 400. Limite 1MB → 413. GET/DELETE: nessuna check.

4. **src/routes/v1.js**: montaggio di `v1RateLimiter()` e `v1BodyValidator()`
   dopo `requireTenant()` ma prima di tutte le route.

5. **test/v1-rate-limit.test.js**: 9 test (4 rate limit GET + 1 WRITE POST +
   3 body validation + 1 loopback exemption) — **9/9 pass, 0 fail**.

## PUNTI DI VERIFICA (questo run)
- **v1-rate-limit.test.js**: 9/9 pass.
- Regressione: f0-foundations 9/9, onda1-contacts 8/8, onda1-opportunities-v1
  4/4, onda2-booking 6/6 — **tutti pass, 0 fail**.
- `node --check` ok su rate-limit-v1.js, body-validate-v1.js, v1.js, test file.
- Nessuna migrazione nuova.
- Nessun nome del CRM di origine nei nuovi file.
- Nessun segreto/personale nel codice. Nessun push (nessun remote).
- **ERRORE NOTO**: `ERR_ERL_CREATED_IN_REQUEST_HANDLER` evitato creando
  limiters statici (non in handler). `closeDb()` chiamato una volta sola
  nell'after globale (non per-suite) per evitare "pool già chiuso".

## PROSSIMO BLOCCO CONSIGLIATO
1. **OpenAPI booking-public**: documentazione OpenAPI dei nuovi endpoint
   pubblici di booking (da aggiungere a v1-openapi o file separato).
2. **ONDA 2 Phase 2 refinements avanzati**: creazione contatto CRM al momento
   del booking (booking → contatto) o altre integrazioni.
3. **Rate-limit per-tenant (tenant_config)**: estendere v1RateLimiter per
   leggere configurazione da tenant_config key=rate_limits, permettendo a
   ogni tenant di personalizzare windowMs e max per general/write.

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