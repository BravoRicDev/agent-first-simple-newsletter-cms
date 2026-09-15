# PIANO MASTER — CLONE API COMPLETO (parità esterna totale)

**Data:** 25/08/2026 · **Stato:** ✅ COMPLETATO (onde A-I chiuse; vedi esito in fondo) · **Esecuzione:** cron agenti + Claude Code CLI
**Obiettivo:** qualsiasi integrazione nata per il CRM di riferimento deve funzionare contro questo
server senza modifiche. Parità richiesta su payload, record (note contatti, form submissions,
surveys, ecc.), entrambe le versioni delle API, webhook, OAuth.

---

## 1. OBIETTIVO

Trasformare il CMS-CRM in un clone API-compatibile totale del prodotto CRM di riferimento.
"Visto dall'esterno" il server deve essere indistinguibile: stessi path, stessi header,
stessi payload di richiesta/risposta, stessi record, stesso comportamento d'errore.

## 2. DECISIONI REGISTRATE (umano, 25/08/2026)

| # | Decisione | Dettaglio |
|---|---|---|
| D1 | Dialetti API | Supportare ENTRAMBE le versioni delle API del target su ogni endpoint |
| D2 | ID | `external_id UUID` per-risorsa (le PK serial interne restano); le API espongono SOLO uuid |
| D3 | Perimetro | TUTTO: contacts→surveys→invoices→memberships→OAuth provider→SaaS. Nessun modulo escluso |
| D4 | Routing | Dominio API dedicato per tenant: `apicrm.nomedominio.it`. Path root-level SOLO su quel vhost. Nessuna collisione col catch-all pagine |
| D5 | Naming | Esempio dominio documentato: `apicrm.nomedominio.it`. Nel codice/docs MAI il nome del prodotto di origine. I nomi dei campi payload sono contratto API e devono coincidere |
| D6 | Delega | Primario Claude Code CLI; se fallisce (2 tentativi) l'agente cron scrive il codice direttamente (NO litellm/deepseek per questo progetto) |

## 3. AUDIT DI PARTENZA (25/08/2026, 10 subagenti paralleli)

### Già allineato
- Layer `/v1`: header `Location-Id` + Bearer `sitekey_`, header `Version` ignorato,
  mapping site↔location (`sites.location_external_id`, migrazione 078)
- Tenancy rigorosa, rate-limit per-tenant, OpenAPI runtime su `/v1/docs`
- Engine workflow/scoring/segmenti REALI (event-driven, anti-loop)
- Quotes con PDF+signing, payment links Stripe, booking con sync Google

### Gap per dominio

| Dominio | Stato | Mancanze principali |
|---|---|---|
| Contacts | ~70% | Note keyate per email non per contactId; niente PUT nota; customFields oggetto invece che array [{id,key,field_value}]; createdAt invece di dateAdded; snake_case residuo; /tags globale assente; campaigns/workflow membership stub; task senza completed/reminderDate; niente email-verification contatto |
| Opportunities | ~50% | title→name, amount→monetaryValue, contactEmail→contactId, stage(stringa)→pipelineStageId; mancano assignedTo/source/abandoned/lastStatusChange; stage senza id stabile esposto; followers stub; upsert solo email+title |
| Calendars/Appointments | ~30% | NIENTE /v1/calendars; "bookings"≠"appointments"; manca free-slots, groups/blocks, notifications settings, teamMembers, status new/showed/noshow; due engine booking duplicati |
| Forms/Submissions | ~40% | Submission API in stile target assente su /v1; submission senza formId/contactId/submittedAt; nessun form hosted URL |
| Surveys | 0% | Zero tracce |
| Campaigns/Templates | ~20% | Newsletter non su /v1; niente relazione contatto↔campagna; niente scheduling broadcast; niente templates API |
| Conversations | ~25% | Solo email+whatsapp passivo; niente SMS; direction in/out; niente type/unreadCount/starred/allegati/live chat/inbound webhook |
| Users/Teams/Agency | ~10% | Users solo admin HTML; teams inesistenti; nessun livello agency; nessuna creazione location via API |
| OAuth | consumer-only | Manca OAuth provider per app terze (marketplace/private integrations) |
| Payments/Invoices | ~30% | Invoices/products/prices/coupons/taxes zero |
| Media | parziale | Manca /files/{fileId} nella forma target su /v1 |
| Webhook OUT | shape errata | {event_type,payload} invece di flat target-style; BUG deliverPending mai chiamata dallo scheduler |

