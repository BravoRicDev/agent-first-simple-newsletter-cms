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
- **POLISH CRON — Verifica sintassi, DECISIONI_UMANE, test**: **COMPLETO** (run precedente).
- **OpenAPI booking-public — documentati 3 endpoint pubblici (slot JSON, form HTML, conferma)**: **COMPLETO** (questo run).

## COSTRUITO IN QUESTO RUN (1 commit: a15fcb6 + 8cf398a)

1. **Commit checkpoint HANDOFF.md** — committata la versione aggiornata dal polish run.
2. **OpenAPI booking-public** — aggiunti 3 percorsi pubblici a `src/openapi.js`:
   - `GET /booking-public/{siteId}/slots` — slot disponibili (JSON, `BookingSlots` schema opzionale `?days=N`)
   - `GET /booking-public/{siteId}` — form HTML prenotazione
   - `POST /booking-public/{siteId}` — creazione prenotazione (rate limited 10/min)
   - `GET /booking-public/{siteId}/confirmed` — pagina HTML conferma
   - Nuovo tag `"Booking Public"` nella spec
   - Nuovo schema `BookingSlots` in components.schemas
3. **Test OpenAPI aggiornato** — `test/v1-openapi.test.js` ora verifica che i 3 percorsi booking-public siano presenti nello spec.

### Test verificati (per file, tutti pass)

| File | Test | Esito |
|------|------|-------|
| test/v1-openapi.test.js | 5 | ✅ (verifica nuovi 3 percorsi booking-public) |
| test/onda2-booking-public.test.js | 9 | ✅ |
| test/f0-foundations.test.js | 9 | ✅ |
| test/onda2-booking.test.js | 6 | ✅ |

**Totale verificato: 29 test, 0 fail**

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check` su `src/openapi.js`: nessun errore sintattico
- ✅ `node --check` su `test/v1-openapi.test.js`: nessun errore sintattico
- ✅ DECISIONI_UMANE: tutti [RISOLTO] già applicati, nessun [APERTA]
- ✅ Nessun segreto nel codice
- ✅ Nessun `.env` versionato
- ✅ Nessun `git reset --hard` / force
- ✅ Nessun remote — commit locali soltanto

## PROSSIMO BLOCCO CONSIGLIATO
1. **Performance/security test**: verificare che rate limiting per-tenant funzioni
   su booking e payment-links, e che i limiti di prenotazione (lead time, finestra)
   siano rispettati.
2. **Test di regressione bulk**: eseguire tutti i ~480 test in un'unica sessione
   per confermare che non ci siano leak di stato tra suite.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- **OpenAPI booking-public**: tutti e 4 gli endpoint pubblici documentati.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).