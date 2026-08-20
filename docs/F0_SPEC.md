# F0 — Fondamenta: substrato multi-tenant API-compatibile (SPEC per agente)

Leggi OBBLIGATORIAMENTE `AGENTS.md`, `HANDOFF.md`, `DECISIONI_UMANE.md`, `ROADMAP.md`
prima di iniziare. Rispetta i VINCOLI di `AGENTS.md` (niente reset/force, niente push,
migrazioni idempotenti con IF NOT EXISTS, niente "ADD CONSTRAINT IF NOT EXISTS",
naming generico "API compatibili con CRM diffusi" — MAI il nome del CRM di origine).

## OBIETTIVO DEL BLOCCO
Costruire **F0 — Fondamenta** completo e verificato:

1. **Tenancy**: identificazione del tenant (sito) via header `Location-Id` +
   una **API key per-sito** (Bearer token per-sito). Il sito è l'unità di tenancy
   (tabella `sites` già esistente).
2. **Header `Version:` IGNORATO** — il middleware lo legge e lo ignora volutamente
   (compatibilità con client che lo mandano). Documentarlo in un commento.
3. **Custom fields per-tenant** con id stabili: nuova tabella `custom_fields`.
4. **Pipeline/stage per-tenant** con id stabili: riusare la tabella `pipelines`
   (ha già `id SERIAL` stabile e `stages JSONB`) + nuova tabella `pipeline_stages`
   con id stabili per gli stadi.
5. **Config per-tenant generalizzato**: nuova tabella `tenant_config`
   (credenziali esterne come campo di config, non hardcoded — vedi decisione Google
   Calendar in DECISIONI_UMANE).
6. **Substrato Agent-first**: capability registry + permessi (tabella `capabilities`
   + associazione a `roles_permissions` esistente).
7. **Naming generico** nei commenti/README + struttura PRONTA per import dati
   (progettata, migrazione NON eseguita).

## CONTESTO PROGETTO (rilasci correnti)
- Stack: Node.js 22, Express 4, EJS, PostgreSQL 16 (driver `pg`), ESM (`"type":"module"`).
- Applicazione Express montata in `src/index.js` con `app.use(<router>)`.
- Tenant = tabella `sites` (`id`, `name`, `domain`, `created_at`, `updated_at`).
- Contatti: tabella `contacts` (id SERIAL PK stabile, site_id FK, email, tags TEXT[],
  status, notes, value_estimate, utm_*, score, is_client, client_status, created_at,
  updated_at; UNIQUE(site_id,email)).
- Opportunità/affari: `opportunities` (id SERIAL, site_id, contact_email,
  pipeline_id FK→pipelines, stage VARCHAR, title, amount NUMERIC, probability,
  status 'open|won|lost', expected_close_at, notes). Vedi `src/services/opportunities.js`.
- Pipeline: `pipelines` (id SERIAL, site_id, name, stages JSONB, is_default,
  UNIQUE(site_id,name)). Vedi `db/043_preferences_pipelines.sql`.
- Auth esistente: `src/middleware/auth.js` (JWT/API-token bearer) + `requireAgent`
  in `src/routes/agent-helpers.js`. API agent attuale su `/api/agent/sites/:siteId/...`.
- Webhook OUT già esistenti: `src/services/webhooks.js` (enqueueForEvent, deliverPending),
  tabella `webhooks`/`webhook_deliveries` (`db/054_webhooks.sql`).
- CI/test: `npm test` = `node db/migrate.js && node --test --force-exit --test-concurrency=1`.
  I test usano DB Postgres 16 (`DATABASE_URL`), helper in `test/helpers.js`
  (createTestSite/createTestUser/uniqueDomain/uniqueEmail/closeDb). Ogni test usa
  domini/email univoci.
- DB test disponibile: `postgres://postgres:***@127.0.0.1:15999/cms_sites_test`.

## FILE DA CREARE

