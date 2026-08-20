# HANDOFF — passaggio di consegna

File letto/aggiornato da ogni cron alla fine del proprio lavoro. Il prossimo run
riparte esattamente da qui.

## FASE CORRENTE
- v1 clone (F0 + Onda 1): **F0 — Fondamenta COMPLETATO e verificato** (commit
  7b9fb7a, faabc67, 1cc2ce1). Prossimo blocco = **ONDA 1 — Core CRM**.

## F0 COMPLETATO (punti di verifica)
- Migrazione `db/074_f0_foundations.sql` idempotente: tabelle `custom_fields`,
  `pipeline_stages`, `tenant_config`, `site_api_keys`, `capabilities` (seed base).
  Nessun `ADD CONSTRAINT IF NOT EXISTS`. Verificata doppia riesecuzione senza errori.
- `src/middleware/tenant-api.js`: `requireTenant()` risolve sito da header
  `Location-Id` (id o domain), auth Bearer su `site_api_keys` (hash SHA-256),
  `last_used_at` aggiornato, header `Version:` IGNORATO (`ignoredVersionHeader`).
- `src/services/custom-fields.js`: CRUD custom fields per-tenant, id stabile,
  evento `custom_field_updated` fire-and-forget.
- `src/services/capabilities.js`: capability registry che riusa `roles_permissions`.
- `src/routes/v1.js` montato su `/v1` in `src/index.js` (prima di
  publicCatchAllRouter). Endpoint: custom-fields (CRUD + object-key + folder),
  pipelines (+stages crud), config (tenant_config), capabilities,
  opportunities/lost-reason + pipelines alias, api-keys (crea/lista/revoca).
- `test/f0-foundations.test.js`: 9/9 PASS. Regressioni crm-opportunities/
  pipeline/webhooks 24/24 PASS. route-order PASS. Full suite: 449 pass /
  3 fail pre-esistenti (forms-crm, newsletter-base-url, newsletter-bounce) —
  verificati flaky ANCHE sul baseline (stash index.js) → non introdotti da F0.
- Nessun segreto hardcoded; `node --check` ok su tutti i file nuovi/modificati.

## PROSSIMO BLOCCO CONSIGLIATO (dal run precedente → da fare ora)
**ONDA 1 — Core CRM** (in ordine):
1. Contatti: POST/GET /v1/contacts, POST /contacts/search, GET/PUT/DELETE
   /contacts/{id}, /{id}/notes, /{id}/tags, /{id}/tasks, /{id}/followers,
   /{id}/campaigns, /{id}/workflow, contacts/upsert, search/duplicate.
2. Opportunità: /v1/opportunities CRUD/search/upsert/status/followers
   (riusa services/opportunities.js esistente).
3. Custom fields ONDA 1: già pronti in F0 — esporre il mapping dei custom
   field sui payload contatti/opportunità.
4. Webhook OUT eventi verso n8n: già presente (feature 35) — verificare che
   gli eventi /v1 (nuovo contatto, cambio fase) alimentino il webhook out.
- Aggiungere spec Onda 1 in `docs/` (stile F0_SPEC.md) prima di implementare.

## COSE GIÀ PRONTE (riusate da F0)
- `pipelines` (id SERIAL, stages JSONB), `opportunities` con
  `getBoardPipelines()` in services/opportunities.js.
- Webhook OUT (feature 35): `webhooks`/`webhook_deliveries`, firma HMAC.
- Naming generico "API compatibili con CRM diffusi" applicato.

## COSE DA NON FARE
- NON pushare su GitHub (nessun remote). Solo commit locali.
- NON migrate esterne (nessuna migrazione dati ora): schema pronto al import.
- NON usare il nome del CRM di origine nel codice/docs/README.
- NON risolvere decisioni [APERTA] — spettano all'umano (oggi non ce ne sono).
