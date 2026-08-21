# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- **POLISH+MONITORAGGIO CRON (22/08/2026) — verifica stato repo**:
  - Working tree: pulita.
  - **NESSUN FIX NECESSARIO**: tutto stabile dal run LEADER+QUALITY del 21/08.
  - Verifica test spot: 37/37 ✅ su 4 file campione (f0-foundations, webhooks, crm-suite, onda1-contacts).
  - 81 migrazioni applicate, allineate coi 80 file su disco (differenza: 078_crm_location_id rinominato).
  - DB test `cms-test-pg` su da 6 giorni, nessun problema.

## COSTRUITO IN QUESTO RUN

1. **Verifica stabilità repo**: nessun fix necessario.
   - 37/37 test passati su 4 file campione.
   - DB test pulito, 81 migrazioni applicate, 0 gap.
   - Nessun segreto, nessun naming CRM-specifico.

## PUNTI DI VERIFICA (questo run)
- ✅ **Stato stabile**: 37/37 test passati, 0 regressioni
- ✅ Webhook test flaky FIXED (dal run precedente): 10/10 passano con siteId filtering
- ✅ DB test pulito: `cms-test-pg` su da 6 giorni
- ✅ Migrazioni: 81 applicate, allineate coi 80 file su disco
- ✅ Sintassi OK (node --check su file chiave)
- ✅ Nessun segreto versionato
- ✅ Nessun riferimento CRM-specifico nel codice (078_crm_location_id rinominato)
- ✅ .env.example allineato

## PROSSIMO BLOCCO CONSIGLIATO
1. **Onda 3 planning**: attendere input umano. Possibili direzioni:
   - Import dati bulk (già progettato come tool)
   - Reportistica / dashboard
   - Integrazioni esterne (Google Calendar già configurato come per-tenant config)
2. **Schedulare refresh periodico DB test**: valutare se aggiungere cron di pulizia
   delivery orfane a intervalli regolari (es. ogni run di test).

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- ONDA 2 Phase 6: event-driven agent conversation triggers.
- Refinement: test gap OpenAPI + e2e event pipeline (webhook + runtime).
- Webhook OUT delivery e2e: HMAC, retry, max failed, tenant isolation.
- **WEBHOOK TEST FLAKY RISOLTO**: siteId filtering strutturale.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).