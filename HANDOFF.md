# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **TUTTO COMPLETATO (21/08/2026)**: tutte le funzionalità del backlog sono state
  implementate, testate e integrate. Nessun blocco funzionale rimanente.

## COSTRUITO IN QUESTO RUN

1. **Fix migrazione `082_scoring_threshold_trigger_on.sql`** — la colonna
   `trigger_on` su `scoring_thresholds` non era stata applicata al DB, causando
   5 fallimenti in `onda2-scoring-decay.test.js`:
   - `column "trigger_on" does not exist` in `scoring.js` (checkDecayThresholds)
   - 500 error in route `POST /v1/scoring-thresholds` (crm-agent.js)
   - Tick scoring decay step saltato perché `applyScoreDecay` crashava
   - **Risolto**: eseguito `node db/migrate.js` → migration 082 applicata con
     `ADD COLUMN IF NOT EXISTS trigger_on VARCHAR(10) NOT NULL DEFAULT 'above'`
   - Tutti i 6 test di `onda2-scoring-decay.test.js` ora passano

2. **Verifica completo**: eseguita full suite (763 test, 757 pass, 0 fail, 6 skip).

## STATO FINALE DEL PROGETTO

Tutte le funzionalità pianificate sono implementate e testate:

| Area | Stato |
|------|-------|
| **F0** — Fondamenta (tenancy, auth, pipeline, custom fields, config, location mapping) | ✅ |
| **ONDA 1** — Core CRM (contatti, opportunità, custom fields, webhook OUT, import tool, OpenAPI) | ✅ |
| **ONDA 2** — Booking/Calendario/Pagamenti/Conversazioni/Event-driven triggers (Phase 1-6) | ✅ |
| **ONDA 3** — Dashboard/Funnel, Analitica & Reporting, export CSV/JSON | ✅ |
| **ONDA 4** — Webhook enrichment, Quotes/Board/Merge v1 API, Segmenti/Workflow/Scoring v1 API | ✅ |

## PUNTI DI VERIFICA (questo run)
- ✅ **Migration 082 applicata** — `trigger_on` colonna presente su `scoring_thresholds`
- ✅ **763 test eseguiti, 757 pass, 0 fail** — nessuna regressione
- ✅ **Tutti i test Scoring Decay ripassano** — 6/6 dopo fix
- ✅ **Nessun segreto** nel codice
- ✅ **Commit locale** — 1 file modificato (HANDOFF.md)

## PROSSIMO BLOCCO CONSIGLIATO
**BACKLOG ESAURITO**. Tutte le funzionalità pianificate (F0 + ONDA 1-4) sono
complete e passano. Attendere input umano per:
- Definire nuove priorità / backlog oltre v1
- Eventuali miglioramenti UX, performance, security hardening
- Preparazione per pubblicazione / deploy

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-6 (booking, calendar sync, public page, payments, conversations, event-driven triggers, scheduler tick, scoring decay, segment refresh).
- ONDA 3 (Dashboard/Funnel, Analitica & Reporting, export CSV, import avanzato file CSV/JSON).
- ONDA 4 (Webhook OUT event enrichment + Quotes/Board/Merge v1 API + Segmenti/Workflow/Scoring v1 API).

## COSE DA NON FARE
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.