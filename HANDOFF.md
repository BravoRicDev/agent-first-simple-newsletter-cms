# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 booking**: Phase 1, 2, 3 + refinements **COMPLETO**.
- **ONDA 2 Phase 4 — Payments API su /v1**: **COMPLETO** (payment-links CRUD +
  mark-paid + OpenAPI + test 9/9 pass).
- **ONDA 2 Phase 4 ext — Rate-limit per-tenant**: **COMPLETO** (tenant_config
  key=rate_limits con cache TTL 60s, keyGenerator tenant-isolato, skip loopback
  configurabile, test 4/4 pass).

## COSTRUITO IN QUESTO RUN (nuovo commit)

### Rate-limit per-tenant via tenant_config

1. **src/middleware/rate-limit-v1.js** — Riscritto da limiters statici a singolo
   `rateLimit` con:
   - **keyGenerator**: `${siteId}:${ip}` — ogni tenant ha rate limit separato
   - **max**: funzione dinamica che legge da cache in-memory (Map<siteId, limits>)
   - **Cache**: refresh ogni 60s dal DB (`SELECT ... WHERE key='rate_limits'`),
     fire-and-forget su miss, setInterval periodico
   - **skip loopback**: configurabile via `v1RateLimiter({ skipLoopback: false })`
     (default true) — i test possono disabilitarlo per testare su localhost
   - **Default**: generalMax=120, writeMax=60, windowMs=60000
   - Config per-tenant: key=`rate_limits`, value=`{ "generalMax": 200, "writeMax": 100 }`
   - `refreshConfigCache()` esportata per test

2. **test/v1-rate-limit.test.js** — Aggiunta Suite 5 (4 test):
   - GET senza config usa default 120/min ✅
   - Config `generalMax=2` blocca dopo 2 GET ✅
   - Config solo `writeMax=1`: POST bloccata dopo 1, GET resta 200 ✅
   - Isolamento tenant: config di A non tocca B ✅
   - Totale suite: **13/13 pass** (9 vecchi + 4 nuovi)

### Verifica regressione
- v1-openapi.test.js: **5/5** ✅
- f0-location-mapping.test.js: **9/9** ✅
- onda1-contacts.test.js: **8/8** ✅
- onda1-opportunities-v1.test.js: **4/4** ✅
- onda1-opportunity-custom-fields.test.js: **5/5** ✅
- onda1-webhook-out.test.js: **1/1** ✅
- v1-payments.test.js: **9/9** ✅
- onda2-booking.test.js: **6/6** ✅
- **Totale suite parziale: 60/60 pass, 0 fail**

## PUNTI DI VERIFICA (questo run)
- ✅ Rate-limit per-tenant: 4 test nuovi pass
- ✅ Cache TTL 60s + refresh periodico funzionante
- ✅ keyGenerator tenant-isolato (siteId:ip)
- ✅ skip loopback configurabile (test disabilitano)
- ✅ Nessuna migration nuova (tenant_config già esiste)
- ✅ `node --check` OK su rate-limit-v1.js e test
- ✅ Regressione zero su tutti i file test esistenti
- ✅ Nessun segreto/personale nel codice
- ✅ Nessun file temporaneo residuo

## PROSSIMO BLOCCO CONSIGLIATO
1. **OpenAPI booking-public**: documentazione OpenAPI degli endpoint pubblici di
   booking (da aggiungere a v1-openapi o file separato).
2. **Webhook booking → n8n**: verificare che l'evento booking_created emesso da
   createBooking arrivi correttamente ai webhook configurati (e che il contatto
   auto-creato non generi eventi duplicati).
3. **ONDA 2 Phase 5 — Outbound conversations**: implementare conversazioni
   outbound per i contatti.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- Booking API surface (/v1/bookings) — Phase 1 + config per-tenant + OpenAPI.
- Booking Calendar sync — Phase 2 (config + hook create/cancel + OpenAPI).
- updateCalendarEvent hook su PUT booking — Phase 2 refinements.
- Public booking page — Phase 3 (form EJS, slot computation, route pubbliche).
- Auto-create contatto CRM su booking — Phase 2 refinements.
- **v1 Payment Links API** — Phase 4 (payment-links CRUD + mark-paid + OpenAPI).
- **Rate-limit per-tenant** — Phase 4 ext (tenant_config key=rate_limits).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).