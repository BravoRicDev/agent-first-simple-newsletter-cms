# ONDA 1 — Core CRM: Contatti + Opportunità + Webhook OUT (SPEC per agente)

Leggi OBBLIGATORIAMENTE `AGENTS.md`, `HANDOFF.md`, `DECISIONI_UMANE.md`,
`ROADMAP.md` e `docs/F0_SPEC.md` prima di iniziare. Rispetta i VINCOLI di
`AGENTS.md` (niente reset/force, niente push, migrazioni idempotenti con
IF NOT EXISTS / ON CONFLICT, MAI "ADD CONSTRAINT IF NOT EXISTS" — pitfall
069, naming generico "API compatibili con CRM diffusi" — MAI il nome del
CRM di origine).

## OBIETTIVO DEL BLOCCO
Completare la **v1 del clone** aggiungendo alla surface `/v1` (già montata in
F0) il **Core CRM**:

1. **Contatti**: CRUD + search + upsert + duplicate + sub-risorse
   (note, tags, tasks, followers, campaigns, workflow).
2. **Opportunità**: CRUD + search + upsert + status + followers
   (riusa `src/services/opportunities.js` esistente).
3. **Custom fields ONDA 1**: esporre il mapping dei custom field sui payload
   contatti/opportunità (già creati in F0).
4. **Webhook OUT**: far sì che i nuovi eventi /v1 (nuovo contatto, cambio
   fase) alimentino il webhook out esistente (feature 35 → `events.js` →
   `webhooks.js` → n8n).

TUTTE le route vanno aggiunte in `src/routes/v1.js` (stesso file di F0) e
passano già da `requireTenant()` (header `Location-Id` + Bearer API key del
sito, header `Version:` ignorato). Convenzione risposte "enveloping" JSON.

## CONTESTO PROGETTO rilevante (già verificato)
- Stack: Node 22, Express 4, ESM (`"type":"module"`), PostgreSQL 16 (pg).
- `src/routes/v1.js` è già montato su `/v1` con `router.use(requireTenant())`.
- Contatti: tabella `contacts` (id SERIAL, site_id FK, email, tags TEXT[],
  status, notes, value_estimate, is_client, client_status, pref_*, created_at,
  updated_at, UNIQUE(site_id,email)). Vedi `db/025_contacts.sql`.
- Servizio contatti esistente: `src/services/contacts.js` (upsertContact,
  getContactRecord, setContactFields, addContactTag, setContactStage,
  listTags, aggregateContacts, getContactTimeline, searchSubmissions).
  MAI rompere le firme esistenti (usate da webhooks.js, forms, newsletter).
- Note contatto: tabella `contact_notes` (id, site_id, contact_email,
  author_type human|agent|system, author_name, body, created_at). Vedi
  `db/044_conversations.sql`. Endpoint agent già presenti in
  `src/routes/crm-agent.js` (contacts/:email/notes) — riusa lo stesso pattern.
- Task: tabella `tasks` (id, site_id, email, assignee_id→users, title, notes,
  due_at, status open|done|cancelled, created_by, done_at). Servizio
  `src/services/tasks.js` (listTasks, getTask, createTask, updateTask,
  deleteTask, ...). `assignee` risolto via `users` (email/name).
- Opportunità: `src/services/opportunities.js` (listOpportunities,
  getOpportunity, createOpportunity, updateOpportunity, deleteOpportunity,
  moveOpportunityStage, getBoardPipelines). Campi: contact_email,
  pipeline_id→pipelines, stage, title, amount, probability, status
  open|won|lost, expected_close_at, notes. ALIAS da non rompere.
- Pipeline/stages: `pipelines` (stages JSONB) + `pipeline_stages` (id stabili).
- Custom fields: `src/services/custom-fields.js` (listCustomFields,
  listByObjectKey, ...). Tabella `custom_fields` (object_key, field_key, ...).
- Webhook OUT: `events.js` `emitContactEvent(siteId, email, eventType, payload)`
  → `webhooks.js` `enqueueForEvent()` → `webhook_deliveries` → n8n con firma
  HMAC. Eventi esistenti: form_submitted, tag_added, stage_changed,
  opportunity_stage_changed, opportunity_status_changed, quote_*.
- Config per-tenant: `tenant_config`.
- Test: `npm test` = migrate + `node --test`. Helper `test/helpers.js`
  (createTestSite, closeDb). Test F0 di riferimento: `test/f0-foundations.test.js`
  (crea API key dirette, usa v1Routes montati su un app di test, header auth).
