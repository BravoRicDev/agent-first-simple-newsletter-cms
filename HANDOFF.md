# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **LEADER+QUALITY CRON (21/08/2026) — ONDA 3: Dashboard & Funnel v1 API**:
  - Working tree: pulita dopo commit.
  - **COSTRUITO**: `/v1/dashboard` e `/v1/funnel` endpoint, con test service-level + HTTP, documentazione OpenAPI.
  - 14/14 test nuovi ✅ (7 HTTP + 7 service-level). Nessuna regressione su F0 (9/9), Onda 1 (8/8), OpenAPI (5/5).

## COSTRUITO IN QUESTO RUN

1. **ONDA 3 — Dashboard & Funnel v1 API** (blocco sostanziale):
   - `src/routes/v1.js`: aggiunte 2 nuove route GET `/v1/dashboard` (KPI con range opzionale 7d/30d/90d) e GET `/v1/funnel` (funnel conversioni con filtri from/to). Usa servizi esistenti `getKpis` (dashboard.js) e `getFunnel` (tasks.js).
   - `test/v1-dashboard-funnel.test.js`: 7 test service-level — metriche attese, default range, fallback range invalido, funnel data structure, filtri data, isolamento tenant, sito senza dati.
   - `test/v1-dashboard-funnel-http.test.js`: 7 test HTTP — 200 con KPIs, range=7d, 401 senza auth, funnel data structure, 401 senza auth, filtri data, isolamento tenant.
   - `src/openapi.js`: aggiunte definizioni OpenAPI per `/v1/dashboard` e `/v1/funnel` con tags Dashboard e Funnel, parametri query, schemi risposta.

2. **Verifica regressioni**: F0 (9/9), Onda 1 contatti (8/8), OpenAPI (5/5) — tutti ✅.
   - Totale verificato in questo run: 22 test esistenti + 14 nuovi = 36 test, 0 fail.

## MONITORAGGIO (POLISH cron, 21/08/2026)
- Working tree: pulita, repo libero (nessun altro processo attivo, nessun lock git).
- RIESEGUITA l'intera suite a gruppi isolati via `./scripts/test.sh <file>`: tutti i
  ~70 file passano, 0 fail. Unica eccezione: newsletter (parte di engagement) con 6
  skip pre-esistenti (attesi).
- Nessun fix necessario (sintassi OK, import/dipendenze a posto, .env.example allineato,
  nessun segreto versionato, nessun nome CRM-specifico). Nessuna [APERTA] in
  DECISIONI_UMANE.md (tutte [RISOLTO] già applicate).

## PUNTI DI VERIFICA (questo run)
- ✅ **14 nuovi test Dashboard+Funnel**: 7 service-level + 7 HTTP, tutti passano
- ✅ **Nessuna regressione**: F0 9/9, Onda 1 contatti 8/8, OpenAPI 5/5
- ✅ **Sintassi OK**: node --check su src/routes/v1.js, src/openapi.js, entrambi i test
- ✅ **OpenAPI aggiornato**: tags + paths per /v1/dashboard e /v1/funnel
- ✅ **Nessun segreto versionato**
- ✅ **Nessun riferimento CRM-specifico**

## PROSSIMO BLOCCO CONSIGLIATO
1. **Onda 3 planning**: continuare con altri endpoint Onda 3:
   - `/v1/activities` — log attività recenti per contatto
   - `/v1/email-stats` — statistiche email (invii, aperture, click)
   - `/v1/reports` — report personalizzati via v1 API
2. **Oppure**: attendere input umano per priorità Onda 3

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- ONDA 3: Dashboard & Funnel v1 API (nuovo).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano.
- NON riportare custom fields opportunità in `contact_custom_values` (FK su contacts): usare SEMPRE `opportunity_custom_values` (076).