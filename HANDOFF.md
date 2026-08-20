# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1 + RIFINITURA): **perimetro v1 CHIUSO e SUITE VERDE**
  (480 test / 474 pass / 0 fail). Questo run ha **IMPLEMENTATO il tool di
  import `scripts/import-crm-data.mjs`** (design già in
  docs/IMPORT_READINESS.md → ora codice reale e verificato): chiude l'ultimo
  gap del "migration-ready" della v1. La migrazione dati in sé NON è stata
  eseguita (vincolo di progetto: si lancia solo con una sorgente esterna reale).
  Prossimo blocco consigliato = Onda 2 (out of scope v1) oppure ulteriore
  consolidamento (hardening auth/rate-limit, doc OpenAPI).

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

## IMPORT TOOL IMPLEMENTATO (questo run, commit 38e38ac)
- `scripts/import-crm-data.mjs` — CLI Node+pg autonoma, chiude il "migration-ready"
  della v1: carica un file JSON `{ site_id, custom_fields[], contacts[],
  opportunities[] }` e popola le tabelle v1 in modo idempotente (ON CONFLICT/
  upsert). Flag `--site`/`--dry-run`/`--quiet`; riepilogo + log scarti.
  - custom_fields: upsert definizioni (site/object/field).
  - contacts: upsert per (site_id,email); profilo + customFields validati contro
    le definizioni (chiavi non definite → scarto con warn; profilo sempre
    ammesso); transazione per contatto.
  - opportunities: upsert per (site_id,contact_email,title); pipeline_id
    facoltativo → prima pipeline del tenant; custom in opportunity_custom_values.
  - Migrazione dati NON eseguita (vincolo): tool pronto, da lanciare solo con
    sorgente esterna reale.
- `test/import-crm-tool.test.js` — 4 subtests: popolamento con profilo/custom,
  idempotenza al doppio run, scarto chiavi non definite con profilo mantenuto,
  dry-run senza scritture.
- `docs/IMPORT_READINESS.md` — aggiornato da "PROGETTATO" a "IMPLEMENTATO" con
  uso, struttura JSON, comportamento e flag.

## PUNTI DI VERIFICA (questo run)
- Suite intera = **480/474/0** (verde; prima 476/470/0) — 4 nuovi test, nessuna
  regressione. Eseguito contro il DB di test reale `localhost:15999/testdb`
  (raggiungibile: `postgres@localhost:15999`, NODE_ENV=test).
- `node --check` ok su `scripts/import-crm-data.mjs` e
  `test/import-crm-tool.test.js`; nessun segreto/personale nel codice.
- Idempotenza verificata manualmente al doppio run (0 duplicati).
- Nessun push (nessun remote); commit locale: 38e38ac.

## PROSSIMO BLOCCO CONSIGLIATO
La v1 (F0 + Onda 1 + rifinitura + import tool) è chiusa e verde. Opzioni:
1. **Onda 2** (backlog): calendario/booking con Google Calendar per-tenant
   (configurabile, credenziali come campo di config — vedi DECISIONI_UMANE),
   conversazioni outbound, payments, funnels.
2. **Consolidamento v1** (blindare prima la v1): hardening auth/rate-limit,
   doc API completa (OpenAPI) dei 6 blocchi v1 (contatti, opportunità, custom
   fields, webhook out, pipelines, config).

## COSE GIÀ PRONTE (riusate da RIFINITURA)
- `pipelines`/`pipeline_stages`, `opportunities`, `services/opportunities.js`,
  `custom_fields` (F0), webhook OUT.
- custom-values infrastruttura contatti (custom-values.js) + opportunità
  (opportunity-custom-values.js).
- Naming generico "API compatibili con CRM diffusi" applicato.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON eseguire migrazione dati (il tool `scripts/import-crm-data.mjs` è pronto,
  MA va lanciato solo quando esiste una sorgente dati esterna reale da
  importare; con DB vuoto le tabelle v1 restano vuote).
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
- 20/08/2026 (dev LEADER+QUALITY — questo run): DB di test raggiungibile
  (`postgres@localhost:15999/testdb`). Suite intera rieseguita: **480/474/0**
  verde. Implementato il tool di import v1 (`scripts/import-crm-data.mjs` +
  test + docs). Commit `38e38ac`. Nessuna decisione [APERTA].