- DB test: `postgres://postgres:***@127.0.0.1:15999/cms_sites_test`.

## CONTRATTO API da implementare in src/routes/v1.js

NOTA ORDINE ROUTE (Express): le route STATICHE vanno PRIMA di quelle con
parametro dinamico `/:id` (es. `/contacts/search`, `/contacts/upsert`,
`/contacts/search/duplicate` PRIMA di `/contacts/:id`).

### Contatti
- `POST /v1/contacts` → crea contatto. Body: { email (obbligatorio), name,
  firstName, lastName, phone, companyName, website, tags[], customFields{} }
  → risolve/salva su `contacts` + `form_submissions` (se name/phone/company:
  salva riga form_submissions con data JSONB compatibile — vedi sotto) + i
  custom field per-tenant (object_key='contact'). Risposta 201:
  `{ contact: { id, email, name, firstName, ..., tags, customFields, createdAt,
  updatedAt, ... } }`. Emette evento `contact_created` (→ workflow + webhook).
- `GET /v1/contacts` → lista. Query: `?limit=&offset=&query=&tag=&status=`.
  Risposta `{ contacts: [...], total }`. (Riusa aggregateContacts / ricava
  dalla tabella contacts + custom fields.)
- `POST /v1/contacts/search` → ricerca full-text. Body JSON `{ query, filters }`
  (o `{ query }`). Risposta `{ contacts: [...], total }`. Riusa
  searchSubmissions + hits su email/name/tags.
- `GET /v1/contacts/{id}` → dettaglio contatto (con custom fields + tags +
  value_estimate + is_client + client_status + note count). 404 se assente
  nel tenant.
- `PUT /v1/contacts/{id}` → update parziale (email/name/tags/status/notes/
  customFields/...). Risposta `{ contact: {...} }`. Emette `contact_updated`
  se cambia qualcosa di materiale.
- `DELETE /v1/contacts/{id}` → elimina (rimuove anche custom field values).
  Risposta `{ deleted:true, id }`.
- `POST /v1/contacts/upsert` → upsert per email (create or update).
  Risposta `{ contact: {...}, created: bool }`.
- `POST /v1/contacts/search/duplicate` → ricerca duplicati (stessa email o
  stesso nome/phone fuzzy). Body `{ email?, name?, phone? }`.
  Risposta `{ duplicates: [...] }`.
- `POST /v1/contacts/{id}/notes` → aggiunge nota (`contact_notes`, author
  human, default nome vuoto). Body `{ body }`. Risposta 201 `{ note: {...} }`.
- `GET /v1/contacts/{id}/notes` → lista note. `{ notes: [...] }`.
- `DELETE /v1/contacts/{id}/notes/{noteId}` → elimina nota. `{ deleted, id }`.
- `GET /v1/contacts/{id}/tags` → `{ tags: [...] }`.
- `POST /v1/contacts/{id}/tags` → body `{ tag }` o `{ tags: [] }`; aggiunge.
  Risposta `{ tags: [...] }`. Emette `tag_added`.
- `DELETE /v1/contacts/{id}/tags/{tag}` → rimuove tag. `{ tags: [...] }`.
- `GET /v1/contacts/{id}/tasks` → task del contatto. `{ tasks: [...] }`.
- `POST /v1/contacts/{id}/tasks` → crea task (assigneeId opzionale da users).
  Body `{ title, notes?, dueAt?, assigneeId? }`.
- `PUT /v1/contacts/{id}/tasks/{taskId}` → update task (status open|done).
  `{ task: {...} }`.
- `GET /v1/contacts/{id}/followers` → lista utenti "follower" del contatto.
  (Per v1: se manca una tabella, esponi una lista vuota `{ followers: [] }`
  con struttura pronta — vedi sotto; NON creare follower finti.)
- `POST /v1/contacts/{id}/followers` → aggiunge follower. (v1: se non c'è
  tabella, 501 con messaggio chiaro, oppure persistenza se crei la tabella.)
- `GET /v1/contacts/{id}/campaigns` → campagne/sequenze a cui il contatto è
  iscritto. (v1: se non c'è ancora un link diretto, esponi `{ campaigns: [] }`
  ricavando da newsletter_campaigns/subscriptions se esistono, altrimenti [].)
- `GET /v1/contacts/{id}/workflow` → snapshot workflow del contatto (stato sui
  workflow/segmenti). (v1: esponi `{ workflow: { ... } }` con i dati che hai —
  anche minimale.)

