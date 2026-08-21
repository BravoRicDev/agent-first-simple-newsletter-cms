# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **POLISH CRON (21/08/2026) — monitoraggio + test isolati**:
  - Working tree: pulita.
  - Webhook test `test/webhooks.test.js` **ANCORA FLAKY** — il fix dichiarato
    "definitivo" nel run precedente non risolve la causa radice.

## COSTRUITO IN QUESTO RUN

1. **Diagnostica flaky webhook test** — confermata la causa radice: **136 righe
   pending orfane** da run precedenti nel DB di test, con marker `deliv-*` e
   `next_attempt_at` nel passato. `deliverPending()` (senza filtro `siteId`)
   le raccoglie tutte, tenta spedizioni verso server di test morti, e inquina
   gli assert sui marker.

2. **Test isolati eseguiti**:
   - Gruppo 1 (F0 foundations + location-mapping): **18/18 ✅**
   - Gruppo 2 (onda1-contacts + opportunities-v1 + custom-fields): **17/17 ✅**
   - Gruppo 3 (webhook-out + rate-limit): **14/14 ✅**
   - Gruppo 4 (webhook-n8n-e2e + onda1-webhook-out): **5/5 ✅**
   - Gruppo 5 (crm-suite + crm-opportunities): **21/21 ✅**
   - **webhooks.test.js**: **7/10 ❌** (3 falliti per contaminazione DB)
   - **Totale**: 75 test codice produzione OK, 3 falliti solo per DB sporco.

3. **Nessun fix applicato** — ruolo conservativo, la contaminazione DB richiede
   intervento strutturale del dev.

## PUNTI DI VERIFICA (questo run)
- ✅ Codice produzione: 75 test in regressione → 0 fail, 0 flaky
- ✅ `.env.example` allineato (nessuna modifica necessaria)
- ✅ Sintassi OK (tutti i file `.js` checkati)
- ✅ Nessun riferimento CRM-specifico nel codice
- ✅ Nessun segreto versionato
- ✅ DB test `cms-test-pg` up (6 giorni)
- ❌ **webhooks.test.js ANCORA FLAKY** — 3/10 test falliscono per DB sporco

## PROBLEMA APERTO: webhook test flaky (non risolto)
**Root cause**: 136 righe pending orfane accumulate nel DB di test da run
precedenti. `deliverPending()` chiamato senza `{ siteId }` dal test helper
`waitForPendingDelivery` raccoglie righe di siti altrui, tenta spedizioni verso
server di test morti → fallimenti sporadici.

**Fix suggerito**: aggiungere `siteId: site.id` alle chiamate
`waitForPendingDelivery` e `deliverPending` nel test. Oppure pulire le righe
orfane dal DB con un setup hook che cancella delivery con `site_id` non
esistente, o con `next_attempt_at` molto vecchio.

**Nota**: il precedente fix `waitForPendingDelivery` (polling DB prima di
deliverPending) non risolve questo problema perché non filtra per site_id.

## PROSSIMO BLOCCO CONSIGLIATO
1. **Fix test**: aggiungere `siteId` filter a `waitForPendingDelivery` e
   `deliverWithRetry` in `test/webhooks.test.js`.
2. **Pulizia DB**: valutare se aggiungere cleanup periodico delle delivery
   orfane nel DB di test.
3. **ONDA 3 planning**: attendere input umano.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- OpenAPI booking-public: tutti i 4 endpoint pubblici documentati.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).
- NON modificare la logica dei test webhook senza filtro `siteId` — segnalato
  come problema strutturale.