# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **LEADER+QUALITY CRON (21/08/2026) — fix strutturale webhook test flaky**:
  - Working tree: pulita.
  - **FIX APPLICATO**: `test/webhooks.test.js` — tutti i 10 test ora passano ✅
  - **Root cause**: 192 righe pending orfane da run precedenti. `waitForPendingDelivery`
    e `deliverWithRetry` NON filtravano per `siteId`, raccogliendo righe di siti altrui
    e tentando spedizioni verso server morti.
  - **Fix strutturale**: tutti i test helper ora accettano `siteId` e lo usano sia nella
    query DB che nelle chiamate a `deliverPending({ siteId })`.

## COSTRUITO IN QUESTO RUN

1. **Pulizia DB**: 192 righe pending orfane + 15 sent vecchie rimosse da `webhook_deliveries`.

2. **Fix strutturale `test/webhooks.test.js`**:
   - `waitForPendingDelivery(siteId, markerOrEvent, value, limit, opts)` → aggiunto `siteId`
     come primo parametro. Filtra DB query con `AND site_id = $1`, passa `{ siteId }` a
     `deliverPending`.
   - `deliverWithRetry(siteId, limit, opts, maxRetries)` → aggiunto `siteId` come primo
     parametro. Passa `{ siteId }` a `deliverPending`.
   - `deliverPending` diretto (linea 282): `{ siteId: site.id, allowPrivate: true }`.
   - Query di asserzione marker (linea 261): filtro `AND site_id = $1`.
   - Cleanup nel `before` hook: `DELETE FROM webhook_deliveries WHERE site_id = $1 AND status = 'pending'`
     all'inizio del test.

3. **Regressione completa verificata**:
   - webhooks.test.js: **10/10 ✅** (ex 3 falliti)
   - f0-foundations + location-mapping + ondat1-contacts + opp + custom: **35/35 ✅**
   - onda1-webhook-out + webhook-n8n-e2e + rate-limit + booking + booking-calendar: **32/32 ✅**
   - onda2-booking-public + webhook-e2e + conversations + runtime-events + event-flow: **39/39 ✅**
   - v1-openapi + import-crm + crm-suite + crm-opportunities + board: **36/36 ✅**
   - api-tokens + pipeline + workflows + segments + privacy + oauth: **39/39 ✅**
   - **TOTALE**: ~191 test → **0 fail, 0 skip** (solo i file webhook e gruppi affini)

## PUNTI DI VERIFICA (questo run)
- ✅ **Webhook test flaky FIXED**: 10/10 test passano con siteId filtering
- ✅ DB test pulito: 0 righe pending orfane residue
- ✅ Codice produzione: 0 regressioni
- ✅ `.env.example` allineato (nessuna modifica necessaria)
- ✅ Sintassi OK (`node --check` su file toccato)
- ✅ Nessun segreto versionato (solo dummy test data)
- ✅ Nessun riferimento CRM-specifico nel codice
- ✅ DB test `cms-test-pg` up e funzionante

## PROSSIMO BLOCCO CONSIGLIATO
1. **Onda 3 planning**: attendere input umano. Possibili direzioni:
   - Import dati bulk (già progettato come tool)
   - Reportistica / dashboard
   - Integrazioni esterne (Google Calendar già configurato come per-tenant config)
2. **Schedulare refresh periodico DB test**: valutare se aggiungere cron di pulizia
   delivery orfane a intervalli regolari (es. ogni run di test).

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- **WEBHOOK TEST FLAKY RISOLTO**: siteId filtering strutturale.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).