### Deviazioni trasversali (alto impatto)
1. ID SERIAL ovunque vs UUID nel target
2. Pagination `{items,total}` vs `{items,meta:{total,nextPage,prevPage}}`; total finti su opportunities/quotes/conversations/payment-links
3. Errori `{error:"testo italiano"}` vs `{statusCode,message}`
4. Quattro convenzioni envelope convivono (wrapper /v1, array piatto sales-api, {ok:true}, raw rows)

### Bug preesistenti trovati dall'audit
- `src/routes/agent.js:3843` backup JOIN su form_submissions.form_id INESISTENTE → 500 garantito
- Webhook OUT: coda mai svuotata automaticamente (solo endpoint manuale)
- Sync Google calls: push duplicanti a ogni run + nessun refresh token
- `test-send` campagne con permesso read-only invia email reali
- Bomba temporale `calendars-agent.test.js` (slot "prossimi 7 giorni")

## 4. ARCHITETTURA NUOVA (FASE 0 — bloccante per tutte le onde)

### 4.1 Vhost API dedicato
- `db/089_sites_api_domain.sql`: `ALTER TABLE sites ADD COLUMN IF NOT EXISTS api_domain VARCHAR(255)`
  + indice unique parziale (`WHERE api_domain IS NOT NULL`). Normalizzazione lowercase.
- `src/services/api-hosts.js`: lookup `api_domain → site` con cache 60s.
- Middleware `src/middleware/api-host.js` (montato in index.js PRIMA di tutti i router):
  se `req.hostname` matcha un api_domain → `req.tenantApi = { site }` e devia tutto al router
  `src/routes/api-clone/index.js`; su quel vhost ogni altro path → 404 JSON. Domini normali intatti.
- Router clone monta le onde a path ROOT-LEVEL (`/contacts`, `/opportunities`, `/calendars`, ...).
- Admin UI /admin/sites: campo "Dominio API"; agent API sites estesa; guida Caddy wildcard.
- Test `test/api-vhost.test.js`.

### 4.2 ID esterni UUID
- `db/090_external_ids.sql` (idempotente): per ogni tabella elencata →
  `ADD COLUMN IF NOT EXISTS external_id UUID DEFAULT gen_random_uuid()` + unique index parziale.
  Tabelle fase 0: contacts, contact_notes, tasks, opportunities, pipelines, pipeline_stages,
  custom_fields, workflows, segments, forms, form_submissions, quizzes, quiz_submissions, quotes,
  payment_links, conversations, conversation_messages, newsletter_campaigns, newsletter_sequences,
  newsletter_subscribers, tracked_links, users, webhooks, booking_appointments, calendars,
  email_templates. Backfill automatico via DEFAULT.
- Service `src/services/external-ids.js`: `ensureExternalIds(table,row)`,
  `findByExternalId(table,uuid)` (uuid invalido → 400).
- Regola: le API nuove parlano SOLO uuid; gli id serial interni NON sono documentati nello spec clone.