### Opportunità (riusa services/opportunities.js)
- `POST /v1/opportunities` → crea. Body `{ contactEmail, title, amount?,
  probability?, pipelineId?, stage?, expectedCloseDate?, notes? }`.
  Risposta 201 `{ opportunity: {...} }`. Emette opportunity_stage_changed.
- `GET /v1/opportunities` → lista (filtri query status/stage/contactEmail).
  `{ opportunities: [...], total }`.
- `POST /v1/opportunities/search` → body `{ query, filters }`.
  `{ opportunities: [...], total }`.
- `GET /v1/opportunities/{id}` → dettaglio. `{ opportunity: {...} }`. 404.
- `PUT /v1/opportunities/{id}` → update. `{ opportunity: {...} }`.
- `DELETE /v1/opportunities/{id}` → `{ deleted, id }`.
- `PUT /v1/opportunities/{id}/status` → { status: open|won|lost }
  (riusa moveOpportunityStage / updateOpportunity). `{ opportunity: {...} }`.
- `POST /v1/opportunities/upsert` → upsert per contactEmail+title.
- `GET /v1/opportunities/{id}/followers` → `{ followers: [...] }` (v1: []).
- `GET /v1/opportunities/lost-reason` → GIÀ presente (non duplicare).
- `GET /v1/opportunities/pipelines` → GIÀ presente (non duplicare).

### Custom fields ONDA 1 (mapping sui payload)
- I custom field (object_key 'contact'/'opportunity') vanno inclusi nei
  payload contatti/opportunità come `customFields: { field_key: value }`.
- Salvataggio: per v1 i valori custom si persistono in una tabella dedicata
  `contact_custom_values` (vedi migrazione sotto) colonna `values JSONB` per
  contatto (site_id+contact_email oppure contact_id). Se il contatto è il
  destinatario, riusa la stessa tabella genericamente.

### Webhook OUT / eventi
- **Nuovo contatto** (POST /contacts e POST /contacts/upsert quando creato):
  `emitContactEvent(siteId, email, "contact_created", { contact_id, email,
  name, tags })` → automatismi + webhook out verso n8n. (Le emissioni via
  events.js → webhook.js già fanno il lavoro di consegna.)
- **Cambio fase opportunità**: già emesso da services/opportunities.js
  (opportunity_stage_changed / opportunity_status_changed) → già alimenta il
  webhook out. Verificare con un test che l'enqueue avvenga.

## FILE DA CREARE/MODIFICARE

### 1. `db/075_onda1_contacts.sql` — migrazione idempotente
- `CREATE TABLE IF NOT EXISTS contact_custom_values`:
  - `id SERIAL PRIMARY KEY`
  - `site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE`
  - `contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE`
  - `object_key VARCHAR(100) NOT NULL DEFAULT 'contact'`
  - `values JSONB NOT NULL DEFAULT '{}'`   -- { field_key: value }
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - `UNIQUE(site_id, contact_id, object_key)`
  - `CREATE INDEX IF NOT EXISTS idx_contact_custom_values_site ON
    contact_custom_values(site_id, contact_id)`
