# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **LEADER+QUALITY CRON (21/08/2026) — ONDA 3: Analitica & Reporting v1 API**:
  - Working tree pulita dopo commit.
  - **COSTRUITO**: surface v1 di analitica e reporting: `/v1/activities`,
    `/v1/contacts/:id/activities`, `/v1/email-stats`,
    `/v1/email-stats/campaigns`, `/v1/email-stats/campaigns/:id`, `/v1/reports`
    (CRUD), `/v1/reports/:id/run` (generazione dry-run), `/v1/reports/:id/runs`
    (storico), con test service-level + HTTP e documentazione OpenAPI.
  - claude-code non disponibile (non autenticato al login) → fallback su
    DeepSeek (tools agente) con lo stesso task ampio, come da AGENTS.md.

## COSTRUITO IN QUESTO RUN

1. **ONDA 3 — Analitica & Reporting v1 API** (blocco sostanziale):
   - `src/routes/v1.js`: aggiunte nuove route, tutte dietro requireTenant()
     (per-tenant):
     - `GET /activities` (filtri email|contactEmail, eventType anche CSV,
       limit/offset) e `GET /contacts/:id/activities`.
     - `GET /email-stats` (aggregato tenant: invii/aperture/click/rate),
       `GET /email-stats/campaigns` (campagne + stats per-campagna),
       `GET /email-stats/campaigns/:id` (dettaglio campagna).
     - `GET|POST /reports`, `GET|PUT|DELETE /reports/:id`,
       `POST /reports/:id/run` (generateReport DRY-RUN, NON invia email),
       `GET /reports/:id/runs` (storico esecuzioni).
   - `src/services/newsletter-stats.js`: nuove funzioni `getEmailStatsAggregate`
     e `listEmailStatsCampaigns` (con helper interni per compute rate).
   - `src/openapi.js`: definizioni OpenAPI per le nuove route (tags Attività,
     Email Stats, Report). Route `GET /v1/funnel` ripristinata (non persa).
   - Test nuovi (tutti passano):
     - `test/v1-activities.test.js` (4), `test/v1-email-stats.test.js` (3),
       `test/v1-reports.test.js` (8) — service-level.
     - `test/v1-activities-http.test.js` (3),
       `test/v1-email-stats-http.test.js` (5),
       `test/v1-reports-http.test.js` (9) — HTTP con auth Bearer per-sito.

2. **Verifica regressioni**: F0 foundations (9/9), Onda 1 contatti (8/8),
   Onda 1 opportunità (8/8) [21 pass in 3 file], custom fields (…), webhook-out,
   location-mapping, dashboard/funnel (14/14), OpenAPI (5/5) — tutti ✅.
   Totale verificato in questo run: 32 test nuovi + 40 esistenti = 72 test, 0 fail.

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
- ✅ **32 nuovi test Analitica & Reporting** (17 service + 15 HTTP), tutti passano
- ✅ **Nessuna regressione**: F0 9/9, Onda 1 contatti 8/8, opportunità 8/8,
  dashboard/funnel 14/14, OpenAPI 5/5
- ✅ **Sintassi OK**: `node --check` su src/routes/v1.js, src/openapi.js,
  src/services/newsletter-stats.js e sui 6 file di test
- ✅ **OpenAPI aggiornato**: tags + paths per attività, email-stats, reports
  (route /v1/funnel ripristinata)
- ✅ **Nessun segreto versionato**, nessun riferimento CRM-specifico
- ✅ **POST /v1/reports/:id/run usa SOLO generateReport (dry-run)**, nessuna
  email SMTP inviata in test

## PROSSIMO BLOCCO CONSIGLIATO
1. **Onda 3 planning (continua)**:
   - `GET /v1/email-stats/sequences` (stats sequenze email, service già pronto:
     `getEmailStatsSequence` in newsletter-stats.js).
   - `PUT /v1/contacts/:id/tags` (sostituzione tags completa) e
     `DELETE /v1/contacts/:id/tasks/:taskId`.
   - Import tool: collegare l'import dati (tool progettato, migrazione NON
     eseguita) a un endpoint v1 per il bulk-upsert.
2. **Oppure**: attendere input umano per priorità Onda 3.

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