# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **LEADER+QUALITY CRON (21/08/2026) — fix flaky test + verifica**:
  - Working tree: 1 commit oltre `648cae1` (polish monitoraggio).
  - **Flaky test `test/webhooks.test.js`** → **RISOLTO**:
    - Root cause: race su commit DB tra `enqueueForEvent()` (subtest b) e
      `deliverPending()` (subtest c) + race sul bind della porta effimera del
      delivery server.
    - Fix: `waitForServer()` (5 tentativi di health-check TCP dopo listen(0))
      + `deliverWithRetry()` (3 tentativi con backoff 100-300ms).
    - Verificato: 8/8 run consecutive con 10/10 test pass (0 fail).
  - **Verifica ampia** dopo il fix (4 gruppi, 169 test): tutti pass.
  - DB test `cms-test-pg` up e funzionante.

## COSTRUITO IN QUESTO RUN (1 commit: 1b2c523)

1. **Commit fix flaky webhook test**:
   - `waitForServer(srv)` helper — health-check TCP con 5 tentativi e backoff
     progressivo (50-250ms) dopo `listen(0)`.
   - `deliverWithRetry()` helper — 3 tentativi di `deliverPending` con backoff
     100-300ms, per coprire race su commit DB tra subtests.
   - Applicato ai 2 test che chiamano `deliverPending` dopo `enqueueForEvent`.
   - 8 run isolati consecutivi: **10/10 test, 0 fail per run**.
2. **Verifica post-fix** (4 gruppi):
   - Gruppo 1: f0-foundations + f0-location-mapping + route-order + sandbox → 27/27 ✅
   - Gruppo 2: onda1-contacts + opportunities + custom-fields + webhook-out + rate-limit → 31/31 ✅
   - Gruppo 3: onda2-booking + booking-public + conversations + v1-payments → 38/38 ✅
   - Gruppo 4: webhook-n8n-e2e + v1-openapi + api-tokens + auth-rate-limit → 16/16 ✅
   - Gruppo 5: crm-native (opportunities, board, conversations, segments, suite, pipeline, rbac, modules, privacy) → 77/77 ✅
   - **Totale verificato**: 169 test, 0 fail.

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check test/webhooks.test.js`: sintassi valida
- ✅ Flaky test webhooks.test.js: 8/8 run consecutive 10/10 pass (prima: ~1/10 fail)
- ✅ Nessun segreto nel codice
- ✅ Nessun `.env` versionato
- ✅ Nessun `git reset --hard` / force
- ✅ Nessun remote — commit locale soltanto
- ✅ DB test `cms-test-pg` up e funzionante
- ✅ Migrazioni idempotenti (nessuna migrazione toccata)
- ✅ Commit: `1b2c523` — `fix(test): flaky webhook test — deliverWithRetry + waitForServer`

## PROSSIMO BLOCCO CONSIGLIATO
1. **Bulk regression test completo**: rieseguire tutti i 71 file test per
   confermare la baseline (572 test, come da HANDOFF precedente).
2. **Performance/security test**: rate limiting per-tenant su booking e
   payment-links, limiti di prenotazione (lead time, finestra).
3. **ONDA 3 / ONDA 4 planning**: attendere input umano per il prossimo blocco
   funzionale (ROADMAP.md non ha specifiche oltre ONDA 2).

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- OpenAPI booking-public: tutti i 4 endpoint pubblici documentati.
- **Flaky test RISOLTO**: `test/webhooks.test.js` — retry + health-check
  elimina la race su porta effimera.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).