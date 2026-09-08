# API_COMPAT — tracciabilità clone API

Stato di parità del layer clone (vhost `apicrm.*`, path root-level, entrambi i
dialetti: legacy `Location-Id`+sitekey / moderno `Bearer`+`locationId`+`Version`).
Aggiornato al 25/08/2026 — piano in `API_CLONE_MASTER_PLAN.md`, verifica end-to-end
in `scripts/compat-harness.mjs` (39/39).

Legenda: **ok** = implementato e testato · **parziale** = funzionalità core presente,
mancano sottoparti · **—** = non implementato.

## Trasversale

| Aspect | Stato | Note |
|---|---|---|
| Auth dual-dialect | ok | legacy riusa requireTenant; moderno valida `Version` |
| Version supportate | ok | solo `2021-07-28` (enum ufficiale); errore `{statusCode:400,message:"Bad Request"}` |
| ID risorse | ok | `external_id` UUID su tutte le tabelle esposte; input/output SOLO uuid |
| Paginazione | ok | `meta:{total,nextPage,prevPage}`, COUNT veri, cursore `startAfterId` |
| Errori | ok | `{statusCode,message}` |
| locationId | ok | `sites.location_external_id ?? sites.external_id` |
| Idempotency-Key | — | infrastruttura predisposta, non obbligatoria |
| OpenAPI clone | — | spec `/v1/openapi.json` copre solo il layer legacy; spec dedicata da generare |

## Domini

| Dominio | Endpoint | Stato | Onda |
|---|---|---|---|
| System | `GET /health` | ok | 0 |
| Contacts | CRUD · `/search` · `/upsert` · `/search/duplicate` | ok | A |
| Contact notes | GET/POST/PUT/DELETE `/contacts/{id}/notes` | ok | A |
| Contact tasks | GET/POST/PUT/DELETE `/contacts/{id}/tasks` (`completed`,`reminderDate`) | ok | A |
| Contact followers | GET/POST/DELETE | ok | A |
| Contact extras | `/appointments` (link) · `/email-verification` | ok/parziale | A/B |
| Tag entity | CRUD `/tags` per location | ok | A |
| Custom fields | CRUD + `objectKey` + folders | ok/parziale (assegnazione campo→folder TODO) | A |
| Opportunities | CRUD · `/search` · `/upsert` · `/status` · followers · `/lost-reason` | ok | A |
| Pipelines | CRUD con `stages[{id,name}]` (uuid stabili lazy) | ok | A |
| Calendars | CRUD (`isActive`,`teamMembers`,`slug`) | ok | B |
| Appointments | CRUD + mapping stato `new/showed/noshow/cancelled` | ok | B |
| Free-slots | `GET /calendars/{id}/free-slots` per-date | ok | B |
| Calendar groups/blocks · notifications settings | — | — | B |
| Forms | CRUD + hosted URL | parziale (CRUD ok, hosted page no) | C |
| Form submissions | `GET /forms/submissions` filtri+linkage `formId/contactId` | ok | C |
| Surveys | CRUD con domande+`showIf` · submissions | ok | D |
| Survey builder admin | UI multi-pagina | — | D |
| Campaigns | CRUD · schedule/unschedule · send · statistics base | ok/parziale | E |
| Campaign subscriptions | add/remove/removeAll/list | ok | E |
| Templates | CRUD Email/SMS per location | ok | E |
| Trigger links su API | — | — | E |
| Conversations | lista nesting target · messages · star/read/unread | ok | F |
| SMS outbound/inbound | provider mock/Twilio · webhook `/webhooks/sms/:site/:token` | ok/parziale (Twilio da testare con credenziali reali) | F |
| Live chat widget · call tracker · voicemail/transcription | — | — | F |
| Locations | `POST /locations` · GET · business-info | ok | G1 |
| Users | CRUD · `/search` | ok/parziale (`/users/me` no) | G1 |
| Teams | CRUD + members | ok | G1 |
| Snapshots · SaaS API (plans/provisioning) | — | — | G1 |
| OAuth provider | apps · authorize/decision · token exchange · refresh rotation · revoke · userinfo | ok | G2 |
| Products/Prices | CRUD con prices inline | ok | H1 |
| Invoices | CRUD + items + coupon + status paid | ok | H1 |
| Coupons standalone CRUD | registro via SQL/API invoice | parziale | H1 |
| Stores/e-commerce | — | — | H1 |
| Media | registro `/files` CRUD (upload resta su admin) | ok/parziale | H2 |
| Custom objects | definitions/records/associations | ok | H2 |
| Social | accounts + posts (pubblicazione simulata) | parziale (posting reale richiede OAuth piattaforme) | H3 |
| Memberships/Courses/Enrollments | CRUD completo | ok | H3 |
| Webhook OUT | dual-format `legacy\|target` flat `{type,eventId,eventName,locationId,<res>}` | ok | I |
| Webhook subscription mgmt su clone API | — (gestione via `/api/agent` esistente) | parziale | I |

## Verifica

- Golden payload: `test/clone-parity/*.test.js` (~90 test)
- Harness end-to-end: `scripts/compat-harness.mjs` (39/39 — server reale, vhost vero)
- Suite completa: 984/984 pass

## Deviazioni note (documentate, volute)

1. Header `Version` assente → accettato con default ultima versione (il target
   lo richiede; scelta lenient per non rompere client semplici).
2. `quiz_completed` mappato a `FormSubmitted` nei webhook target-style.
3. `POST /locations` tramite sitekey = accesso fidato (scope agency veri con
   OAuth/scopes fase futura).
4. Inbound SMS senza email → email sintetica `<telefono>@sms.local`.
