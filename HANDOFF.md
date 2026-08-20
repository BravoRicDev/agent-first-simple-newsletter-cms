# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA): **perimetro v1 CHIUSO e SUITE COMPLETAMENTE
  VERDE** (476 test / 470 pass / 0 fail). Questo run ha completato la rifinitura:
  custom fields sulle OPPORTUNITÀ (blocco sostanziale mancante), import-ready docs,
  e stabilizzato i 3 fail flaky noti — di cui **uno era un vero bug di produzione**
  nelle sequenze evergreen. Prossimo blocco consigliato = Onda 2 (out of scope v1),
  oppure, se si vuole consolidare la v1: hardening auth/rate-limit / doc API.

## RIFINITURA v1 COMPLETATA (questo run, commit 7761c78 / 1fda388 / d5f0ca7)
1. **Custom fields sulle OPPORTUNITÀ** (era il punto 1 del "prossimo blocco"):
   - Migrazione `db/076_opportunity_custom_values.sql` idempotente: tabella
     `opportunity_custom_values` (FK su opportunities(id), `values JSONB`,
     `UNIQUE(site_id, opportunity_id)`). NOTA: non si possono usare
     `contact_custom_values` per le opportunità — quel FK è su contacts(id).
   - `src/services/opportunity-custom-values.js`: get/set/merge/clear, validati
     contro `custom_fields` (object_key='opportunity'), field_key sconosciuti
     ignorati (warn).
   - `src/services/opportunities-v1.js`: wrapper surface /v1 che riusa
     `services/opportunities.js` e arricchisce il payload con
     `customFields: { field_key: value }` (create/update/upsert/get/list/delete).
   - `src/routes/v1.js`: usa opportunities-v1, customFields in create/update,
     upsert centralizzato nel servizio.
   - Test `test/onda1-opportunity-custom-fields.test.js` (5 subtests, pattern F0).

2. **Suite end-to-end VERDE** (punto 2 del prossimo blocco). Prima 451/471 con
   3 fail (forms-crm, newsletter-base-url, newsletter-bounce); ora 476/470 (0 fail).
   - `fix(newsletter)` — **BUG REALE**: `sendSequenceSteps()` non selezionava
     `suppress_inactive`/`inactive_after_sends` ($8/$9) → undefined → NULL → la
     condizione di elegibilità valuta NULL → **le sequenze evergreen NON inviavano
     mail**. Aggiunte le due colonne con COALESCE. Coperto da
     test/newsletter-base-url (PUNTO 3).
   - `test forms-crm`: usava `@example.test` (dominio senza MX) → bloccato da
     verifySubscriberEmail→checkMx. Ora usa example.com (MX reale) + email unica
     per run.
   - `test newsletter-bounce`: token hardcoded collidevano su UNIQUE del DB
     condiviso; token univoci per run. Fix anche INSERT `RETURNING id` → `id,email`
     (recordBounce usa subscriber.email).

3. **Import-readiness** (punto 3 del prossimo blocco):
   - `docs/IMPORT_READINESS.md`: conferma di coerenza schema v1 per import esterno
     (tabella coinvolte, note custom fields, pipeline/stage) + design del tool
     `scripts/import-crm-data.mjs` PROGETTATO (migrazione dati NON eseguita, come
     da vincolo).
   - `docs/ONDA1_SPEC.md`: aggiunta sezione "RIFINITURA v1 — custom fields sulle
     opportunità" con la scelta schema (tabella dedicata, perché contact_custom_values
     è vincolata a contacts).

## PUNTI DI VERIFICA (questo run)
- Migrazione 076 applicata + doppia riesecuzione idempotente senza errori.
- `node --check` ok su tutti i file toccati; nessun segreto nel codice.
- Test mirati F0+ONDA1+rifinitura = 27/27 PASS.
- Suite intera = 476/470/0 (verde).
- Nessun push (nessun remote); commit locali: 7761c78, 1fda388, d5f0ca7.

## PROSSIMO BLOCCO CONSIGLIATO
La v1 (F0 + Onda 1 + rifinitura) è chiusa e verde. Opzioni per il prossimo cron:
1. **Onda 2** (backlog): calendario/booking con Google Calendar per-tenant
   (configurabile, credenziali come campo di config — vedi DECISIONI_UMANE),
   conversazioni outbound, payments, funnels.
2. **Consolidamento v1** (se si vuole prima blindare la v1): hardening
   auth/rate-limit, doc API completa (OpenAPI) dei 6 blocchi v1, eventuale
   `scripts/import-crm-data.mjs` implementato (design già pronto in
   docs/IMPORT_READINESS.md).

## COSE GIÀ PRONTE (riusate da RIFINITURA)
- `pipelines`/`pipeline_stages`, `opportunities`, `services/opportunities.js`,
  `custom_fields` (F0), webhook OUT.
- custom-values infrastruttura contatti (custom-values.js) + opportunità
  (opportunity-custom-values.js).
- Naming generico "API compatibili con CRM diffusi" applicato.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON migrate esterne (nessuna migrazione dati ora): schema pronto all'import
  (tool solo progettato in docs/IMPORT_READINESS.md).
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi nessuna).
- NON riportare custom fields opportunità in `contact_custom_values` (FK su
  contacts): usare SEMPRE `opportunity_custom_values` (076).

## LOG CRON POLISH/MONITOR
- 20/08/2026 (polish prudente): repo libero, working tree pulita, nessun processo
  dev attivo, nessun lock. Suite dichiarata verde dal dev (476/470). Nessuna
  decisione [APERTA]; tutti i [RISOLTO] coerenti con lo stato.
  - Fix banale di allineamento: `.env.example` — aggiunta `JWT_EXPIRES_IN=24h`
    (usata in src/config.js con default; prima non dichiarata). Nessuna logica
    toccata. Commit locale (nessun push).
  - Nota per il dev: DB di test (cms-test-pg :15999, db testdb) non raggiungibile
    da questo ruolo con credenziali note → non ho rieseguito la suite. Il prossimo
    dev che vuole i test deve impostare il proprio .env di test / credenziali.
  - Nota: [RISOLTO] "Google Calendar configurabile per-tenant" ancora da
    implementare, ma è Onda 2 = OUT OF SCOPE v1 (per ROADMAP). Non eseguito a
    ragione.
