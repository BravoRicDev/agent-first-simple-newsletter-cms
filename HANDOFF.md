# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 Phase 1-5**: booking, calendar sync, public page, payments,
  conversations — tutte **COMPLETE**.
- **ONDA 2 Phase 6 — Event-driven agent conversation triggers**: **COMPLETO**.
- **REFINEMENT — Test gap + e2e event pipeline**: **COMPLETO**.
- **WEBHOOK OUT delivery e2e (n8n simulator)**: **COMPLETO** (questo run).

## COSTRUITO IN QUESTO RUN (nuovo commit)

### test/webhook-n8n-e2e.test.js — Webhook OUT delivery e2e (4 test)
Test end-to-end del flusso webhook OUT con consegna HTTP reale a un server
simulato (n8n simulator), coprendo:

1. **HMAC signature (1 test)**: crea webhook con secret, trigger evento
   contact_created, enqueueForEvent + deliverPending con allowPrivate=true →
   verifica che l'n8n simulator riceva la richiesta con header
   X-Webhook-Signature corretto (HMAC-SHA256 calcolato col secret del webhook).
   Verifica anche X-Webhook-Event e payload body.

2. **Retry con backoff (1 test)**: n8n risponde 503 al primo tentativo →
   delivery rimane "pending" con attempts=1 e next_attempt_at in futuro
   (backoff esponenziale 2^1=2 min). Forzando next_attempt_at al passato, il
   secondo tentativo consegna con successo (200). Verifica almeno 2 richieste
   HTTP ricevute dal simulatore.

3. **Max tentativi → failed (1 test)**: webhook verso endpoint che risponde
   sempre 503 → dopo MAX_ATTEMPTS (5) delivery va in status "failed".
   Forza next_attempt_at prima di ogni tentativo.

4. **Isolamento tenant (1 test)**: pulisce webhook di Tenant A, crea webhook
   solo su Tenant B per contact_created. Evento su Tenant A → deliverPending
   su A non consegna nulla (0 delivered). Evento su Tenant B → consegna
   correttamente (1 delivered).

### Verifica regressione
- v1-OpenAPI (5 test): ✅ 5/5
- F0 foundations + location + rate-limit (31 test): ✅ 31/31
- ONDA 1 contacts + opportunities + custom-fields + webhook (18 test): ✅ 18/18
- ONDA 2 booking + booking-calendar (23 test): ✅ 23/23
- ONDA 2 booking webhook e2e (3 test): ✅ 3/3
- **Nuovo webhook n8n e2e (4 test)**: ✅ 4/4
- **Totale verificato: ~84 test, 0 fail**

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check` su test/webhook-n8n-e2e.test.js: OK
- ✅ Nuovo test: webhook n8n e2e (4 test) — tutti pass (HMAC, retry, max-failed, isolation)
- ✅ Regressione zero (0 fail su ~84 test verificati)
- ✅ Nessun segreto nel codice (tutti i secret generati con crypto.randomBytes)
- ✅ Nessun `git reset --hard` / force
- ✅ DECISIONI_UMANE: nessun [APERTA] — tutti [RISOLTO] già applicati

## PROSSIMO BLOCCO CONSIGLIATO
1. **Performance/security test**: verificare che rate limiting per-tenant funzioni
   su booking e payment-links, e che i limiti di prenotazione (lead time, finestra)
   siano rispettati.
2. **OpenAPI per booking-public**: documentare gli endpoint pubblici di booking
   (GET /booking-public/:siteId/slots, /booking-public/:siteId, POST /booking-public/:siteId
   e /booking-public/:siteId/confirmed) in una sezione OpenAPI dedicata.
3. **Test di regressione bulk**: eseguire tutti i ~480 test in un'unica sessione
   per confermare che non ci siano leak di stato tra suite.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- **Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation**.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).