- `CREATE TABLE IF NOT EXISTS contact_followers` (struttura PRONTA per v1,
  anche se gli endpoint followers v1 possono restare minimi/[](vuoto)):
  - `id SERIAL PRIMARY KEY`
  - `site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE`
  - `contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE`
  - `user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE`
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - `UNIQUE(site_id, contact_id, user_id)`
- Idempotenza: SOLO `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
  MAI `ADD CONSTRAINT IF NOT EXISTS`.
- NESSUNA migrazione dati (schema pronto, niente backfill).

### 2. `src/services/contacts-v1.js` — servizio per la surface /v1 contatti
(oppure estendere `src/services/contacts.js` SOLO aggiungendo funzioni nuove,
senza toccare quelle esistenti). Funzioni:
- `serializeContact(siteId, contactRow, { withCustom, withStats })` → oggetto
  di risposta API (email, name, firstName/lastName, phone, companyName,
  website, tags, status, notes, value_estimate, customFields{}, createdAt,
  updatedAt, is_client, client_status, + stats: formsCount/total/firstSeen/
  lastSeen se richiesti).
- `createContact(siteId, data)` / `updateContact(siteId, id, data)` /
  `getContact(siteId, id)` / `findContactByEmail(siteId, email)` /
  `deleteContact(siteId, id)` (cancella anche custom values) /
  `listContacts(siteId, { limit, offset, query, tag, status })` /
  `searchContacts(siteId, { query, tag })` / `upsertContactByEmail(siteId,
  email, data)` (ritorna { contact, created }) / `findDuplicateContacts(...)`.
- Gestione name → firstName/lastName split (su spazio).
- Salvataggio campi profilo (name/phone/company) in una riga `form_submissions`
  di servizio (site_id, form_slug='' o '__contact__', data JSONB) SOLO se
  necessario per la compatibilità di lettura (aggregateContacts). Meglio:
  aggiungere colonna `data`-like NON necessario — vedi §Decisioni sotto.
- Persistenza `contact_custom_values` (values per object_key='contact').

PORTATA MINIMA DECISIONALE (per v1, senza strafare): i campi profilo del
contatto (name, firstName, lastName, phone, companyName, website) NON hanno
colonne dedicate in `contacts` oggi. Per NON toccare lo schema esistente e NON
riscrivere typeform_submissions, li salviamo in `contact_custom_values` con
`object_key='contact'` e `field_key` = nome campo canonico (es. 'name',
'firstName', 'lastName', 'phone', 'companyName', 'website'). Così custom
fields di profilo e custom field custom convivono nello stesso storage,
serializeContact li riunisce. In alternativa spiegalo nel task a claude-code e
lascialo decidere in modo pulito e coerente con lo schema, purché:
  - MAI modificare colonne/struttura di `form_submissions` (usato ovunque),
  - il payload di risposta contatto esponga firstName/lastName/name/phone/
    companyName/website,

### 3. `src/services/custom-values.js` — get/set dei custom field values
- `getCustomValues(siteId, contactId, objectKey)`,
  `setCustomValues(siteId, contactId, objectKey, values)`, `mergeCustomValues`,
  `clearCustomValues(siteId, contactId)`.
- Mappa `{ field_key: value }` validando contro `custom_fields` del tenant
  (object_key corretto). Ignora field_key sconosciuti (log warn).

### 4. `src/services/opportunities-v1.js` — (opzionale) wrapper che serializza
   opportunità per la surface /v1 riusando `services/opportunities.js`.
   Oppure aggiungere `serializeOpportunity` in v1.js. Scegli il più pulito.

### 5. `src/routes/v1.js` — AGGIUNGERE le route del contratto sopra.
   NON rimuovere/non rinominare le route F0 esistenti. Importa i nuovi servizi.
   Mantieni l'ordine: route statiche PRIMA di /:id.

### 6. `test/onda1-contacts.test.js` e `test/onda1-opportunities-v1.test.js`
   - Pattern identico a `test/f0-foundations.test.js` (app di test con
     v1Routes, 2 tenant per isolamento, API key dirette, header auth con
     Version ignorato).
   - Copre: POST/GET/PUT/DELETE contact, search, upsert, notes CRUD, tags,
     tasks, custom fields nel payload, isolamento tenant, 404/401, webhook
     out enqueue (asserisci che `webhook_deliveries` contenga delivery per
     contact_created quando esiste un webhook out attivo che lo inoltra),
     opportunità CRUD + status + upsert + search.

### 7. `docs/ONDA1_SPEC.md` (questo file) è già il riferimento.

## VINCOLI TECNICI
- ESM: import/export. Style: stesso del repo (try/catch + next(err), helper
  http, enveloping `{ resource: [...] }`).
- Migrazioni idempotenti. MAI "ADD CONSTRAINT IF NOT EXISTS".
- NIENTE push. NIENTE reset/force.
- Non rompere: `services/contacts.js` (firme esistenti), `services/webhooks.js`,
  `services/events.js`, `services/opportunities.js`, route F0 in v1.js,
  route agent esistenti.
- Niente segreti hardcoded.
- `node --check` su ogni file toccato.

## DEFINIZIONE DI COMPLETATO
- Spec + migrazione 075 applicata senza errori (doppia riesecuzione ok).
- Tutte le route del contratto presenti e funzionanti su /v1.
- Test nuovi PASS (contacts + opportunities-v1).
- Regressioni F0 (test/f0-foundations.test.js) ancora PASS.
- Almeno i test `crm-opportunities`, `pipeline`, `webhooks` ancora PASS.
- Webhook out: verifica con test che contact_created genera delivery.
- Nessun segreto. `node --check` ok.
- Aggiornare HANDOFF.md (fase Onda 1, task fatti, prossimo blocco, verifiche)
  e spuntare eventuali [RISOLTO] applicati in DECISIONI_UMANE.md (nessun
  [APERTA] da risolvere).
