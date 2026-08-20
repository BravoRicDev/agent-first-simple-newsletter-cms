import { Router } from "express";

// ─────────────────────────────────────────────────────────────────────────
// Documentazione OpenAPI 3.0.0 della surface API-compatibile ("API compatibili
// con CRM diffusi"), montata su /v1.
//
// Lo spec è generato a runtime come oggetto JS (non file statico) così resta
// allineato alle route reali ed è facile da mantenere: quando si aggiunge una
// route a `src/routes/v1.js`, si aggiunge anche la sua voce in `paths` qui
// sotto, con schemi derivati dai payload reali restituiti dal codice.
//
// Servito pubblicamente (NON richiede Location-Id/Bearer, è documentazione):
//   - GET /v1/openapi.json → spec come JSON
//   - GET /v1/docs          → pagina HTML interattiva (Swagger UI via CDN)
// Il router viene montato in `src/routes/v1.js` PRIMA di
// `router.use(requireTenant())`, così le route di documentazione non passano
// dall'auth.
// ─────────────────────────────────────────────────────────────────────────

const SPEC = {
  openapi: "3.0.0",
  info: {
    title: "API compatibili con CRM diffusi — v1",
    version: "1.0.0",
    description:
      [
        "Surface API-compatibile con CRM diffusi, multi-tenant.",
        "",
        "## Autenticazione e tenant",
        "Ogni richiesta identifica il **tenant** (sito) tramite l'header",
        "`Location-Id` (id numerico oppure il `domain` del sito) e si autentica",
        "con l'header `Authorization: Bearer <api_key>` dove l'API key è quella",
        "del sito (creabile via `POST /v1/api-keys`). L'API key è salvata solo",
        "come SHA-256; il token in chiaro viene restituito al momento della",
        "creazione. L'header `Version:` è **ignorato** volutamente (compatibilità",
        "client): non viene applicato alcun versionamento per header.",
        "",
        "## Formato risposte",
        "Le risposte usano un formato \"enveloping\": la risorsa è avvolta in un",
        "oggetto (es. `{ contact: {...} }`, `{ contacts: [...], total }`).",
        "Errori: `401` tenant/API key mancante o non valida, `404` risorsa o",
        "tenant inesistente, `400` validazione, `409` duplicato, `201` creazione.",
        "",
        "## Webhook OUT (eventi verso n8n)",
        "Gli eventi del core CRM vengono consegnati ai webhook configurati",
        "(n8n) via `events.js` → `webhooks.js` con firma HMAC. Eventi emessi:",
        "`contact_created`, `contact_updated`, `tag_added`, `stage_changed`,",
        "`opportunity_stage_changed`, `opportunity_status_changed`, `quote_*`,",
        "`form_submitted`. Non esistono route /v1 per i webhook: sono eventi",
        "outbound verso n8n.",
      ].join("\n"),
  },
  servers: [{ url: "/v1", description: "Root della surface API-compatibile" }],
  security: [
    { LocationId: [], BearerAuth: [] },
  ],
  tags: [
    { name: "Custom fields", description: "Campi custom per-tenant (id stabili)" },
    { name: "Pipelines", description: "Pipeline e stage per-tenant (id immutabili)" },
    { name: "Config", description: "Configurazione per-tenant generalizzata" },
    { name: "Opportunità", description: "Core CRM — opportunità" },
    { name: "Contatti", description: "Core CRM — contatti e sub-risorse" },
    { name: "API keys", description: "API key per-sito (Bearer)" },
    { name: "Capabilities", description: "Registry delle capability (agent-first)" },
  ],
  paths: buildPaths(),
  components: {
    securitySchemes: {
      LocationId: {
        type: "apiKey",
        in: "header",
        name: "Location-Id",
        description: "Identifica il tenant (sito): id numerico oppure domain.",
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "sitekey_...",
        description: "API key del sito (vedi POST /v1/api-keys).",
      },
    },
    schemas: {
      Error: { type: "object", properties: { error: { type: "string" } } },
      Deleted: {
        type: "object",
        properties: { deleted: { type: "boolean", enum: [true] }, id: { type: "integer" } },
      },
      CustomField: {
        type: "object",
        description: "Definizione di un custom field per-tenant. object_key identifica l'oggetto (contact|opportunity), field_key è l'id stabile.",
        properties: {
          id: { type: "integer" },
          object_key: { type: "string" },
          field_key: { type: "string" },
          label: { type: "string" },
          type: { type: "string" },
          options: { type: "array", items: { type: "object" } },
        },
      },
      PipelineStage: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          color: { type: "string" },
          position: { type: "integer" },
        },
      },
      Pipeline: {
        type: "object",
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          is_default: { type: "boolean" },
          stages: { type: "array", items: { $ref: "#/components/schemas/PipelineStage" } },
        },
      },
      Contact: {
        type: "object",
        description: "Contatto. I custom field per-tenant sono esposti come `customFields: { field_key: value }`.",
        properties: {
          id: { type: "integer" },
          email: { type: "string" },
          name: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string" },
          companyName: { type: "string" },
          website: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string" },
          customFields: { type: "object", additionalProperties: true },
          createdAt: { type: "string" },
          updatedAt: { type: "string" },
        },
      },
      ContactCreate: {
        type: "object",
        required: ["email"],
        properties: {
          email: { type: "string" },
          name: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          phone: { type: "string" },
          companyName: { type: "string" },
          website: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          customFields: { type: "object", additionalProperties: true },
        },
      },
      Opportunity: {
        type: "object",
        description: "Opportunità. `status` ∈ open|won|lost; custom field esposti come `customFields`.",
        properties: {
          id: { type: "integer" },
          contact_email: { type: "string" },
          title: { type: "string" },
          amount: { type: "number" },
          probability: { type: "integer" },
          status: { type: "string", enum: ["open", "won", "lost"] },
          stage: { type: "string" },
          pipeline_id: { type: "integer" },
          expected_close_at: { type: "string" },
          notes: { type: "string" },
          customFields: { type: "object", additionalProperties: true },
        },
      },
      OpportunityCreate: {
        type: "object",
        required: ["contactEmail", "title"],
        properties: {
          contactEmail: { type: "string" },
          title: { type: "string" },
          amount: { type: "number" },
          probability: { type: "integer" },
          pipelineId: { type: "integer" },
          stage: { type: "string" },
          expectedCloseDate: { type: "string" },
          notes: { type: "string" },
          customFields: { type: "object", additionalProperties: true },
        },
      },
      ContactNote: {
        type: "object",
        properties: {
          id: { type: "integer" },
          contact_email: { type: "string" },
          author_type: { type: "string" },
          author_name: { type: "string" },
          body: { type: "string" },
          created_at: { type: "string" },
        },
      },
    },
  },
};

