# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **LEADER+QUALITY CRON (21/08/2026) — PLANNING ONDA 3 (continuazione)**:
  - Working tree pulita dopo commit.
  - **COSTRUITO**: completato il primo "prossimo blocco" suggerito: export CSV +
    filtri temporali + paginazione a cursore su Attività e Statistiche email.
  - claude-code non disponibile (non autenticato al login) → fallback su
    DeepSeek (tools agente) con lo stesso task ampio, come da AGENTS.md.

## COSTRUITO IN QUESTO RUN

1. **PLANNING ONDA 3 — export CSV + filtri temporali + cursor pagination**
   (blocco sostanziale, primo "prossimo blocco" suggerito dal run precedente):
   - `src/routes/v1.js`:
     - Nuovo helper `toCsv(rows, columns)` (esportato): genera un documento
       CSV con header, escape di quote/virgole/a-capo, separatore `,`.
     - `fetchActivities` ora supporta `from`/`to` (range su created_at),
       `cursor` (paginazione keyset su id DESC, più efficiente dell'offset)
       e ritorna anche `nextCursor` (ultima id se c'è una pagina successiva).
     - `GET /v1/activities`: passa i nuovi filtri; con `?format=csv` restituisce
       `text/csv` con download header. Alias `startDate`/`endDate` per from/to.
     - `GET /v1/email-stats/campaigns` e `GET /v1/email-stats/sequences`:
       con `?format=csv` restituiscono il documento CSV (text/csv).
   - `src/openapi.js`: documentati i nuovi parametri (from, to, cursor, format)
     e `nextCursor` per /v1/activities; nota format=csv su campaigns/sequences.
   - Test nuovi `test/v1-csv-export.test.js` (11): paginazione a cursore senza
     duplicati tra pagine, filtri eventType/email/from, export CSV (header +
     conteggio righe) per activities/campaigns/sequences, 401 senza auth,
     unit test su toCsv (escape). Tutti passano.

2. **Verifica regressioni**: v1-email-stats-http, v1-openapi,
   v1-planning-onda3, v1-activities (23 test) + f0-foundations +
   onda1-webhook-out (10 test) — tutti ✅. Totale verificato in questo run:
   11 nuovi + 33 esistenti = 44 test, 0 fail.

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

## MONITORAGGIO (POLISH cron, 21/08/2026 — full suite)
- Repo LIBERO all'inizio run (nessun processo claude/codex/opencode, nessun
  index.lock, working tree pulita), confermato anche a fine lavoro.
- RIESEGUITA la suite COMPLETA (tutti i file .test.js, ~80, via
  `./scripts/test.sh <gruppi di file>` in gruppi isolati): **621 pass, 6 skip
  (newsletter attesi), 0 fail**. Esito per gruppo:
  - v1-planning-onda3: 9/9
  - v1-activities (+http) + v1-email-stats (+http): 15/15
  - v1-reports (+http) + v1-dashboard-funnel (+http): 31/31
  - v1-openapi + f0-foundations + f0-location-mapping + onda1-contacts: 31/31
  - onda1-opportunities-v1 + opportunity-custom-fields + webhook-out + import-crm-tool: 14/14
  - newsletter-bounce/engagement/complaints/verification/base-url: 64 pass, 6 skip (attesi)
  - onda2-booking (+public/calendar/webhook-e2e): 26/26
  - onda2-conversations-v1 + runtime-events + runtime-event-flow + v1-payments + v1-rate-limit: 49/49
  - crm-suite/opportunities/opportunity-board/webhooks/pipeline/api-tokens: 45/45
  - crm-conversations/segments/workflows + contacts/calls/call-reminders: 35/35
  - rbac/oauth/modules/settings/sites/export-import: 47/47
  - forms-crm/multipart/redirect/tag + tracking/tracked-links: 37/37
  - newsletter.test NON ESISTE; email-templates/calendar-sync/calendars/calendars-agent/recurring: 38/38
  - dashboard/reports/media-protected/agent-runtime/agent-builder (+agent-helper/payments/webhooks/reports/sandbox/kb: file NON ESISTENTI): 38/38
  - auth-rate-limit/backup-jobs/call-recordings/call-summaries/channel-limits/client-services/hitl/kb: 62/62
  - newsletter-auto-confirm/payments/privacy/quizzes/public/route-order/sandbox/seo/suggestions/webhook-n8n-e2e: 80/80
- `node --check` su TUTTI i file src e test: SINTASSI OK (0 errori).
- Migrazione `./scripts/test.sh` (node db/migrate.js) su DB test (cms-test-pg,
  Up 6 days): completata senza errori. Nessuna migrazione pendente.
- Nota numerazione migrazioni: salta `080` (presenti 079 e 081). NON è un
  problema: migrate.js applica i file per ordinamento filename, quindi 081 viene
  eseguito regolarmente dopo 079. Nessun fix necessario.
- `.env.example` ben formattato (60 righe, DB/payments/cloudflare/social
  presenti), nessun segreto reale versionato.
- Nessun .env/secret untracked; occorrenze regex `postgres://` in
  backup.js/calls.test.js sono solo commenti con placeholder (*** ) — nessun
  segreto reale.
- Nessun fix strutturale eseguito (solo verifica full-suite). Working tree rimasta pulita.

## PUNTI DI VERIFICA (questo run)
- ✅ **11 nuovi test CSV** (`test/v1-csv-export.test.js`), tutti passano
  (cursor pagination, filtri from/to/eventType/email, export CSV per
  activities/campaigns/sequences/filtered, 401 senza auth, unit toCsv)
- ✅ **Nessuna regressione**: v1-email-stats-http, v1-openapi,
  v1-planning-onda3, v1-activities, f0-foundations, onda1-webhook-out —
  33/33 pass
- ✅ **Sintassi OK**: `node --check` su src/routes/v1.js, src/openapi.js e sul
  test v1-csv-export.test.js
- ✅ **OpenAPI aggiornato**: from/to/cursor/format su /v1/activities,
  format=csv su /v1/email-stats/campaigns e /sequences
- ✅ **Nessun segreto versionato**, nessun riferimento CRM-specifico
- ✅ **Nessuna migrazione SQL nuova** necessaria (niente cambi di schema)

## MONITORAGGIO (POLISH cron, 21/08/2026 — run completo)
- Repo LIBERO all'inizio del run (nessun processo claude/codex/opencode, nessun
  index.lock, working tree pulita), confermato anche a fine lavoro.