### 1. `db/074_f0_foundations.sql` — migrazione idempotente (IF NOT EXISTS / ON CONFLICT)
Tabella `custom_fields`:
- `id SERIAL PRIMARY KEY`
- `site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE`
- `object_key VARCHAR(100) NOT NULL`  -- oggetto (contact|opportunity|...)
- `field_key VARCHAR(100) NOT NULL`   -- chiave stabile per-tenant
- `name VARCHAR(255) NOT NULL DEFAULT ''`
- `type VARCHAR(30) NOT NULL DEFAULT 'text'`  -- text|number|date|checkbox|select|textarea
- `options JSONB NOT NULL DEFAULT '[]'`  -- per select
- `is_public BOOLEAN NOT NULL DEFAULT false`
- `active BOOLEAN NOT NULL DEFAULT true`
- `position INTEGER NOT NULL DEFAULT 0`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE(site_id, object_key, field_key)`
- Indici: `idx_custom_fields_site ON custom_fields(site_id, object_key)`.

Tabella `pipeline_stages` (stadi con id stabili):
- `id SERIAL PRIMARY KEY`
- `pipeline_id INTEGER NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE`
- `key VARCHAR(100) NOT NULL`         -- chiave stabile (es. lead, proposta_inviata)
- `label VARCHAR(255) NOT NULL DEFAULT ''`
- `color VARCHAR(30) NOT NULL DEFAULT ''`
- `position INTEGER NOT NULL DEFAULT 0`
- `created_at/updated_at TIMESTAMPTZ DEFAULT NOW()`
- `UNIQUE(pipeline_id, key)`

Tabella `tenant_config` (config per-tenant generalizzata, credenziali esterne):
- `id SERIAL PRIMARY KEY`
- `site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE`
- `key VARCHAR(100) NOT NULL`   -- es. 'google_calendar', 'external_creds'
- `value JSONB NOT NULL DEFAULT '{}'`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE(site_id, key)`