### 4.3 Adattatore dual-dialect (`src/middleware/api-dialect.js`)
Risoluzione in ordine:
1. Dialetto legacy: header `Location-Id` + Bearer `sitekey_` (riusa tenant-api.js)
2. Dialetto moderno: Bearer + `locationId` query/body + header `Version:` validato contro lista
   versioni supportate (costante config); assente → default; non supportata → replica errore del
   target (da verificare empiricamente durante l'onda A)
3. Dialetto OAuth (fase G): Bearer access_token app terza + scope check
Output uniforme: `req.tenant`, `req.apiDialect`, `req.authContext`.
Errori uniformi `{statusCode,message}` via helper condiviso.

### 4.4 Strato serializer + paginazione
- `src/serializers/*.js` uno per risorsa: camelCase integrale, dateAdded/dateUpdated,
  id uuid, locationId, customFields array [{id,key,field_value}].
- Helper `paginate()` → meta:{total,nextPage,prevPage}; COUNT veri ovunque
  (eliminare total finti: v1.js opportunities :737/:769, quotes :874, conversations :1494,
  paymentLinks :1458).
- Infrastruttura Idempotency-Key (tabella + middleware) predisposta in fase 0.

## 5. ONDE DI SVILUPPO

**Metodo obbligatorio per OGNI endpoint di ogni onda:**
1. CONTRATTO: fixture JSON della risposta attesa (esempi ufficiali del target) →
   `test/clone-parity/fixtures/<dominio>/<endpoint>.json`
2. GOLDEN TEST: `test/clone-parity/<dominio>.test.js` — assert shape completa
   (campi, tipi, casing, envelope, meta)
3. Implementazione serializer + route + service
4. OpenAPI clone aggiornato + riga in `docs/API_COMPAT.md`

### ONDA A — Core CRM (priorità massima)
**Contacts** (`api-clone/contacts.js`): CRUD completo con filtri+meta; serializer completo
(id/locationId/firstName/lastName/companyName/phone/address*/timezone/tags[]/
customFields[{id,key,field_value}]/dateAdded/dateUpdated);
notes GET/POST/PUT/DELETE shape {note:{id,body,userId,dateAdded}} — migrazione:
contact_notes.user_id FK + contact_id INT FK + updated_at, backfill da email;
tags entity per-location (tabelle tags + associazione) con CRUD /tags/;
tasks completed boolean + reminderDate + contactId; followers DELETE;
/contacts/{id}/appointments (link onda B); enrollment history;
bulk upsert batch; duplicate search; merge; email verification per contatto.
**Opportunities**: serializer name/monetaryValue/contactId/pipelineStageId(uuid)/status+abandoned/
assignedTo/source/lastStatusChange; migrazione colonne source, last_status_change, lost_reason;
search POST filtri completi+meta; upsert per id/locationId; followers reali; lost-reason CRUD;
pipelines CRUD con stages [{id,name}] leggendo pipeline_stages (oggi solo scritta).
**Custom fields/values**: shape dataType enum/fieldKey/objectKey; folder reali;
custom values standalone by objectId.
ACCETTAZIONE: golden verde ~40 endpoint; flusso reale create-contact→add-tag→create-opportunity→
move-stage col dialetto moderno.

### ONDA B — Calendari/Appointments
Unificare engine calls legacy + booking_appointments dietro services/calendars-unified.js
(booking master). Migrazioni: calendars.external_id/is_active/timezone/appointment_notifications
JSONB/calendar_members; booking_appointments.external_id/appointment_status enum
new|confirmed|showed|noshow|cancelled. Endpoints root-level: calendars CRUD, appointments CRUD,
free-slots (struttura per-data), calendar groups, blocks, notifications settings.
Timezone per calendario nella computazione slot. Google refresh token + dedup event id.

### ONDA C — Forms/Submissions
Migrazione: form_submissions.contact_id/form_id FK nullable + backfill da data->>email/slug;
forms.external_id. Endpoints forms CRUD nella forma target; GET /forms/submissions?formIds=&startDate=&endDate=
shape completa; hosted form URL pubblico. Override autorizzato (D3) del vincolo storico
"mai modificare form_submissions" — migrazione additiva only.

### ONDA D — Surveys (da zero)
Tabelle surveys/survey_pages/survey_questions (conditional logic JSONB)/survey_submissions.
API completa + builder admin minimo (multi-pagina, branching) + evento SurveySubmitted nei webhook.
Riusare anti-spam/honeypot/rate-limit di forms.js.

### ONDA E — Campaigns / Email marketing / Templates
Mapping: newsletter_campaigns→broadcast, newsletter_sequences→drip. Migrazioni:
campaign_subscriptions materializzata; scheduled_at+stati scheduled/completed; templates per
location (email/sms) distinte dai template sistema. Endpoints: campaigns CRUD+scheduling+
statistics V2; add/remove/removeAll/subscriptions per contatto (popola lo stub
/contacts/:id/campaigns); templates CRUD; trigger links esposti; statistiche granulari.

### ONDA F — Conversazioni vere (SMS/chat/telefonia)
Provider abstraction services/channels/{sms-provider.js} (Twilio primo): send, inbound webhook,
status callback. Migrazioni: messages direction inbound/outbound + message_type
SMS|Email|Call|LiveChat|WhatsApp + status/read_at/attachments; conversations unread_count/starred/
inbox/followers. Live chat widget embeddable (/chat-widget.js, SSE/polling) + typing.
Call tracker fields (direction/type/duration/recordingUrl), voicemail flag, transcription endpoints.
Inbound webhook generico reply-to-thread. Credenziali provider per-tenant via tenant_config.

### ONDA G — Agency / Users / Teams / OAuth provider / Snapshots
Migrazioni: agencies (o parent_id su sites); teams/team_members; user_locations multi-site.
Endpoints: locations CRUD (sub-account via API), users CRUD/search/me, teams CRUD+members,
business info per location. OAUTH PROVIDER: oauth_apps terze parti, /oauth/authorize code flow,
token exchange, refresh, scope granulari per-location, install/uninstall, revoca; private
integration tokens con scope. Snapshots export/import JSON blueprint tra location.
SaaS API: plans/provisions-sso/saas-subscribers/rebilling (ultima sotto-fase).

### ONDA H — Payments/E-commerce/Media/Oggetti custom/Social/Memberships
Products/prices/coupons/taxes CRUD; invoices complete (numerazione, line items, payments, PDF
pdfkit pattern quotes); stores base. Media: tabella registro media_files(external_id,...)+
/files/{fileId} shape url+hosted; folders. Custom objects arbitrari (object_definitions/
object_records/associations; ALLOWED_OBJECTS dinamico). Phone validation E164.
Social posting REALE (FB/IG/GMB/LinkedIn/TikTok/X) via OAuth consumer + queue.
Memberships/courses/communities: contenuti hosted (media-protected), offerte, accessi end-user
(profilo separato dagli utenti admin).

### ONDA I — Webhook OUT fedeli + hardening finale
Payload flat target-style {type,eventId,eventName,locationId,<resource>{...}};
mapping eventi interno→target (ContactCreate, ContactUpdate, ContactTagAdded,
OpportunityStatusUpdate, FormSubmitted, SurveySubmitted, AppointmentNew, ...).
Endpoint subscription management; retry/backoff/timeout parity; firma header target.
OpenAPI clone completo; /v1 legacy resta attivo ma deprecated (non documentato nello spec clone).

## 6. FIX IMMEDIATI (prima delle onde)

1. agent.js:3843 backup JOIN rotto → fix minimo (join per site, senza colonna inesistente)
2. deliverPending() webhook nel tick scheduler (advisory lock già presente)
3. Sync Google calls: salvare google_event_id sulle calls (no duplicati) + refresh token
   in calendar-sync.js e booking-calendar.js
4. RBAC test-send campagne/sequenze: permesso newsletter write
5. Bomba temporale calendars-agent.test.js (date esplicite)

## 7. VERIFICA DELLA PARITÀ

1. Golden payloads per endpoint (obbligatori per ogni onda)
2. SDK harness `scripts/compat-harness.mjs`: client SDK noti dell'ecosistema target puntati a
   http://127.0.0.1:<port> con header Host simulato; scenari standard auth x2 dialetti, CRUD,
   tag, opportunity, appointment, form submission, parse webhook. Exit code = parità
3. Tracciabilità docs/API_COMPAT.md: endpoint target → rotta nostra → stato ok/parziale/mancante → onda
4. Suite esistente sempre verde (nessuna rottura retrocompat)

## 8. REGOLE TRASVERSALI (vincoli d'esecuzione)

- Migrazioni SEMPRE idempotenti (IF NOT EXISTS / DO block; mai ADD CONSTRAINT IF NOT EXISTS)
- Nessun force/reset git; commit locali only (push solo su esplicita richiesta umano)
- Naming generico nel codice/docs/commenti/test; esempio dominio apicrm.nomedominio.it
- Chiusura onda/run: suite verde, node --check file toccati, HANDOFF.md aggiornato, commit locale
- Dipendenze npm nuove solo se necessarie (libphonenumber-js onda H; twilio onda F — valutare
  client HTTP diretto per minimizzare surface)
- Delega: primario Claude Code CLI (task AMPI); 2 falliti → l'agente scrive codice direttamente
  (NO litellm per questo progetto, decisione D6)
- I test paralleli usano domini/email univoci (helpers.js) → ogni agente può lanciare SOLO i
  propri test file mirati; la suite COMPLETA gira una volta sola al centro (supervisore)

## 9. STIMA E ORDINE

| Blocco | Sforzo | Dipendenze |
|---|---|---|
| Fix immediati | XS | — |
| Fase 0 | M | — |
| Onda A | L | Fase 0 |
| Onda B | L | Fase 0, A |
| Onda C | M | A |
| Onda D | M | C, A |
| Onda E | M | A |
| Onda F | XL | Fase 0, account Twilio |
| Onda G | XL | Fase 0, A |
| Onda H | XXL | quasi tutto |
| Onda I | M | tutte |

Parallellizzabili dopo Fase 0+A: B∥C∥E; poi D∥F∥G; H; I.


---

## ESITO FINALE (25/08/2026)

- Fase 0 + Onde A,B,C,D,E,F,G1,G2,H,I: implementate e testate.
- Suite completa: 984/984 pass · Golden parity ~90 test · Harness end-to-end
  `scripts/compat-harness.mjs`: 39/39 su server reale con vhost dedicato.
- Deploy produzione eseguito (backup pre-deploy → migrazioni 092-109 → smoke OK).
- Tracciabilità endpoint e deviazioni documentate: `docs/API_COMPAT.md`.
- Lavori residui (fuori piano, opzionali): OpenAPI della surface clone,
  calendar groups/blocks, live chat widget, posting social reale, snapshots/
  SaaS API, stores.
