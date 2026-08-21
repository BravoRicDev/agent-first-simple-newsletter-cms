# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **CODING CRON (21/08/2026) — fix definitivo flaky webhook test + regressione test**:
  - Working tree: 3 file modificati (`.env.example`, `HANDOFF.md`, `test/webhooks.test.js`).
  - **Fix definitivo flaky webhook test**: sostituito `deliverWithRetry` (3 tentativi, 600ms totali)
    con `waitForPendingDelivery` — prima polla il DB fino a 15 tentativi (~9.6s totali)
    per accertarsi che la riga pending sia visibile, poi chiama `deliverPending`.
    `deliverWithRetry` mantenuto come retrocompatibilità con 5 tentativi e backoff 250ms.
  - **10x webhook test consecutivi**: 100/100 ✅ (10/10 per run, 0 fail). Frequenza
    flaky era ~1/15 → ora ZERO in 10 run. Fix definitivo.
  - DB test `cms-test-pg` up e funzionante.

## COSTRUITO IN QUESTO RUN

1. **Fix definitivo flaky webhook test** (`test/webhooks.test.js`):
   - Nuovo helper `waitForPendingDelivery(markerOrEvent, value, limit, opts)`:
     - Polla il DB (`SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending' AND payload->>'marker'=$1`)
     - Fino a 15 tentativi con backoff 80*(i+1) ms (~9.6s totale)
     - Poi chiama `deliverPending` solo dopo aver confermato visibilità riga
   - `deliverWithRetry` aggiornato: 5 retries (era 3), backoff 250ms (era 100ms)
   - Test (c) "deliverPending spedisce con X-Webhook-Event e firma HMAC" → usa `waitForPendingDelivery("marker", "deliv-b")`
   - Test (l) "emitContactEvent inoltra al webhook out" → usa `waitForPendingDelivery("marker", "deliv-l")`
   - La root cause era la race tra commit DB e query di `deliverPending` — eliminata con polling esplicito.

2. **Regressione test estesa** (8 gruppi, 275 test):
   - Gruppo 1 (f0-foundations + f0-location-mapping + route-order + sandbox): **27/27 ✅**
   - Gruppo 2 (onda1-contacts + opportunities + custom-fields + webhook-out + rate-limit): **31/31 ✅**
   - Gruppo 3 (webhook-n8n-e2e + v1-openapi + v1-payments): **18/18 ✅**
   - Gruppo 4 (onda2-booking + booking-calendar + booking-public): **23/23 ✅**
   - Gruppo 5 (onda2-conversations + booking-webhook-e2e + runtime-events + runtime-event-flow): **30/30 ✅**
   - Gruppo 6 (crm-native: api-tokens + auth-rate-limit + conversations + opportunities + board + suite + workflows): **53/53 ✅**
   - Gruppo 7 (pipeline + rbac + modules + privacy + import-tool): **35/35 ✅**
   - Gruppo 8 (agent-builder + agent-runtime + kb + recurring + suggestions + call-summaries + call-recordings): **58/58 ✅**
   - **10x webhooks.test.js**: **100/100 ✅**
   - **Totale**: 275 test, **0 fail**, **0 flaky**, 0 skip.

3. **Verifica naming**: nessun riferimento a CRM specifico (hubspot/salesforce/zoho/pipedrive)
   in src/, docs/, README.md — naming generico OK.

## PUNTI DI VERIFICA (questo run)
- ✅ Flaky webhook test definitivamente risolto: `waitForPendingDelivery` elimina race DB
- ✅ 10 run consecutive webhook test → 0 fail (era ~1/15)
- ✅ 275 test in regressione → 0 fail, 0 flaky
- ✅ Nessun segreto nel codice, nessun `.env` versionato
- ✅ Nessun `git reset --hard` / force
- ✅ Nessun remote — nessun commit/push
- ✅ DB test `cms-test-pg` up e funzionante
- ✅ Migrazioni idempotenti (nessuna migrazione toccata)
- ✅ Naming generico verificato — nessun CRM-specific name

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 3 planning**: attendere input umano con specifiche (ROADMAP.md non ha
   dettagli oltre ONDA 2). Possibili aree: automazioni avanzate, analytics
   estesi, integrazioni esterne.
2. **Performance test**: quando ONDA 3 è definita, valutare benchmark per
   endpoint critici (contatti, webhook delivery).
3. **(Opzionale) Stress test webhook**: lanciare webhooks.test.js 100+ volte
   in background per validare solidità del fix.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- OpenAPI booking-public: tutti i 4 endpoint pubblici documentati.
- **✅ Flaky test `test/webhooks.test.js` DEFINTIVAMENTE RISOLTO** —
  `waitForPendingDelivery` con polling DB elimina la race condition.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).