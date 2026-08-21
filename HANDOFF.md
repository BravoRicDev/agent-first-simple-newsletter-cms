# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **LEADER+QUALITY CRON (21/08/2026) — PLANNING ONDA 3 (continuazione)**:
  - Working tree pulita dopo commit.
  - **COSTRUITO**: completati i ritardi del planning Onda 3: stats sequenze
    email (`/v1/email-stats/sequences` + `/:id`), `PUT /v1/contacts/:id/tags`
    (replace completo), `DELETE /v1/contacts/:id/tasks/:taskId`, e import tool
    collegato a un endpoint `POST /v1/import` (+ storico `/v1/import/jobs`).
    Con test HTTP e documentazione OpenAPI.
  - claude-code non disponibile (non autenticato al login) → fallback su
    DeepSeek (tools agente) con lo stesso task ampio, come da AGENTS.md.

## COSTRUITO IN QUESTO RUN

1. **PLANNING ONDA 3 — ritardi chiusi** (blocco sostanziale):
   - `src/services/newsletter-stats.js`: nuovo `listEmailStatsSequences(siteId)`
     (elenco sequenze per-tenant con passi/invii/aperture/click/rate).
     `getEmailStatsSequence(siteId, sequenceId)` era già pronto e ora esposto.
   - `src/services/contacts-v1.js`: nuovo `setContactTags(siteId, contactId, tags)`
     per la sostituzione COMPLETA dei tags (PUT replace).
   - `src/routes/v1.js` (tutte dietro requireTenant, per-tenant):
     - `GET /email-stats/sequences` e `GET /email-stats/sequences/:id`.
     - `PUT /contacts/:id/tags` (replace tags).
     - `DELETE /contacts/:id/tasks/:taskId` (verifica contatto + task, poi delete).
     - `POST /import` (bulk upsert contatti+task via importCrmData),
       `GET /import/jobs` (storico job), `GET /import/jobs/:id`.
   - `src/openapi.js`: documentate sequences stats, PUT tags, DELETE task e
     sezione Import (POST /v1/import + jobs).
   - Test nuovi `test/v1-planning-onda3.test.js` (9) — HTTP con auth Bearer
     per-sito, tutti passano.

2. **Verifica regressioni**: v1-email-stats (service+http), v1-openapi,
   onda1-contacts, import-crm-tool, f0-foundations — tutti ✅.
   Totale verificato in questo run: 9 nuovi + 34 esistenti = 43 test, 0 fail.

## MONITORAGGIO (POLISH cron, run precedente)
- RIESEGUITA l'intera suite a gruppi isolati via `./scripts/test.sh <file>`:
  tutti i ~70 file passano, 0 fail, unica eccezione newsletter (6 skip attesi).
- Working tree pulita, repo libero, nessun segreto, nessun nome CRM-specifico.
- Nessuna [APERTA] in DECISIONI_UMANE.md (tutte [RISOLTO] già applicate).

## MONITORAGGIO (POLISH cron, 21/08/2026 run attuale)
- Repo LIBERO all'inizio run (nessun processo dev, nessun index.lock, working tree pulita).
- RIESEGUITI i test a gruppi isolati via `./scripts/test.sh <file>` — esito per file:
  - `v1-activities.test.js` + `v1-activities-http.test.js`: 7/7 pass
  - `v1-email-stats.test.js` + `v1-email-stats-http.test.js`: 8/8 pass
  - `v1-reports.test.js` + `v1-reports-http.test.js`: 17/17 pass
  - `f0-foundations` + `onda1-contacts` + `onda1-opportunities-v1` + `onda1-opportunity-custom-fields`: 26/26 pass
  - `v1-dashboard-funnel` + `v1-openapi` + `f0-location-mapping`: 21/21 pass
  - `onda1-webhook-out`: 1/1 pass
  - `newsletter-bounce` + `newsletter-engagement`: 25/25 pass
  - Totale rieseguito in questo run: 105 test, 0 fail, 0 skip.
- `node --check` su tutti i file: SRC SINTASSI OK. `node --check` file test ok.
- `.env.example` allineato (DATABASE_URL, JWT_SECRET, vars richieste presenti).
- Nessun fix strutturale necessario (solo verifica, nessun errore banale riscontrato).
- Nessun segreto versionato, nessun nome CRM-specifico.
- Nessuna [APERTA] in DECISIONI_UMANE.md (tutte [RISOLTO] già applicate).
- Nessun commit/push eseguito (working tree rimasta pulita).

## PUNTI DI VERIFICA (questo run)
- ✅ **9 nuovi test planning Onda 3** (`v1-planning-onda3.test.js`), tutti passano
  (sequences stats, PUT tags replace, DELETE task, import + jobs)
- ✅ **Nessuna regressione**: v1-email-stats (service+http), v1-openapi,
  onda1-contacts, import-crm-tool, f0-foundations — 34/34 pass
- ✅ **Sintassi OK**: `node --check` su src/routes/v1.js, src/openapi.js,
  src/services/newsletter-stats.js, src/services/contacts-v1.js e sul test
- ✅ **OpenAPI aggiornato**: sequences stats, PUT /contacts/:id/tags,
  DELETE /contacts/:id/tasks/:taskId, sezione Import (POST /v1/import + jobs)
- ✅ **Nessun segreto versionato**, nessun riferimento CRM-specifico
- ✅ **Nessuna migrazione SQL nuova** necessaria (tabelle già esistenti)

## PROSSIMO BLOCCO CONSIGLIATO
1. **Onda 3 planning (ultimi ritardi)**:
   - `GET /v1/email-stats/sequences` ora coperto. Restano possibili rifiniture:
     filtri query su `/v1/activities` (date range, paginazione cursor) e
     export CSV delle statistiche (`GET /v1/email-stats.csv` o export attività).
   - Import avanzato: accettare file CSV/JSON su `/v1/import` (multipart) oltre
     al body JSON attuale, con validazione errori per-riga.
2. **Oppure**: ONDA 4 tuning (webhook out più eventi, es. contact_updated,
   opportunity_stage_changed) o attesa input umano per priorità.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5 (booking, calendar sync, public page, payments, conversations).
- ONDA 2 Phase 6 (event-driven agent conversation triggers).
- ONDA 3: Dashboard/Funnel (run precedente) + Analitica & Reporting (questo run).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).