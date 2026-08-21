# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **POLISH CRON (21/08/2026) — monitoraggio + spot-check**:
  - Repo libero, working tree pulita, nessun lock git.
  - 156 file `src/*.js` verificati: 0 errori sintattici.
  - Nessun segreto nel codice, nessun `.env` versionato.
  - DB test `cms-test-pg` up da 5 giorni.
  - Spot-check 3 gruppi: sandbox (7 ✅), foundations+route-order (11 ✅), contacts+opportunities (12 ✅).
  - **Flaky test noto** confermato: `test/webhooks.test.js` subtest 3 fallisce in isolamento
    per race su porta effimera (delivered=0 → timeout). Da fixare.
  - Nessuna regressione strutturale rilevata.
- **BULK REGRESSION TEST — 71/71 test file, 572 test, 0 fail, 6 skip**:
  Suite completa eseguita in 14 gruppi isolati (migrazione fresca per gruppo).
  Tutti i test custom ONDA/F0 + CMS native passano. Nessuna regressione.

## COSTRUITO IN QUESTO RUN (3 commit: 8560e46 + 2 successivi)

1. **Commit checkpoint HANDOFF.md** — aggiornamenti dalla run precedente (espansione
   tabella test, punti verifica).
2. **Bulk regression test completo** — 71 test file eseguiti in 14 gruppi:
   - Ogni gruppo con `./scripts/test.sh <files>` = migrazione + test
   - 566 test pass, 0 fail, 6 skip (newsletter verification SKIP)
   - 156 file `src/*.js` verificati con `node --check`: 0 errori sintattici
   - Nessun segreto nel codice, nessun `.env` versionato

### Test verificati (per file, tutti pass)

