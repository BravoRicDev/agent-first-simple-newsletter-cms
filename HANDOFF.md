# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA + import tool + OpenAPI): **perimetro v1
  CHIUSO e SUITE VERDE**.
- **ONDA 2 Phase 1-5**: booking, calendar sync, public page, payments,
  conversations — tutte **COMPLETE**.
- **ONDA 2 Phase 6 — Event-driven agent conversation triggers**: **COMPLETO**
  (migrazione 081 + sanitizeEventTriggers + triggerRuntimeForEvent +
  integration events.js + test 7/7).

## COSTRUITO IN QUESTO RUN (nuovo commit)

### ONDA 2 Phase 6 — Event-driven agent conversation triggers

1. **db/081_runtime_event_triggers.sql** — Migrazione idempotente: aggiunge
   `event_triggers JSONB NOT NULL DEFAULT '[]'` a `agent_runtimes`.

2. **src/services/agent-runtime.js** — Modifiche:
   - Nuova funzione `sanitizeEventTriggers(raw)`: sanitizza l'array di trigger
     evento (event_type, enabled, initial_message, auto_close_days).
   - `sanitizeRuntimeInput` ora include `event_triggers: sanitizeEventTriggers(...)`.
   - Nuova funzione esportata `triggerRuntimeForEvent({ siteId, eventType,
     contactEmail, payload })`: trova i runtimes attivi del sito con
     `event_triggers` matching l'event_type, e per ognuno:
     - Verifica preferenze GDPR (pref_whatsapp / pref_email)
     - Crea/riusa una conversazione
     - Invia il messaggio iniziale configurato
     - Imposta status conversazione = "open"
     - Emette evento `agent_runtime_triggered` per tracciamento

3. **src/services/events.js** — Aggiunto consumer in `emitContactEvent` che
   chiama `triggerRuntimeForEvent` via import dinamico (nessun ciclo statico).
   Ogni evento CRM (booking_created, contact_created, form_submitted, ecc.)
   ora triggera automaticamente le conversazioni degli agent runtime
   configurati.

4. **test/onda2-runtime-events.test.js** — 7 test:
   - booking_created attiva runtime whatsapp + verifica messaggio in DB
   - contact_created attiva runtime email con benvenuto
   - evento senza runtime matching → triggered=false
   - Isolamento tenant (tenant2 usa runtime tenant2)
   - pref_whatsapp=false → skip con "pref"
   - pref_email=false → skip con "pref"
   - runtime senza event_triggers non crasha

### Verifica regressione
- Group 1 (8 file): **71/71** ✅ (include agent-runtime.test.js regressione)
- Group 2 (9 file): **49/49** ✅
- Phase 6 nuovo: **7/7** ✅
- **Totale: 127+ test, 0 fail**

## PUNTI DI VERIFICA (questo run)
- ✅ `node --check` su tutti i file modificati: OK
- ✅ Tutti i test passano (0 fail) — regressione zero
- ✅ Nessun segreto nel codice
- ✅ Nessun `git reset --hard` / force
- ✅ DECISIONI_UMANE: nessun [APERTA] — tutti [RISOLTO] già applicati
- ✅ Migrazione idempotente (ADD COLUMN IF NOT EXISTS)
- ✅ `.claude-task-p6.md` pulito (rimosso)

## PROSSIMO BLOCCO CONSIGLIATO
1. **OpenAPI booking-public**: documentazione OpenAPI degli endpoint pubblici di
   booking (da aggiungere a v1-openapi o file separato).
2. **Webhook booking → n8n**: verificare che l'evento booking_created emesso da
   createBooking arrivi correttamente ai webhook configurati.
3. **ONDA 2 Phase 6 refinements**: test end-to-end dell'integrazione events.js
   → triggerRuntimeForEvent con eventi reali (booking_created).
4. **Fix test gap in v1-openapi.test.js**: aggiungere `/booking-calendar-config`,
   `/payment-links`, `/payment-links/{id}`, `/payment-links/{id}/mark-paid`
   alla lista expected.

## COSE GIÀ PRONTE
- Tutta la v1 (F0 + Onda 1 + rifinitura + import tool + OpenAPI).
- ONDA 2 Phase 1-5: booking, calendar sync, public page, payments, conversations.
- **ONDA 2 Phase 6**: event-driven agent conversation triggers (migrazione 081).

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).