function buildPaths() {
  const base = {};

  // ── Custom fields ────────────────────────────────────────────────────
  base["/custom-fields"] = {
    get: {
      tags: ["Custom fields"], summary: "Lista custom field del tenant",
      description: "Filtro opzionale ?objectKey= per oggetto (contact|opportunity).",
      parameters: [{ name: "objectKey", in: "query", schema: { type: "string" } }],
      security: tenantSec(), responses: jsonList("customFields", "CustomField", "Custom fields del tenant"),
    },
    post: {
      tags: ["Custom fields"], summary: "Crea un custom field",
      requestBody: jsonBody({ type: "object", properties: { object_key: { type: "string" }, field_key: { type: "string" }, label: { type: "string" }, type: { type: "string" } } }),
      responses: jsonCreated("customField", "CustomField"),
    },
  };
  base["/custom-fields/object-key/{objectKey}"] = {
    get: {
      tags: ["Custom fields"], summary: "Lista custom field per object_key",
      parameters: [{ name: "objectKey", in: "path", required: true, schema: { type: "string" } }],
      security: tenantSec(), responses: jsonList("customFields", "CustomField"),
    },
  };
  base["/custom-fields/folder"] = {
    get: {
      tags: ["Custom fields"], summary: "Struttura folder custom field (v1: vuota)",
      security: tenantSec(), responses: jsonResponse(200, { folders: { type: "array", items: { type: "object" } } }),
    },
  };
  base["/custom-fields/{id}"] = {
    get: {
      tags: ["Custom fields"], summary: "Dettaglio custom field",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResource("customField", "CustomField"),
    },
    put: {
      tags: ["Custom fields"], summary: "Aggiorna custom field",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { label: { type: "string" }, type: { type: "string" }, options: { type: "array", items: { type: "object" } } } }),
      responses: jsonResource("customField", "CustomField"),
    },
    delete: {
      tags: ["Custom fields"], summary: "Elimina custom field",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };

  // ── Pipelines / stages ───────────────────────────────────────────────
  base["/pipelines"] = {
    get: {
      tags: ["Pipelines"], summary: "Lista pipeline del tenant",
      security: tenantSec(), responses: jsonList("pipelines", "Pipeline", "Pipeline del tenant"),
    },
    post: {
      tags: ["Pipelines"], summary: "Crea una pipeline con i suoi stage",
      requestBody: jsonBody({
        type: "object", required: ["name"],
        properties: {
          name: { type: "string" },
          is_default: { type: "boolean" },
          stages: { type: "array", items: { $ref: "#/components/schemas/PipelineStage" } },
        },
      }),
      responses: jsonCreated("pipeline", "Pipeline"),
    },
  };
  base["/pipelines/{id}"] = {
    get: {
      tags: ["Pipelines"], summary: "Dettaglio pipeline",
      parameters: [pathId()], security: tenantSec(), responses: jsonResource("pipeline", "Pipeline"),
    },
    put: {
      tags: ["Pipelines"], summary: "Aggiorna pipeline / stage",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({
        type: "object",
        properties: { name: { type: "string" }, is_default: { type: "boolean" }, stages: { type: "array", items: { $ref: "#/components/schemas/PipelineStage" } } },
      }),
      responses: jsonResource("pipeline", "Pipeline"),
    },
    delete: {
      tags: ["Pipelines"], summary: "Elimina pipeline",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };

  // ── Config per-tenant ────────────────────────────────────────────────
  base["/config"] = {
    get: {
      tags: ["Config"], summary: "Legge la configurazione per-tenant",
      security: tenantSec(),
      responses: jsonResponse(200, { config: { type: "object", additionalProperties: true } }),
    },
    put: {
      tags: ["Config"], summary: "Aggiorna la configurazione per-tenant (merge per chiave)",
      requestBody: jsonBody({ type: "object", properties: { config: { type: "object", additionalProperties: true } } }),
      security: tenantSec(),
      responses: jsonResponse(200, { config: { type: "object", additionalProperties: true } }),
    },
  };

  // ── Opportunità ──────────────────────────────────────────────────────
  base["/opportunities"] = {
    get: {
      tags: ["Opportunità"], summary: "Lista opportunità",
      description: "Filtri opzionali query: status, stage, contactEmail.",
      parameters: [
        { name: "status", in: "query", schema: { type: "string" } },
        { name: "stage", in: "query", schema: { type: "string" } },
        { name: "contactEmail", in: "query", schema: { type: "string" } },
      ],
      security: tenantSec(), responses: listWithTotal("opportunities", "Opportunity"),
    },
    post: {
      tags: ["Opportunità"], summary: "Crea un'opportunità",
      requestBody: jsonBody({ $ref: "#/components/schemas/OpportunityCreate" }),
      responses: {
        201: jsonResourceBody("opportunity", "Opportunity"),
        400: jsonError("Dati non validi (contactEmail + title obbligatori)"),
      },
    },
  };
  base["/opportunities/search"] = {
    post: {
      tags: ["Opportunità"], summary: "Ricerca opportunità",
      requestBody: jsonBody({
        type: "object",
        properties: { query: { type: "string" }, status: { type: "string" }, stage: { type: "string" }, contactEmail: { type: "string" }, filters: { type: "object" } },
      }),
      security: tenantSec(), responses: listWithTotal("opportunities", "Opportunity"),
    },
  };
  base["/opportunities/upsert"] = {
    post: {
      tags: ["Opportunità"], summary: "Upsert opportunità per contactEmail+title",
      requestBody: jsonBody({
        type: "object", required: ["contactEmail", "title"],
        properties: { contactEmail: { type: "string" }, title: { type: "string" }, amount: { type: "number" }, probability: { type: "integer" }, stage: { type: "string" }, pipelineId: { type: "integer" }, expectedCloseDate: { type: "string" }, notes: { type: "string" }, customFields: { type: "object", additionalProperties: true } },
      }),
      security: tenantSec(), responses: upsertResponses("opportunity", "Opportunity"),
    },
  };
  base["/opportunities/lost-reason"] = {
    get: {
      tags: ["Opportunità"], summary: "Motivi di perdita (compat)",
      security: tenantSec(),
      responses: jsonResponse(200, { lostReasons: { type: "array", items: { type: "string" } } }),
    },
  };
  base["/opportunities/pipelines"] = {
    get: {
      tags: ["Opportunità"], summary: "Alias per le pipeline del tenant",
      security: tenantSec(), responses: jsonList("pipelines", "Pipeline"),
    },
  };
  base["/opportunities/{id}"] = {
    get: {
      tags: ["Opportunità"], summary: "Dettaglio opportunità",
      parameters: [pathId()], security: tenantSec(), responses: jsonResource("opportunity", "Opportunity"),
    },
    put: {
      tags: ["Opportunità"], summary: "Aggiorna opportunità (parziale)",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({
        type: "object",
        properties: { title: { type: "string" }, stage: { type: "string" }, status: { type: "string", enum: ["open", "won", "lost"] }, amount: { type: "number" }, probability: { type: "integer" }, pipelineId: { type: "integer" }, expectedCloseDate: { type: "string" }, notes: { type: "string" }, customFields: { type: "object", additionalProperties: true } },
      }),
      responses: jsonResource("opportunity", "Opportunity"),
    },
    delete: {
      tags: ["Opportunità"], summary: "Elimina opportunità",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };
  base["/opportunities/{id}/status"] = {
    put: {
      tags: ["Opportunità"], summary: "Imposta lo status (open|won|lost)",
      parameters: [pathId()], security: tenantSec(),
      description: "Emette l'evento opportunity_status_changed → webhook out.",
      requestBody: jsonBody({ type: "object", required: ["status"], properties: { status: { type: "string", enum: ["open", "won", "lost"] } } }),
      responses: jsonResource("opportunity", "Opportunity"),
    },
  };
  base["/opportunities/{id}/followers"] = {
    get: {
      tags: ["Opportunità"], summary: "Follower dell'opportunità (v1: lista vuota)",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { followers: { type: "array", items: { type: "object" } } }),
    },
  };

  // ── Contatti ─────────────────────────────────────────────────────────
  base["/contacts"] = {
    get: {
      tags: ["Contatti"], summary: "Lista contatti",
      description: "Filtri opzionali query: limit, offset, query, tag, status.",
      parameters: [
        { name: "limit", in: "query", schema: { type: "integer" } },
        { name: "offset", in: "query", schema: { type: "integer" } },
        { name: "query", in: "query", schema: { type: "string" } },
        { name: "tag", in: "query", schema: { type: "string" } },
        { name: "status", in: "query", schema: { type: "string" } },
      ],
      security: tenantSec(), responses: listWithTotal("contacts", "Contact"),
    },
    post: {
      tags: ["Contatti"], summary: "Crea un contatto",
      description: "Emette l'evento contact_created → webhook out.",
      requestBody: jsonBody({ $ref: "#/components/schemas/ContactCreate" }),
      responses: {
        201: jsonResourceBody("contact", "Contact"),
        409: jsonError("Contatto già esistente"),
        400: jsonError("Dati non validi (email obbligatoria)"),
      },
    },
  };
  base["/contacts/search"] = {
    post: {
      tags: ["Contatti"], summary: "Ricerca contatti",
      requestBody: jsonBody({ type: "object", properties: { query: { type: "string" }, tag: { type: "string" }, filters: { type: "object" } } }),
      security: tenantSec(), responses: listWithTotal("contacts", "Contact"),
    },
  };
  base["/contacts/upsert"] = {
    post: {
      tags: ["Contatti"], summary: "Upsert contatto per email (create or update)",
      requestBody: jsonBody({
        type: "object", required: ["email"],
        properties: { email: { type: "string" }, name: { type: "string" }, firstName: { type: "string" }, lastName: { type: "string" }, phone: { type: "string" }, companyName: { type: "string" }, website: { type: "string" }, tags: { type: "array", items: { type: "string" } }, customFields: { type: "object", additionalProperties: true } },
      }),
      security: tenantSec(), responses: upsertResponses("contact", "Contact"),
    },
  };
  base["/contacts/search/duplicate"] = {
    post: {
      tags: ["Contatti"], summary: "Ricerca duplicati (email/nome/phone)",
      requestBody: jsonBody({ type: "object", properties: { email: { type: "string" }, name: { type: "string" }, phone: { type: "string" } } }),
      security: tenantSec(), responses: jsonResponse(200, { duplicates: { type: "array", items: { type: "object" } } }),
    },
  };
  base["/contacts/{id}"] = {
    get: {
      tags: ["Contatti"], summary: "Dettaglio contatto",
      parameters: [pathId()], security: tenantSec(), responses: jsonResource("contact", "Contact"),
    },
    put: {
      tags: ["Contatti"], summary: "Aggiorna contatto (parziale)",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { email: { type: "string" }, name: { type: "string" }, tags: { type: "array", items: { type: "string" } }, status: { type: "string" }, notes: { type: "string" }, customFields: { type: "object", additionalProperties: true } } }),
      responses: jsonResource("contact", "Contact"),
    },
    delete: {
      tags: ["Contatti"], summary: "Elimina contatto (e custom values)",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };
  base["/contacts/{id}/notes"] = {
    get: {
      tags: ["Contatti"], summary: "Lista note del contatto",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { notes: { type: "array", items: { $ref: "#/components/schemas/ContactNote" } } }),
    },
    post: {
      tags: ["Contatti"], summary: "Aggiunge una nota",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", required: ["body"], properties: { body: { type: "string" } } }),
      responses: jsonCreated("note", "ContactNote"),
    },
  };
  base["/contacts/{id}/notes/{noteId}"] = {
    delete: {
      tags: ["Contatti"], summary: "Elimina una nota",
      parameters: [pathId(), pathId("noteId")], security: tenantSec(), responses: jsonDeleted(),
    },
  };
  base["/contacts/{id}/tags"] = {
    get: {
      tags: ["Contatti"], summary: "Lista tag del contatto",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { tags: { type: "array", items: { type: "string" } } }),
    },
    post: {
      tags: ["Contatti"], summary: "Aggiunge tag (body { tag } o { tags: [] })",
      description: "Emette l'evento tag_added → webhook out.",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { tag: { type: "string" }, tags: { type: "array", items: { type: "string" } } } }),
      responses: jsonResponse(200, { tags: { type: "array", items: { type: "string" } } }),
    },
  };
  base["/contacts/{id}/tags/{tag}"] = {
    delete: {
      tags: ["Contatti"], summary: "Rimuove un tag",
      parameters: [pathId(), { name: "tag", in: "path", required: true, schema: { type: "string" } }],
      security: tenantSec(),
      responses: jsonResponse(200, { tags: { type: "array", items: { type: "string" } } }),
    },
  };
  base["/contacts/{id}/tasks"] = {
    get: {
      tags: ["Contatti"], summary: "Lista task del contatto",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { tasks: { type: "array", items: { type: "object" } } }),
    },
    post: {
      tags: ["Contatti"], summary: "Crea un task per il contatto",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", required: ["title"], properties: { title: { type: "string" }, notes: { type: "string" }, dueAt: { type: "string" }, assigneeId: { type: "integer" } } }),
      responses: jsonCreated("task", { type: "object" }),
    },
  };
  base["/contacts/{id}/tasks/{taskId}"] = {
    put: {
      tags: ["Contatti"], summary: "Aggiorna un task (es. status open|done)",
      parameters: [pathId(), pathId("taskId")], security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { title: { type: "string" }, notes: { type: "string" }, status: { type: "string" }, dueAt: { type: "string" }, assigneeId: { type: "integer" } } }),
      responses: jsonResource("task", { type: "object" }),
    },
  };
  base["/contacts/{id}/followers"] = {
    get: {
      tags: ["Contatti"], summary: "Lista follower del contatto",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { followers: { type: "array", items: { type: "object" } } }),
    },
    post: {
      tags: ["Contatti"], summary: "Aggiunge un follower (userId)",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { userId: { type: "integer" }, user_id: { type: "integer" } } }),
      responses: jsonResponse(201, { followers: { type: "array", items: { type: "object" } } }),
    },
  };
  base["/contacts/{id}/campaigns"] = {
    get: {
      tags: ["Contatti"], summary: "Campagne del contatto (v1: lista vuota)",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { campaigns: { type: "array", items: { type: "object" } } }),
    },
  };
  base["/contacts/{id}/workflow"] = {
    get: {
      tags: ["Contatti"], summary: "Snapshot workflow del contatto (eventi)",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { workflow: { type: "object" } }),
    },
  };

  // ── API keys per-sito ────────────────────────────────────────────────
  base["/api-keys"] = {
    get: {
      tags: ["API keys"], summary: "Lista API key del sito",
      security: tenantSec(),
      responses: jsonResponse(200, { apiKeys: { type: "array", items: { type: "object" } } }),
    },
    post: {
      tags: ["API keys"], summary: "Crea una API key",
      description: "Il token in chiaro viene restituito UNA sola volta, alla creazione. Da usare come Bearer.",
      requestBody: jsonBody({ type: "object", required: ["name"], properties: { name: { type: "string" } } }),
      security: tenantSec(),
      responses: jsonResponse(201, { apiKey: { type: "object" } }),
    },
  };
  base["/api-keys/{id}"] = {
    delete: {
      tags: ["API keys"], summary: "Revoca una API key",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };

  // ── Capabilities ─────────────────────────────────────────────────────
  base["/capabilities"] = {
    get: {
      tags: ["Capabilities"], summary: "Registry delle capability (agent-first)",
      security: tenantSec(),
      responses: jsonResponse(200, { capabilities: { type: "array", items: { type: "object" } } }),
    },
  };

  return base;
}

