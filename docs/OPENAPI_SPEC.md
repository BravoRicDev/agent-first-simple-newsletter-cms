# Documentazione OpenAPI della surface API-compatibile ("API compatibili con CRM diffusi")

Questo documento descrive come la documentazione OpenAPI della v1 è costruita e
servita, e come mantenerla quando si aggiungono route.

## Cosa è

La surface `/v1` (clone opensource API-compatibile, "API compatibili con CRM
diffusi") espone una **documentazione OpenAPI 3.0.0** generata a runtime:

- `GET /v1/openapi.json` → lo spec completo come JSON.
- `GET /v1/docs` → pagina HTML interattiva (Swagger UI caricata via CDN) che
  punta a `/v1/openapi.json`.

Entrambe le route sono **pubbliche**: montate in `src/routes/v1.js` PRIMA di
`router.use(requireTenant())`, quindi NON richiedono `Location-Id`/`Bearer`
(sono documentazione, non API protette).

## Blocchi documentati (i 6 della v1 + estensioni)

1. **Custom fields** — `/custom-fields`, `/custom-fields/object-key/{objectKey}`,
   `/custom-fields/folder`, `/custom-fields/{id}`.
2. **Pipelines / stages** — `/pipelines`, `/pipelines/{id}`.
3. **Config per-tenant** — `/config`.
4. **Opportunità** — `/opportunities`, search, upsert, lost-reason, pipelines,
   `/{id}`, `/{id}/status`, `/{id}/followers`.
5. **Contatti** — `/contacts`, search, upsert, duplicate, `/{id}` + sub-risorse
   (notes, tags, tasks, followers, campaigns, workflow).
6. **Webhook OUT** — documentato nella sezione "Webhook OUT" della `description`
   di `info` (sono eventi outbound verso n8n, non route /v1).
7. **API keys per-sito** — `/api-keys`, `/api-keys/{id}`.
8. **Capabilities** — `/capabilities` (registry agent-first).

Ogni risorsa è avvolta nel formato "enveloping" reale (es. `{ contact }`,
`{ contacts, total }`, `{ customField }`, `{ pipeline }`, `{ config }`,
`{ apiKeys }`, `{ capabilities }`). Errori documentati: `401` (tenant/API key),
`404`, `400`, `409`, `201` per creazioni.

## Come è costruito lo spec

File principale: `src/openapi.js`.

- Esporta di default l'oggetto `SPEC` (OpenAPI 3.0.0).
- `buildPaths()` costruisce l'oggetto `paths` con un insieme di helper
  (`jsonBody`, `jsonResource`, `jsonList`, `listWithTotal`, `jsonDeleted`,
  `upsertResponses`, `pathId`, `tenantSec`, `errorResponses`) che rendono
  uniforme la definizione delle operazioni.
- Esporta `openapiRouter` (`Router` Express) con le due route di
  documentazione. Viene montato in `src/routes/v1.js` prima di
  `requireTenant()`.

## Come mantenere lo spec

Quando aggiungi/modifichi una route in `src/routes/v1.js`:

1. Aggiungi (o aggiorna) la voce corrispondente in `buildPaths()` in
   `src/openapi.js`, con summary, parametri, requestBody e risposte coerenti con
   il payload reale restituito dal codice.
2. Se introduci un nuovo tipo di risorsa, aggiungi/estendi uno schema in
   `components.schemas`.
3. Mantieni gli item di `test/v1-openapi.test.js` allineati (la lista `expected`
   delle route chiave).

Lo spec NON è un file statico: è derivato dal codice, quindi non può andare fuori
sincrono con le route reali (a patto di mantenerlo come sopra).

## Verifica

`./scripts/test.sh test/v1-openapi.test.js` copre:

- `GET /v1/openapi.json` → 200 JSON senza auth, `openapi: 3.0.0`, `paths` non vuoto.
- Copertura: le route chiave dei 6 blocchi + api-keys + capabilities sono in `paths`.
- Security scheme `Location-Id` (apiKey header) e `BearerAuth` (http bearer) presenti.
- `GET /v1/docs` → 200 HTML contenente `swagger-ui` e `openapi.json`.
- `openapi.json` resta servito anche con header auth presenti.