Tabella `site_api_keys` (API key per-sito per il Bearer):
- `id SERIAL PRIMARY KEY`
- `site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE`
- `name VARCHAR(255) NOT NULL`
- `token_hash VARCHAR(64) NOT NULL UNIQUE`  -- SHA-256 hex
- `token_prefix VARCHAR(16) NOT NULL`
- `active BOOLEAN NOT NULL DEFAULT true`
- `last_used_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `UNIQUE(site_id, name)`

Tabella `capabilities` (substrato agent-first):
- `id SERIAL PRIMARY KEY`
- `key VARCHAR(100) NOT NULL UNIQUE`   -- es. 'contacts.read', 'opportunities.write'
- `name VARCHAR(255) NOT NULL DEFAULT ''`
- `description TEXT NOT NULL DEFAULT ''`
- Seed: `INSERT ... ON CONFLICT DO NOTHING` per un set base
  (contacts.*, opportunities.*, custom-fields.*, config.*, webhooks.out, agent.*).

### 2. `src/middleware/tenant-api.js` — middleware tenancy+auth per la surface compatibile
- Esporta `requireTenant()`: legge `Location-Id` (può essere id numerico o domain) per
  risolvere il sito; non trova → 401/404 JSON.
- Legge l'header `Authorization` Bearer; verifica l'API key del SITO (table
  `site_api_keys`, confronto hash SHA-256); aggiorna `last_used_at`; imposta
  `req.tenant = { siteId, site }` su successo; altrimenti 401.
- **Ignora l'header `Version:`** (lo legge e non fa nulla — commento esplicativo).
- Esporta anche `ignoredVersionHeader` (noop) per chiarezza.

### 3. `src/services/custom-fields.js` — servizio CRUD custom fields per-tenant
- `listCustomFields(siteId, {objectKey})`, `getCustomField(siteId, id)`,
  `createCustomField(siteId, data)`, `updateCustomField(siteId, id, data)`,
  `deleteCustomField(siteId, id)`, `listByObjectKey(siteId, objectKey)`.
- Validazione `type` e `object_key`/`field_key` (slug stabile). Emetti evento
  `custom_field_updated` via `src/services/events.js` (fire-and-forget) su create/update/delete.

### 4. `src/services/capabilities.js` — capability registry
- `listCapabilities()`, `grantCapability/revokeCapability` (opzionale, minimo:
  `listCapabilities` + helper per controllare se un ruolo ha una capability
  riusando `roles_permissions`).

### 5. `src/routes/v1.js` — surface API compatibile ("API compatibili con CRM diffusi")
- `Router()` montato su `/v1` in `src/index.js`.
- TUTTE le route passano da `requireTenant()`.
- Endpoint:
  - `GET  /v1/custom-fields` → list (filtra `?objectKey=`)
  - `POST /v1/custom-fields`
  - `GET  /v1/custom-fields/:id`
  - `PUT  /v1/custom-fields/:id`
  - `DELETE /v1/custom-fields/:id`
  - `GET  /v1/custom-fields/object-key/:objectKey`  (PRIMA di `/:id` — route statiche prima delle parametriche)
  - `GET  /v1/custom-fields/folder`
  - `GET  /v1/pipelines` → pipeline del tenant con stages (riusa `getBoardPipelines` da `src/services/opportunities.js`)
  - `POST /v1/pipelines` → crea pipeline (stadi custom)
  - `GET  /v1/pipelines/:id` , `PUT/DELETE /v1/pipelines/:id`
  - `GET  /v1/config` , `PUT /v1/config` → tenant_config (chiavi/valori)
  - `GET  /v1/capabilities` → lista capability (registry agent-first)
  - `GET  /v1/opportunities/lost-reason` → lista motivi perdita (costante/JSONB)
  - `GET  /v1/opportunities/pipelines` → alias di `/v1/pipelines`
  - `POST /v1/api-keys` , `GET /v1/api-keys` , `DELETE /v1/api-keys/:id` → gestione
    API key del tenant (Genera key con `crypto.randomBytes`; salva solo hash).
- Risposte JSON: `{ contacts: [...] }`/`{ customFields: [...] }`/`{ pipeline: {...} }`
  ecc. (convenzione enveloping). Restituisci 404 per risorse inesistenti, 401 se
  tenant/appikey non valide, 400 su validazione.

### 6. Modifica `src/index.js`
- `import v1Routes from "./routes/v1.js";` e `app.use(v1Routes);` (monta su `/v1`).
- Inserirla PRIMA di `publicCatchAllRouter` e delle route catch-all API.

### 7. `test/f0-foundations.test.js`
- Test con `node:test` + helper `test/helpers.js`.
- Copre: creazione custom field per-tenant (id stabile, isolato tra siti),
  CRUD pipeline+stages con id stabili, tenant_config set/get per-tenant,
  capability registry, generazione API key per-sito + auth Bearer via `Location-Id`
  + header `Version:` ignorato (richiesta con Version: qualsiasi riesce comunque),
  401 senza Location-Id/API key sbagliata, isolamento tra tenant diversi.

## VINCOLI TECNICI
- ESM: usa `import`/`export`.
- SQL idempotente: usa `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  `INSERT ... ON CONFLICT DO NOTHING`. MAI `ADD CONSTRAINT IF NOT EXISTS` (pitfall 069).
- Non rompere le route esistenti: la nuova surface è su `/v1` separata.
- Niente segreti hardcoded. `token_hash` sempre SHA-256 hex, mai la chiave in chiaro nel DB.
- `node --check` su ogni file creato/modificato.
- Style: stesso stile del resto del repo (ioannina, try/catch + next(err), helper http).

## DEFINIZIONE DI COMPLETATO
- Tutti i file sopra creati, intercambiabili, sintatticamente validi (`node --check`).
- `node db/migrate.js` gira senza errori (migrazione 074 applicata).
- `node --test test/f0-foundations.test.js` passa.
- Nessuna regressione: esegui almeno `test/crm-opportunities.test.js` e
  `test/pipeline.test.js` e `test/webhooks.test.js` che devono passare.
- Aggiorna HANDOFF.md (fase, task fatti, prossimo blocco Onda 1, punti di verifica)
  e spunta eventuali [RISOLTO] applicati in DECISIONI_UMANE.md (nessun [APERTA] da risolvere).