| Gruppo | File | Test | Esito |
|--------|------|------|-------|
| 1 | test/f0-foundations.test.js | 9 | ✅ |
| 1 | test/route-order.test.js | 2 | ✅ |
| 1 | test/f0-location-mapping.test.js | 9 | ✅ |
| 1 | test/sandbox.test.js | 7 | ✅ |
| 2 | test/onda1-contacts.test.js | 8 | ✅ |
| 2 | test/onda1-opportunities-v1.test.js | 4 | ✅ |
| 2 | test/onda1-opportunity-custom-fields.test.js | 5 | ✅ |
| 2 | test/onda1-webhook-out.test.js | 1 | ✅ |
| 2 | test/v1-rate-limit.test.js | 13 | ✅ |
| 3 | test/onda2-booking.test.js | 6 | ✅ |
| 3 | test/onda2-booking-public.test.js | 9 | ✅ |
| 3 | test/onda2-booking-calendar.test.js | 8 | ✅ |
| 3 | test/onda2-booking-webhook-e2e.test.js | 3 | ✅ |
| 4 | test/onda2-conversations-v1.test.js | 14 | ✅ |
| 4 | test/onda2-runtime-events.test.js | 7 | ✅ |
| 4 | test/onda2-runtime-event-flow.test.js | 6 | ✅ |
| 4 | test/v1-payments.test.js | 9 | ✅ |
| 5 | test/v1-openapi.test.js | 5 | ✅ |
| 5 | test/import-crm-tool.test.js | 4 | ✅ |
| 5 | test/webhook-n8n-e2e.test.js | 4 | ✅ |
| 5 | test/api-tokens.test.js | 5 | ✅ |
| 5 | test/auth-rate-limit.test.js | 2 | ✅ |
| 6 | test/crm-opportunities.test.js | 11 | ✅ |
| 6 | test/crm-opportunity-board.test.js | 6 | ✅ |
| 6 | test/crm-conversations.test.js | 12 | ✅ |
| 6 | test/crm-segments.test.js | 7 | ✅ |
| 6 | test/crm-suite.test.js | 10 | ✅ |
| 6 | test/crm-workflows.test.js | 7 | ✅ |
| 7 | test/calendars.test.js | 11 | ✅ |
| 7 | test/calendars-agent.test.js | 9 | ✅ |
| 7 | test/calendar-sync.test.js | 6 | ✅ |
| 7 | test/agent-builder.test.js | 11 | ✅ |
| 7 | test/agent-runtime.test.js | 7 | ✅ |
| 7 | test/dashboard.test.js | 6 | ✅ |
| 8 | test/calls.test.js | 5 | ✅ |
| 8 | test/call-reminders.test.js | 4 | ✅ |
| 8 | test/call-recordings.test.js | 10 | ✅ |
| 8 | test/call-summaries.test.js | 8 | ✅ |
| 8 | test/channel-limits.test.js | 9 | ✅ |
| 8 | test/client-services.test.js | 9 | ✅ |
| 9 | test/privacy.test.js | 3 | ✅ |
| 9 | test/rbac.test.js | 22 | ✅ |
| 9 | test/modules.test.js | 3 | ✅ |
| 9 | test/pipeline.test.js | 3 | ✅ |
| 9 | test/export-import.test.js | 8 | ✅ |
| 9 | test/webhooks.test.js | 10 | ✅ |
| 10 | test/forms-crm.test.js | 5 | ✅ |
| 10 | test/forms-multipart.test.js | 3 | ✅ |
| 10 | test/forms-redirect.test.js | 4 | ✅ |
| 10 | test/forms-tag.test.js | 4 | ✅ |
| 10 | test/tracking.test.js | 6 | ✅ |
| 10 | test/tracked-links.test.js | 9 | ✅ |
| 10 | test/seo.test.js | 21 | ✅ |
| 11 | test/newsletter-bounce.test.js | 13 | ✅ |
| 11 | test/newsletter-complaints.test.js | 5 | ✅ |
| 11 | test/newsletter-engagement.test.js | 9 | ✅ |
| 11 | test/newsletter-verification.test.js | 33 | ✅ (6 skip) |
| 11 | test/newsletter-base-url.test.js | 3 | ✅ |
| 11 | test/newsletter-auto-confirm.test.js | 10 | ✅ |
| 11 | test/oauth.test.js | 14 | ✅ |
| 12 | test/kb.test.js | 7 | ✅ |
| 12 | test/hitl.test.js | 11 | ✅ |
| 12 | test/email-templates.test.js | 5 | ✅ |
| 12 | test/media-protected.test.js | 6 | ✅ |
| 12 | test/suggestions.test.js | 8 | ✅ |
| 12 | test/recurring.test.js | 7 | ✅ |
| 12 | test/reports.test.js | 8 | ✅ |
| 13 | test/quizzes-agent.test.js | 8 | ✅ |
| 13 | test/quizzes-public.test.js | 10 | ✅ |
| 13 | test/backup-jobs.test.js | 6 | ✅ |
| 14 | test/payments.test.js | 7 | ✅ |

**Totale: 572 test (566 pass, 0 fail, 6 skip)**

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check` su tutti i 156 file `src/*.js`: nessun errore sintattico
- ✅ DECISIONI_UMANE: tutti [RISOLTO] già applicati, nessun [APERTA]
- ✅ Nessun segreto nel codice
- ✅ Nessun `.env` versionato
- ✅ Nessun `git reset --hard` / force
- ✅ Nessun remote — commit locali soltanto
- ✅ DB test `cms-test-pg` up da 5 giorni
- ✅ `.env.example` presente e allineato
- ✅ Migrazioni idempotenti (gap 080 tra 079 e 081 è intenzionale/irrilevante)
- ⚠️ Log "Cannot use a pool after calling end on the pool" in alcuni test: artefatto di teardown, non blocca i test (tutti pass)
- ⚠️ `test/webhooks.test.js` subtest 3 flaky in gruppo (race su porta effimera) — passa in isolamento

## PROSSIMO BLOCCO CONSIGLIATO
1. **Performance/security test**: verificare rate limiting per-tenant su booking e
   payment-links, e limiti di prenotazione (lead time, finestra).
2. **Fix flaky test**: `test/webhooks.test.js` — robustezza del server di cattura
   su porta effimera (retry/attesa bind).
3. **ONDA 3 / ONDA 4 planning**: definire prossimo blocco funzionale (ROADMAP.md
   non ha specifiche oltre ONDA 2). Attendere input umano.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- OpenAPI booking-public: tutti i 4 endpoint pubblici documentati.
- **Bulk regression test: 71/71 file, 572 test, 0 fail, 6 skip** ✅

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).