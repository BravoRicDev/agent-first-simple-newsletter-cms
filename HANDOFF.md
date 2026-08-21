# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **ONDA 4 — v1 API enrichment (21/08/2026) — COMPLETATO**:
  - Working tree pulita dopo commit locale.
  - **COSTRUITO**: surface /v1 arricchita con Quotes API (CRUD + status + PDF),
    Kanban Board, Contact Merge.
  - Nuovi test `onda1-quotes-v1.test.js` (13 test) e `onda1-kanban-merge-v1.test.js`
    (8 test) coprono: CRUD preventivi, cambio stato, generazione PDF, merge
    contatti, board kanban, e spostamento stage + isolamento tenant.
  - OpenAPI spec aggiornato con route quotes, board, merge.

## COSTRUITO IN QUESTO RUN

1. **Quotes API — /v1/quotes**:
   - Route: `GET /quotes`, `POST /quotes`, `GET /quotes/:id`, `PUT /quotes/:id`,
     `PUT /quotes/:id/status`, `DELETE /quotes/:id`, `GET /quotes/:id/pdf`
   - Servizi riusati da `src/services/opportunities.js` (già esistenti)
   - PDF generato al volo con pdfkit e servito inline
   - Eventi quote_sent/viewed/signed emessi via setQuoteStatus → webhook OUT

2. **Kanban Board — /v1/opportunities/board + move**:
   - `GET /opportunities/board` — raggruppa opp. per stage con colonne
   - `PUT /opportunities/:id/move` — sposta opportunità tra stage (kanban drag&drop)

3. **Contact Merge — /v1/contacts/merge**:
   - `POST /contacts/merge` — unisce due contatti (source → into) con merge transazionale

4. **OpenAPI spec**:
   - Schema `Quote` aggiunto a components.schemas
   - Paths: `/quotes`, `/quotes/{id}`, `/quotes/{id}/status`, `/quotes/{id}/pdf`
   - Paths: `/opportunities/board`, `/opportunities/{id}/move`, `/contacts/merge`

5. **Test (26 test, 0 fail)**:
   - `test/onda1-quotes-v1.test.js`: 13 test — tutti pass
   - `test/onda1-kanban-merge-v1.test.js`: 8 test — tutti pass
   - `test/v1-openapi.test.js`: 5 test — tutti pass (aggiornato per nuove route)

6. **Verifica regressioni** (31 test suite v1): 31/31 pass — 0 fail

## PUNTI DI VERIFICA (questo run)
- ✅ **26 test nuovI + 5 test OpenAPI = 31 test, 0 fail** — nessuna regressione
- ✅ **Sintassi OK**: `node --check` su tutti i file toccati
- ✅ **Nessun segreto**, nessun riferimento CRM-specifico nel codice
- ✅ **Migrazioni SQL**: nessuna migrazione nuova (tabelle già esistenti da 045)
- ✅ **Nessuna decisione [APERTA]** in DECISIONI_UMANE.md
- ✅ **Commit locale** — 6 file modificati

## PROSSIMO BLOCCO CONSIGLIATO
1. **ONDA 4 — Expose CRM agent routes su /v1**: segmenti, workflow, scoring sono
   esposti solo su `/api/agent/` ma sono già pronti. Potrebbero essere utili
   anche su `/v1/` per consumatori esterni.
2. **Oppure**: attendere input umano per definire prossimo backlog.
3. **Oppure**: arricchire payload webhook OUT con dati completi contatto/opportunità.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-6 (booking, calendar sync, public page, payments, conversations, event-driven triggers).
- ONDA 3 (Dashboard/Funnel, Analitica & Reporting, export CSV, import avanzato file CSV/JSON).
- ONDA 4 (Webhook OUT event enrichment + Quotes/Board/Merge v1 API).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).