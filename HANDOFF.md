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
- **WEBHOOK OUT delivery e2e (n8n simulator)**: **COMPLETO** (run precedente).
- **POLISH CRON — Verifica sintassi, DECISIONI_UMANE, test**: **COMPLETO** (questo run).

## COSTRUITO IN QUESTO RUN (nessun commit)

Nessuna modifica al codice. Solo verifica di regressione su un campione
rappresentativo di test (~23 file, ~200 test). Risultato: 0 fail.

### Test verificati (per file, tutti pass)

| File | Test | Esito |
|------|------|-------|
| test/f0-foundations.test.js | 9 | ✅ |
| test/f0-location-mapping.test.js | 9 | ✅ |
| test/v1-rate-limit.test.js | 13 | ✅ |
| test/v1-openapi.test.js | 5 | ✅ |
| test/onda1-contacts.test.js | 8 | ✅ |
| test/onda1-opportunities-v1.test.js | 4 | ✅ |
| test/onda1-opportunity-custom-fields.test.js | 5 | ✅ |
| test/onda1-webhook-out.test.js | 1 | ✅ |
| test/onda2-booking.test.js | 6 | ✅ |
| test/onda2-booking-calendar.test.js | 8 | ✅ |
| test/onda2-booking-public.test.js | 9 | ✅ |
| test/onda2-booking-webhook-e2e.test.js | 3 | ✅ |
| test/onda2-conversations-v1.test.js | 14 | ✅ |
| test/onda2-runtime-events.test.js | 7 | ✅ |
| test/onda2-runtime-event-flow.test.js | 6 | ✅ |
| test/webhook-n8n-e2e.test.js | 4 | ✅ |
| test/webhooks.test.js | 10 | ✅ |
| test/payments.test.js | 7 | ✅ |
| test/v1-payments.test.js | 9 | ✅ |
| test/crm-suite.test.js | 10 | ✅ |
| test/auth-rate-limit.test.js + api-tokens + rbac | 29 | ✅ |
| test/crm-conversations.test.js + crm-opportunities | 23 | ✅ |
| test/import-crm-tool.test.js + export-import + pipeline | 15 | ✅ |
| test/crm-segments.test.js + crm-workflows.test.js | 14 | ✅ |

**Totale verificato: ~230 test, 0 fail**

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check` su tutti i file `src/*.js`: nessun errore sintattico
- ✅ DECISIONI_UMANE: tutti [RISOLTO] già applicati, nessun [APERTA]
- ✅ Nessun segreto nel codice
- ✅ Nessun `.env` versionato
- ✅ Nessun `git reset --hard` / force

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