// ── helper per costruire operazioni ────────────────────────────────────
function tenantSec() { return [{ LocationId: [], BearerAuth: [] }]; }
function pathId(name = "id") {
  return { name, in: "path", required: true, schema: { type: "integer" } };
}
function jsonBody(schema) {
  return {
    required: true,
    content: { "application/json": { schema } },
  };
}
function errorResponses(extra = {}) {
  return {
    401: jsonError("Tenant/API key mancante o non valida"),
    404: jsonError("Risorsa inesistente"),
    400: jsonError("Validazione fallita"),
    ...extra,
  };
}
function jsonError(description, example) {
  const r = { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
  if (example) r.content["application/json"].example = { error: example };
  return r;
}
function jsonResponse(code, props, description) {
  return { [code]: { description: description || "OK", content: { "application/json": { schema: { type: "object", properties: props } } } } };
}
function jsonResource(resource, schemaRef) {
  return {
    ...errorResponses(),
    200: jsonResourceBody(resource, schemaRef),
  };
}
function jsonResourceBody(resource, schemaRef) {
  return {
    description: "OK",
    content: { "application/json": { schema: { type: "object", properties: { [resource]: { $ref: `#/components/schemas/${schemaRef}` } } } } },
  };
}
function jsonList(resource, schemaRef, description) {
  return {
    ...errorResponses(),
    200: {
      description: description || "OK",
      content: { "application/json": { schema: { type: "object", properties: { [resource]: { type: "array", items: { $ref: `#/components/schemas/${schemaRef}` } } } } } },
    },
  };
}
function listWithTotal(resource, schemaRef) {
  return {
    ...errorResponses(),
    200: {
      description: "OK",
      content: { "application/json": { schema: { type: "object", properties: { [resource]: { type: "array", items: { $ref: `#/components/schemas/${schemaRef}` } }, total: { type: "integer" } } } } },
    },
  };
}
function jsonCreated(resource, schemaRef) {
  return {
    ...errorResponses(),
    201: jsonResourceBody(resource, schemaRef),
  };
}
function jsonDeleted() {
  return {
    ...errorResponses(),
    200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Deleted" } } } },
  };
}
function upsertResponses(resource, schemaRef) {
  return {
    ...errorResponses(),
    201: { ...jsonResourceBody(resource, schemaRef), description: "Creato" },
    200: { ...jsonResourceBody(resource, schemaRef), description: "Aggiornato (già esistente)" },
  };
}

function renderDocsPage() {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API compatibili con CRM diffusi — Documentazione v1</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>html{box-sizing:border-box}*,*:before,*:after{box-sizing:inherit}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: "/v1/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    };
  </script>
</body>
</html>`;
}

function openapiJson(_, res) {
  res.type("application/json");
  res.json(SPEC);
}

function openapiDocs(_, res) {
  res.type("text/html");
  res.send(renderDocsPage());
}

// Router di documentazione montato PRIMA di requireTenant() in v1.js, affinché
// openapi.json e docs siano pubblici (documentazione, non API protette).
export const openapiRouter = Router();
openapiRouter.get("/openapi.json", openapiJson);
openapiRouter.get("/docs", openapiDocs);

export default SPEC;