- RIESEGUITA l'intera suite (81 file .test.js) in gruppi isolati via
  `./scripts/test.sh <file...>` per evitare il timeout noto sul DB. Esito
  TOTALE: **568 pass, 6 skip (newsletter attesi), 0 fail**.
- `node --check` su tutti i file in src+test: SINTASSI OK (nessun output errore).
- `.env.example` riletto riga-per-riga: RISULTATO ALLINEATO (DATABASE_URL,
  JWT_SECRET e tutte le vars presenti). La precedente "concatenaione" era solo
  un artefatto di rendering del terminale, non un problema reale.
- `cms-test-pg` container attivo (Up 6 days).
- Nessun fix strutturale necessario: solo verifica, nessun errore banale
  riscontrato, nessun segreto versionato (match `postgres://` solo in commenti
  con placeholder ***), nessun nome CRM-specifico in src.
- Nessuna [APERTA] in DECISIONI_UMANE.md (tutte [RISOLTO] già applicate).
- Nessun commit/push eseguito (working tree rimasta pulita).

## PROSSIMO BLOCCO CONSIGLIATO
1. **Onda 3 planning (ultimo ritardo)**: import avanzato su `/v1/import` —
   accettare file CSV/JSON (multipart o text/csv) oltre al body JSON attuale,
   con validazione errori per-riga e report dettagliato per-jobs.
2. **Oppure**: ONDA 4 tuning — webhook out su più eventi già presenti
   (opportunity_stage/status_changed, contact_updated, quote_*); eventuale
   arricchimento payload o nuovi trigger. Attendere input umano per priorità.

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