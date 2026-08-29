# Documentazione OpenAPI della Surface API-compatibile

Questo documento descrive come viene costruita e servita la documentazione OpenAPI della v1.

## Cosa è

La surface `/v1` (API compatibile con CRM diffuso) espone una **documentazione OpenAPI 3.0.0** generata a runtime:

- `GET /v1/openapi.json` → lo spec completo come JSON (pubblico, senza auth).
- `GET /v1/docs` → interfaccia Swagger UI interattiva (pubblico).

Entrambe le route sono **pubbliche**: montate in `src/routes/v1.js` PRIMA di `router.use(requireTenant())`, quindi NON richiedono `Location-Id`/`Bearer`.

## Blocchi Documentati (i 6 della v1 + estensioni)

1. **Custom fields** — `/custom-fields`, `/custom-fields/object-key/{objectKey}`, `/custom-fields/folder`, `/custom-fields/{id}`.
2. **Pipeline / stadi** — `/pipelines`, `/pipelines/{id}`.
3. **Config per-tenant** — `/config`.
4. **Opportunità** — `/opportunities`, ricerca, upsert, lost-reason, pipelines, `/{id}`, `/{id}/status`, `/{id}/followers`.
5. **Contatti** — `/contacts`, ricerca, upsert, merge, duplicate check, note, tag, task, follower, campagne, workflow.
6. **Webhook OUT** — documentato nella sezione "Webhook OUT" della `description` info (sono eventi outbound verso n8n, non route /v1).
7. **API keys per-sito** — `/api-keys`, `/api-keys/{id}`.
8. **Capabilities** — `/capabilities` (registry agent-first).

Ogni risorsa è avvolta nel formato "enveloping" reale (es. `{ contact }`, `{ contacts, total }`, `{ customField }`, `{ pipeline }`, `{ config }`, `{ apiKeys }`, `{ capabilities }`). Errori documentati: `401` (tenant/API key), `404`, `400`, `409`, `201` per creazioni.

## Come è Costruito lo Spec

File principale: `src/openapi.js`.

- Esporta di default l'oggetto `SPEC` (OpenAPI 3.0.0).
- `buildPaths()` costruisce l'oggetto `paths` con un set di helper
  (`jsonBody`, `jsonResource`, `jsonList`, `listWithTotal`, `jsonDeleted`, `upsertResponses`, `pathId`, `tenantSec`, `errorResponses`) che rendono uniforme la definizione delle operazioni.
- Esporta `openapiRouter` (`Router` Express) con le due route di documentazione. Montato in `src/routes/v1.js` prima di `requireTenant()`.

## Aggiungere nuovi endpoint

Per aggiungere un nuovo endpoint all'API v1:

1. Aggiungi la route a `src/routes/v1.js`
2. Aggiungi la documentazione allo spec in `src/openapi.js` usando gli helper esistenti
3. Aggiorna il middleware `requireTenant()` se necessario
4. Aggiungi test in `test/v1-*.test.js`

Esempio pattern:

```javascript
// In src/routes/v1.js
router.get("/v1/my-feature/:id", requireTenant(), async (req, res, next) => {
  // ...
});

// In src/openapi.js
const paths = buildPaths({
  "/v1/my-feature/{id}": {
    get: {
      summary: "Get my feature",
      parameters: [pathId("id", "numeric ID of the feature")],
      responses: jsonResource("MyFeature", 200),
      secured: ["bearerAuth"],
    },
  },
  // ...
});
```

## Versioning API

L'API usa versionamento semantico:
- **v1** corrente (compatibile con CRM diffuso)
- Backward compatibility mantenuta per endpoint stabili
- Cambiamenti breaking richiedono nuova versione (v2) o migrazione

## Rate Limiting

Gli endpoint v1 sono soggetti a rate limiting:
- **Autenticazione**: 60 richieste/minuto
- **Operazioni pesanti** (esportazione, importazione): limiti specifici applicati

Controlla `src/middleware/rate-limit-v1.js` per configurazione.

## Riferimenti Correlati

- **Client API** (`src/routes/sales-api.js`): API di sola lettura per moduli satellite
- **Endpoints agente** (`src/routes/agent-*.js`, `src/routes/v1.js`): mappatura completa
- **Specifiche Postman** (`scripts/static-export-all.js`): uso in automazione
- **Generatori cliente**: OpenAPI spec è compatibile con Postman, Swagger Codegen