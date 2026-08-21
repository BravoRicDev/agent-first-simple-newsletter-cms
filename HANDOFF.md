1|# HANDOFF — passaggio di consegna
2|
3|File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
4|riparte esattamente da qui.
5|
6|## FASE CORRENTE
7|- **LEADER+QUALITY CRON (21/08/2026) — PLANNING ONDA 3 (continuazione)**:
8|  - Working tree pulita dopo commit.
9|  - **COSTRUITO**: Import avanzato su `/v1/import`: file CSV/JSON via multipart
10|    (`campo file`) o body `text/csv` grezzo, oltre al body JSON backward-compat.
11|    Ogni job registra filename, ogni errore riporta il numero di riga fisica.
12|  - claude-code non disponibile (non autenticato) → fallback su DeepSeek (tools
13|    agente) con lo stesso task ampio, come da AGENTS.md.
14|
15|## COSTRUITO IN QUESTO RUN
16|
17|1. **PLANNING ONDA 3 — import avanzato /v1/import (file CSV/JSON + text/csv)**:
18|   - `src/services/csv.js`: Nuova funzione `parseCsv(text, {hasHeader, maxRows})` —
19|     parser CSV robusto con quote/doppie quote/embedded newline/filtro righe vuote.
20|   - `src/services/export-import.js`:
21|     - `importContactRows` e `importTaskRows` ora accettano `lineOffset` e
22|       producono errori con `{row, line, error}` per report per-riga.
23|     - `insertImportJob` accetta e registra `filename` (non più vuoto).
24|     - `importContacts`, `importCrmData`: passano `filename` e `lineOffset`.
25|     - Nuova `importFromFile(siteId, {filename, text, created_by})` — deduce JSON
26|       o CSV dall'estensione/contenuto, parsifica e importa contatti/task con
27|       report completo. JSON non valido → job con errore (0 importati).
28|   - `src/middleware/body-validate-v1.js`: ora permette `multipart/form-data` e
29|     `text/csv` (non più 415 per la route /v1/import).
30|   - `src/routes/v1.js`:
31|     - aggiunto `multer` per upload multipart (`file` field, 10MB limite).
32|     - aggiunto `express.text({type:["text/csv"]})` a livello router.
33|     - Route `/v1/import` riscritta per gestire 3 varianti: JSON body, multipart
34|       file (CSV o JSON), body text/csv raw.
35|     - `readRawBody` helper (semplificato con express.text).
36|   - `src/openapi.js`: /v1/import documenta ora i 3 content-type supportati e la
37|     risposta comprehensive (job_id, imported, skipped, tasks_*, errors con line).
38|   - `test/v1-import-file.test.js` (7 test nuovi): multipart CSV (2 buoni + valid
39|     per-riga skipped con line number), JSON array, body text/csv, JSON malformato
40|     (errore line 1), backward compat JSON body, GET /import/jobs con filename.
41|
42|2. **Fix correlati**:
43|   - `test/export-import.test.js`: aggiornato `deepEqual` per includere `line`
44|     (aggiunto dal nuovo formato errori).
45|
46|3. **Verifica regressioni**:
47|   - New file test: 7/7 pass
48|   - export-import: 8/8 pass
49|   - v1-planning-onda3: 9/9 pass
50|   - v1-csv-export: 11/11 pass
51|   - f0-foundations + onda1-contacts + opportunities + custom-fields + webhook:
52|     32/32 pass
53|   - f0-location-mapping + v1-dashboard-funnel + v1-reports + v1-email-stats + http:
54|     59/59 pass (10 suite)
55|   - Totale verificato in questo run: 7 nuovi + 59 regressione = 66 test, 0 fail.
56|
57|## PUNTI DI VERIFICA (questo run)
58|- ✅ **7 nuovi test import-file** (`test/v1-import-file.test.js`), tutti passano
59|  (multipart CSV/JSON, text/csv, backward compat, errori con line number, filename
60|  registrato, JSON malformato, GET jobs).
61|- ✅ **Nessuna regressione**: 59 test esistenti in 10 suite, 0 fail.
62|- ✅ **Sintassi OK**: `node --check` su csv.js, export-import.js, v1.js, openapi.js,
63|  body-validate-v1.js, test file — tutti ok.
64|- ✅ **OpenAPI aggiornato**: /v1/import tre content-type + risposta arricchita.
65|- ✅ **Migrazioni SQL**: nessuna migrazione nuova necessaria (niente cambi di
66|  schema — filename era già nel DB con default).
67|- ✅ **Nessun segreto versionato**, nessun riferimento CRM-specifico.
68|- ✅ **Nessuna decisione [APERTA]** in DECISIONI_UMANE.md.
69|
70|## PROSSIMO BLOCCO CONSIGLIATO
71|1. **Onda 3 planning (ultimo ritardo dopo questo)**: import avanzato su
72|   `/v1/import` — accettare file CSV/JSON (multipart o text/csv) oltre al body
73|   JSON attuale, con validazione errori per-riga e report dettagliato per job.
74|   **COMPLETATO in questo run — prossimo blocco**.
75|2. **Oppure**: ONDA 4 tuning — webhook out su più eventi già presenti
76|   (opportunity_stage/status_changed, contact_updated, quote_*); eventuale
77|   arricchimento payload o nuovi trigger. Attendere input umano per priorità.
78|3. **Review ROADMAP**: verificare se ONDA 3 planning è ora completo (import
79|   file/CSV era l'ultima milestone delle activity/import/stat CSV) e se si passa
80|   al backlog Onda 4.
81|
82|## COSE GIÀ PRONTE
83|- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
84|- ONDA 2 Phase 1-5 (booking, calendar sync, public page, payments, conversations).
85|- ONDA 2 Phase 6 (event-driven agent conversation triggers).
86|- ONDA 3: Dashboard/Funnel + Analitica & Reporting + export CSV + import avanzato
87|  (file CSV/JSON via multipart/text-csv). Planning Onda 3 **sostanzialmente**
88|  **completo**.
89|
90|## COSE DA NON FARE
91|- NON pushare su GitHub (nessun remote). Solo commit locali.
92|- NON usare il nome del CRM di origine nel codice/docs/README.
93|- NON risolvere decisioni [APERTA] — spettano all'umano.
94|- NON riportare custom fields opportunità in `contact_custom_values` (FK su
95|  contacts): usare SEMPRE `opportunity_custom_values` (076).