# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **ONDA 4 — CRM agent feature su /v1 (21/08/2026) — COMPLETATO**:
  - Working tree pulita dopo commit locale.
  - **COSTRUITO**: Segmenti, Workflow, Scoring esposti su /v1 con route complete,
    OpenAPI spec, e 36 test di copertura.
  - Nuovo test `v1-segments-workflows-scoring.test.js` (36 test) copre: CRUD
    segmenti, preview, members, recount, CRUD workflow, test, runs, CRUD scoring
    rules, CRUD scoring thresholds, tenant isolation, validazione.

## COSTRUITO IN QUESTO RUN

1. **Segmenti — /v1/segments**:
   - Route: `GET /segments`, `POST /segments`, `GET /segments/:id`,
     `PUT /segments/:id`, `DELETE /segments/:id`, `GET /segments/:id/members`,
     `POST /segments/:id/recount`, `POST /segments/preview`
   - Servizio riusato da `src/services/segments.js` (già esistente)
   - Regole dinamiche valutate in-memory, membership materializzata

2. **Workflow — /v1/workflows**:
   - Route: `GET /workflows`, `POST /workflows`, `GET /workflows/:id`,
     `PUT /workflows/:id`, `DELETE /workflows/:id`, `GET /workflows/:id/runs`,
     `POST /workflows/:id/test`
   - Servizio riusato da `src/services/workflows.js` (già esistente)
   - Azioni: add_tag, remove_tag, set_stage, send_campaign, send_sequence,
     create_task, notify_email, wait_days

3. **Scoring — /v1/scoring-rules**:
   - Route: `GET /scoring-rules`, `POST /scoring-rules`,
     `GET /scoring-rules/:id`, `PUT /scoring-rules/:id`, `DELETE /scoring-rules/:id`
   - Servizio riusato da `src/services/scoring.js` (già esistente)

4. **Scoring Thresholds — /v1/scoring-thresholds**:
   - Route: `GET /scoring-thresholds`, `POST /scoring-thresholds`,
     `DELETE /scoring-thresholds/:id`
   - Soglie: set_stage, add_tag, notify_email

5. **OpenAPI spec**:
   - Schemi `Segment`, `Workflow`, `ScoringRule`, `ScoringThreshold`
   - Paths: segmenti (5 paths), workflow (5 paths), scoring (4 paths)
   - Tags: Segmenti, Workflows, Scoring

6. **Test (41 test, 0 fail)**:
   - `test/v1-segments-workflows-scoring.test.js`: 36 test — tutti pass
   - `test/v1-openapi.test.js`: 5 test — tutti pass (aggiornato per nuove route)

## PUNTI DI VERIFICA (questo run)
- ✅ **36 test nuovi + 5 test OpenAPI = 41 test, 0 fail** — nessuna regressione
- ✅ **Sintassi OK**: `node --check` su tutti i file toccati
- ✅ **Nessun segreto**, nessun riferimento CRM-specifico nel codice
- ✅ **Migrazioni SQL**: nessuna migrazione nuova (tabelle già esistenti: segments,
      segment_members, workflows, workflow_actions, workflow_runs,
      scoring_rules, scoring_thresholds, workflow_delayed_actions)
- ✅ **Nessuna decisione [APERTA]** in DECISIONI_UMANE.md
- ✅ **Commit locale** — 4 file modificati

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 4 — Webhook OUT event enrichment migliorato**: arricchire payload
   webhook OUT con dati completi contatto/opportunità e campi custom.
2. **Oppure**: ONDA 2 Phase 6 — Event-driven triggers avanzati (scheduler
   tick per delayed actions, scoring decay, segment refresh periodico).
3. **Oppure**: attendere input umano per definire prossimo backlog.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-6 (booking, calendar sync, public page, payments, conversations, event-driven triggers).
- ONDA 3 (Dashboard/Funnel, Analitica & Reporting, export CSV, import avanzato file CSV/JSON).
- ONDA 4 (Webhook OUT event enrichment + Quotes/Board/Merge v1 API + Segmenti/Workflow/Scoring v1 API).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).