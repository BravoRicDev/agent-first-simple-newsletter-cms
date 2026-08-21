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
    { name: "Booking", description: "ONDA 2 — appuntamenti prenotati dai contatti (booking_appointments)" },
    { name: "Payment Links", description: "ONDA 2 — link di pagamento Stripe (payment_links)" },
    { name: "Conversazioni", description: "ONDA 2 — conversazioni outbound (thread email/whatsapp per contatto)" },
    { name: "Booking Public", description: "ONDA 2 — route pubbliche di prenotazione (nessun auth richiesto)" },
    { name: "Dashboard", description: "ONDA 3 — metriche KPI del CRM" },
    { name: "Funnel", description: "ONDA 3 — dati funnel di conversione per canale" },
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
      Booking: {
        type: "object",
        description: "ONDA 2 — appuntamento prenotato da un contatto (booking_appointments). `status` ∈ confirmed|pending|cancelled|completed.",
        properties: {
          id: { type: "integer" },
          site_id: { type: "integer" },
          contact_name: { type: "string" },
          contact_email: { type: "string" },
          contact_phone: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          start_time: { type: "string", format: "date-time" },
          end_time: { type: "string", format: "date-time" },
          status: { type: "string", enum: ["confirmed", "pending", "cancelled", "completed"] },
          timezone: { type: "string" },
          google_event_id: { type: "string", nullable: true },
          cancelled_at: { type: "string", format: "date-time", nullable: true },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      BookingCreate: {
        type: "object",
        required: ["start_time", "title", "contact_email"],
        properties: {
          contact_name: { type: "string" },
          contact_email: { type: "string" },
          contact_phone: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          start_time: { type: "string", format: "date-time" },
          end_time: { type: "string", format: "date-time", description: "Opzionale: se assente usa la durata default (30 min o booking_duration_minutes per-tenant)" },
          timezone: { type: "string", description: "Opzionale: se assente usa booking_timezone per-tenant o 'UTC'" },
        },
      },
      BookingSlots: {
        type: "object",
        description: "Slot disponibili per la public booking page. Gruppati per giorno.",
        properties: {
          ok: { type: "boolean" },
          groups: {
            type: "array",
            description: "Slot raggruppati per giorno",
            items: {
              type: "object",
              properties: {
                date: { type: "string", description: "Data ISO (YYYY-MM-DD)" },
                slots: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      start: { type: "string", format: "date-time", description: "Inizio slot" },
                      end: { type: "string", format: "date-time", description: "Fine slot" },
                      available: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      BookingCalendarConfig: {
        type: "object",
        description: "Configurazione di sincronizzazione booking ↔ Google Calendar per-tenant. Al massimo una config attiva per sito.",
        properties: {
          id: { type: "integer" },
          site_id: { type: "integer" },
          oauth_connection_id: { type: "integer" },
          calendar_id: { type: "string" },
          active: { type: "boolean" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      PaymentLink: {
        type: "object",
        description: "ONDA 2 — link di pagamento Stripe (payment_links). status ∈ draft|active|paid|expired.",
        properties: {
          id: { type: "integer" },
          site_id: { type: "integer" },
          opportunity_id: { type: "integer", nullable: true },
          contact_email: { type: "string" },
          title: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
          description: { type: "string" },
          status: { type: "string", enum: ["draft", "active", "paid", "expired"] },
          stripe_url: { type: "string" },
          token: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          paid_at: { type: "string", format: "date-time", nullable: true },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      PaymentLinkCreate: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          amount: { type: "number" },
          contact_email: { type: "string" },
          description: { type: "string" },
          currency: { type: "string" },
          opportunity_id: { type: "integer" },
        },
      },
      Conversation: {
        type: "object",
        description: "ONDA 2 — thread di conversazione email/whatsapp per contatto.",
        properties: {
          id: { type: "integer" },
          site_id: { type: "integer" },
          contact_email: { type: "string" },
          channel: { type: "string", enum: ["email", "whatsapp"] },
          status: { type: "string", enum: ["open", "pending", "closed"] },
          subject: { type: "string" },
          messages_count: { type: "integer" },
          last_subject: { type: "string" },
          last_message_at: { type: "string", format: "date-time" },
          created_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      ConversationMessage: {
        type: "object",
        description: "Messaggio in un thread di conversazione. direction='out' = inviato da noi, 'in' = ricevuto dal lead.",
        properties: {
          id: { type: "integer" },
          conversation_id: { type: "integer" },
          direction: { type: "string", enum: ["in", "out"] },
          subject: { type: "string" },
          body: { type: "string" },
          meta: { type: "object" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      ConversationMessageCreate: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["out", "in"], default: "out" },
          subject: { type: "string" },
          body: { type: "string" },
          meta: { type: "object" },
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

  // ── Mapping Location ↔ Site ───────────────────────────────────────────
  base["/location"] = {
    get: {
      tags: ["Config"], summary: "Legge il mapping Location ↔ Site (identificativo esterno associato al tenant)",
      security: tenantSec(),
      responses: jsonResponse(200, {
        location: { type: "object", properties: {
          siteId: { type: "integer" },
          externalId: { type: "string", nullable: true },
        } },
      }),
    },
    put: {
      tags: ["Config"], summary: "Imposta/aggiorna l'identificativo esterno della location per il tenant",
      description: "Accetta `externalId` (o `locationId` in compatibilità). Il valore, passato nell'header `Location-Id`, identifica il site.",
      requestBody: jsonBody({ type: "object", properties: {
        externalId: { type: "string" },
        locationId: { type: "string" },
      } }),
      security: tenantSec(),
      responses: {
        ...jsonResponse(200, {
          location: { type: "object", properties: {
            siteId: { type: "integer" }, externalId: { type: "string", nullable: true },
          } },
        }),
        409: jsonError("Identificativo location già associato a un altro tenant"),
      },
    },
    delete: {
      tags: ["Config"], summary: "Azzera l'identificativo esterno della location per il tenant",
      security: tenantSec(),
      responses: jsonResponse(200, { location: { type: "object", properties: { siteId: { type: "integer" }, externalId: { type: "string", nullable: true } } } }),
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
    put: {
      tags: ["Contatti"], summary: "Sostituisce COMPLETAMENTE i tag del contatto (replace)",
      description: "Il body { tags: [] } (o { tag }) diventa il nuovo set di tag del contatto.",
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
    delete: {
      tags: ["Contatti"], summary: "Elimina un task del contatto",
      parameters: [pathId(), pathId("taskId")], security: tenantSec(),
      responses: jsonResponse(200, { deleted: { type: "boolean" }, id: { type: "integer" } }),
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

  // ── Booking (ONDA 2) ─────────────────────────────────────────────────
  base["/bookings"] = {
    get: {
      tags: ["Booking"], summary: "Lista booking del tenant",
      description: "Filtri opzionali: ?q[status]=, ?q[contactEmail]=, ?q[limit]=, ?q[offset]=.",
      parameters: [
        { name: "q[status]", in: "query", schema: { type: "string", enum: ["confirmed", "pending", "cancelled", "completed"] } },
        { name: "q[contactEmail]", in: "query", schema: { type: "string" } },
        { name: "q[limit]", in: "query", schema: { type: "integer" } },
        { name: "q[offset]", in: "query", schema: { type: "integer" } },
      ],
      security: tenantSec(),
      responses: listWithTotal("bookings", "Booking"),
    },
    post: {
      tags: ["Booking"], summary: "Crea un booking",
      description: "start_time, title e contact_email obbligatori. end_time opzionale (durata default per-tenant). Applica i vincoli di lead time / finestra prenotabile configurati per-tenant (booking_lead_time_hours, booking_window_days).",
      requestBody: jsonBody({ $ref: "#/components/schemas/BookingCreate" }),
      security: tenantSec(),
      responses: jsonCreated("booking", "Booking"),
    },
  };
  base["/bookings/{id}"] = {
    get: {
      tags: ["Booking"], summary: "Dettaglio booking",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResource("booking", "Booking"),
    },
    put: {
      tags: ["Booking"], summary: "Aggiorna un booking",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ $ref: "#/components/schemas/BookingCreate" }),
      responses: jsonResource("booking", "Booking"),
    },
    delete: {
      tags: ["Booking"], summary: "Cancella un booking (soft-delete)",
      description: "Soft-delete: imposta status='cancelled' e cancelled_at=NOW(). Ritorna il booking cancellato.",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { booking: { $ref: "#/components/schemas/Booking" } }),
    },
  };

  // ── Booking Calendar Config ─────────────────────────────────────────
  base["/booking-calendar-config"] = {
    get: {
      tags: ["Booking"], summary: "Legge la config di sync calendario booking attiva",
      description: "Ritorna la config attuale (null se nessuna configurata). Senza config il booking funziona senza Google Calendar.",
      security: tenantSec(),
      responses: jsonResponse(200, { config: { nullable: true, $ref: "#/components/schemas/BookingCalendarConfig" } }),
    },
    post: {
      tags: ["Booking"], summary: "Crea/attiva una config di sync calendario booking",
      description: "Disattiva eventuale config precedente e ne crea una nuova con la connessione OAuth indicata.",
      security: tenantSec(),
      requestBody: jsonBody({
        type: "object",
        required: ["oauth_connection_id"],
        properties: {
          oauth_connection_id: { type: "integer", description: "ID della connessione OAuth attiva (feature 36)" },
          calendar_id: { type: "string", description: "ID calendario Google (default: 'primary')" },
        },
      }),
      responses: jsonResponse(201, { config: { $ref: "#/components/schemas/BookingCalendarConfig" } }),
    },
    put: {
      tags: ["Booking"], summary: "Aggiorna la config di sync calendario booking attiva",
      description: "Aggiorna oauth_connection_id e/o calendar_id della config attiva.",
      security: tenantSec(),
      requestBody: jsonBody({
        type: "object",
        properties: {
          oauth_connection_id: { type: "integer" },
          calendar_id: { type: "string" },
        },
      }),
      responses: jsonResource("config", "BookingCalendarConfig"),
    },
    delete: {
      tags: ["Booking"], summary: "Disattiva la config di sync calendario booking",
      description: "Disattiva la config attiva. I booking esistenti restano in DB ma gli eventi Google associati non vengono rimossi.",
      security: tenantSec(),
      responses: jsonResponse(200, { deleted: { type: "boolean" } }),
    },
  };

  // ── Booking Public (ONDA 2 Phase 3) ─────────────────────────────────
  base["/booking-public/{siteId}/slots"] = {
    get: {
      tags: ["Booking Public"],
      summary: "Slot disponibili per prenotazione pubblica",
      description: "JSON endpoint senza auth. Ritorna gli slot disponibili per un sito, opzionalmente filtrati per numero di giorni (?days=N).",
      parameters: [
        { name: "siteId", in: "path", required: true, schema: { type: "integer" }, description: "ID del sito" },
        { name: "days", in: "query", schema: { type: "integer" }, description: "Numero di giorni da includere (default: configurazione per-tenant)" },
      ],
      responses: {
        200: { description: "Slot disponibili", content: { "application/json": { schema: { $ref: "#/components/schemas/BookingSlots" } } } },
        404: jsonError("Sito non trovato"),
      },
    },
  };
  base["/booking-public/{siteId}"] = {
    get: {
      tags: ["Booking Public"],
      summary: "Pagina pubblica di prenotazione (HTML)",
      description: "Ritorna il form HTML di prenotazione con gli slot del giorno. Non richiede auth. I visitatori vedono gli slot disponibili e possono prenotare un appuntamento.",
      parameters: [{ name: "siteId", in: "path", required: true, schema: { type: "integer" } }],
      responses: {
        200: { description: "Pagina HTML del form prenotazione" },
        404: { description: "Sito non trovato" },
      },
    },
    post: {
      tags: ["Booking Public"],
      summary: "Crea una prenotazione pubblica",
      description: "Invia il form di prenotazione. Rate limited (10 req/min per IP). Crea un booking e upserta automaticamente il contatto CRM.",
      parameters: [{ name: "siteId", in: "path", required: true, schema: { type: "integer" } }],
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["slot", "name", "email"],
              properties: {
                slot: { type: "string", format: "date-time", description: "ISO data/ora dello slot selezionato" },
                name: { type: "string", description: "Nome del contatto" },
                email: { type: "string", format: "email", description: "Email del contatto" },
                phone: { type: "string", description: "Telefono (opzionale)" },
                _honeypot: { type: "string", description: "Anti-spam honeypot (lasciare vuoto)" },
              },
            },
          },
        },
      },
      responses: {
        200: { description: "Prenotazione riuscita (AJAX: { ok: true }; HTML: redirect a /booking-public/:id/confirmed)" },
        302: { description: "Redirect a /booking-public/:id/confirmed?email=..." },
        400: { description: "Validazione fallita (email/nome/slot non valido)" },
        409: { description: "Slot non più disponibile" },
        404: { description: "Sito non trovato" },
        429: { description: "Troppe richieste (rate limit 10/min)" },
      },
    },
  };
  base["/booking-public/{siteId}/confirmed"] = {
    get: {
      tags: ["Booking Public"],
      summary: "Pagina di conferma prenotazione (HTML)",
      description: "Pagina HTML di conferma dopo una prenotazione riuscita. Non richiede auth.",
      parameters: [
        { name: "siteId", in: "path", required: true, schema: { type: "integer" } },
        { name: "email", in: "query", schema: { type: "string", format: "email" }, description: "Email del contatto (mostrata nella conferma)" },
      ],
      responses: {
        200: { description: "Pagina HTML di conferma" },
        404: { description: "Sito non trovato" },
      },
    },
  };

  // ── Payment Links (ONDA 2) ──────────────────────────────────────────────
  base["/payment-links"] = {
    get: {
      tags: ["Payment Links"], summary: "Lista payment link del tenant",
      description: "Filtri opzionali: ?status=draft|active|paid|expired.",
      parameters: [
        { name: "status", in: "query", schema: { type: "string", enum: ["draft", "active", "paid", "expired"] } },
        { name: "limit", in: "query", schema: { type: "integer" } },
        { name: "offset", in: "query", schema: { type: "integer" } },
      ],
      security: tenantSec(),
      responses: listWithTotal("paymentLinks", "PaymentLink"),
    },
    post: {
      tags: ["Payment Links"], summary: "Crea un payment link",
      description: "Crea un link di pagamento. Se stripeSecretKey configurato, genera anche un Payment Link Stripe reale.",
      requestBody: jsonBody({ $ref: "#/components/schemas/PaymentLinkCreate" }),
      security: tenantSec(),
      responses: jsonCreated("paymentLink", "PaymentLink"),
    },
  };
  base["/payment-links/{id}"] = {
    get: {
      tags: ["Payment Links"], summary: "Dettaglio payment link",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResource("paymentLink", "PaymentLink"),
    },
    put: {
      tags: ["Payment Links"], summary: "Aggiorna un payment link",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { title: { type: "string" }, description: { type: "string" }, amount: { type: "number" }, status: { type: "string", enum: ["draft", "active", "paid", "expired"] } } }),
      responses: jsonResource("paymentLink", "PaymentLink"),
    },
    delete: {
      tags: ["Payment Links"], summary: "Elimina un payment link",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };
  base["/payment-links/{id}/mark-paid"] = {
    post: {
      tags: ["Payment Links"], summary: "Marca un payment link come pagato",
      description: "Imposta status=paid e paid_at=NOW. Emette evento payment_paid → webhook out.",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { paymentLink: { $ref: "#/components/schemas/PaymentLink" }, already: { type: "boolean" } }),
    },
  };

  // ── Conversations (ONDA 2 Phase 5) ─────────────────────────────────
  base["/conversations"] = {
    get: {
      tags: ["Conversazioni"], summary: "Lista conversazioni del tenant",
      description: "Filtri opzionali: ?email=, ?channel=email|whatsapp, ?status=open|pending|closed.",
      parameters: [
        { name: "email", in: "query", schema: { type: "string" } },
        { name: "channel", in: "query", schema: { type: "string", enum: ["email", "whatsapp"] } },
        { name: "status", in: "query", schema: { type: "string", enum: ["open", "pending", "closed"] } },
      ],
      security: tenantSec(),
      responses: listWithTotal("conversations", "Conversation"),
    },
  };
  base["/conversations/{id}"] = {
    get: {
      tags: ["Conversazioni"], summary: "Dettaglio conversazione",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResource("conversation", "Conversation"),
    },
    delete: {
      tags: ["Conversazioni"], summary: "Elimina conversazione e messaggi",
      parameters: [pathId()], security: tenantSec(), responses: jsonDeleted(),
    },
  };
  base["/conversations/{id}/messages"] = {
    get: {
      tags: ["Conversazioni"], summary: "Lista messaggi della conversazione (ordine cronologico)",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, {
        conversation: { $ref: "#/components/schemas/Conversation" },
        messages: { type: "array", items: { $ref: "#/components/schemas/ConversationMessage" } },
      }),
    },
    post: {
      tags: ["Conversazioni"], summary: "Aggiunge un messaggio (outbound) alla conversazione",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ $ref: "#/components/schemas/ConversationMessageCreate" }),
      responses: jsonCreated("message", "ConversationMessage"),
    },
  };
  base["/conversations/{id}/status"] = {
    put: {
      tags: ["Conversazioni"], summary: "Imposta lo status della conversazione (open|pending|closed)",
      parameters: [pathId()], security: tenantSec(),
      requestBody: jsonBody({ type: "object", required: ["status"], properties: { status: { type: "string", enum: ["open", "pending", "closed"] } } }),
      responses: jsonResource("conversation", "Conversation"),
    },
  };

  // ── ONDA 3: Dashboard KPI ──────────────────────────────────────────
  base["/v1/dashboard"] = {
    get: {
      tags: ["Dashboard"],
      summary: "Metriche KPI del CRM",
      description: "Restituisce KPI: lead, pipeline, win rate, task, conversazioni, attività recente. Parametro range opzionale (7d, 30d, 90d).",
      security: tenantSec(),
      parameters: [
        { name: "range", in: "query", schema: { type: "string", enum: ["7d", "30d", "90d"] }, description: "Intervallo temporale (default: 30d)" },
      ],
      responses: {
        "200": { description: "Oggetto KPI con metriche", content: { "application/json": { schema: { type: "object" } } } },
        "401": { description: "Non autenticato" },
      },
    },
  };

  // ── ONDA 3: Funnel ────────────────────────────────────────────────
  base["/v1/funnel"] = {
    get: {
      tags: ["Funnel"],
      summary: "Dati funnel di conversione per canale",
      description: "Restituisce dati funnel (visite, lead, chiamate, vittorie, revenue) raggruppati per giorno e canale. Filtrabile per intervallo date.",
      security: tenantSec(),
      parameters: [
        { name: "from", in: "query", schema: { type: "string", format: "date" }, description: "Data iniziale (AAAA-MM-GG)" },
        { name: "to", in: "query", schema: { type: "string", format: "date" }, description: "Data finale (AAAA-MM-GG)" },
      ],
      responses: {
        "200": { description: "Array funnel", content: { "application/json": { schema: { type: "object", properties: { funnel: { type: "array" } } } } } },
        "401": { description: "Non autenticato" },
      },
    },
  };

  // ── ONDA 3: Attività ──────────────────────────────────────────────
  base["/v1/activities"] = {
    get: {
      tags: ["Attività"],
      summary: "Log attività recenti del tenant",
      description: "Restituisce gli eventi di attività (contact_events) del tenant, ordinati dal più recente. Filtrabile per email, eventType (anche CSV), range temporale from/to, con paginazione limit/offset oppure a cursore (keyset su id, più efficiente). Con ?format=csv restituisce il documento CSV.",
      security: tenantSec(),
      parameters: [
        { name: "email", in: "query", schema: { type: "string" }, description: "Filtro per email (alias: contactEmail)" },
        { name: "eventType", in: "query", schema: { type: "string" }, description: "Filtro per tipo evento (singolo o CSV)" },
        { name: "from", in: "query", schema: { type: "string" }, description: "Data minima (ISO, created_at >= from). Alias: startDate" },
        { name: "to", in: "query", schema: { type: "string" }, description: "Data massima (ISO, created_at <= to). Alias: endDate" },
        { name: "limit", in: "query", schema: { type: "integer" }, description: "Max righe (default 50, max 200)" },
        { name: "offset", in: "query", schema: { type: "integer" }, description: "Offset per paginazione" },
        { name: "cursor", in: "query", schema: { type: "integer" }, description: "Paginazione a cursore: id dell'ultima riga ricevuta (restituisce le successive)" },
        { name: "format", in: "query", schema: { type: "string", enum: ["csv"] }, description: "Se 'csv' restituisce il documento CSV (text/csv)" },
      ],
      responses: {
        "200": { description: "Lista attività (JSON) o CSV", content: { "application/json": { schema: { type: "object", properties: { activities: { type: "array" }, total: { type: "integer" }, nextCursor: { type: "integer", nullable: true } } } } } },
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/contacts/{id}/activities"] = {
    get: {
      tags: ["Attività"],
      summary: "Attività di un singolo contatto",
      description: "Restituisce il log attività (contact_events) per il contatto indicato. 404 se il contatto non esiste.",
      security: tenantSec(),
      parameters: [pathId()],
      responses: {
        "200": { description: "Attività del contatto", content: { "application/json": { schema: { type: "object", properties: { activities: { type: "array" } } } } } },
        404: jsonError("Contatto non trovato"),
        401: jsonError("Non autenticato"),
      },
    },
  };

  // ── ONDA 3: Statistiche email ─────────────────────────────────────
  base["/v1/email-stats"] = {
    get: {
      tags: ["Email Stats"],
      summary: "Statistiche email aggregate del tenant",
      description: "Aggregato email del tenant: inviati, aperture, click, click-through rate (open/click su campagne).",
      security: tenantSec(),
      responses: {
        "200": { description: "Statistiche aggregate", content: { "application/json": { schema: { type: "object", properties: { emailStats: { type: "object" } } } } } },
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/email-stats/campaigns"] = {
    get: {
      tags: ["Email Stats"],
      summary: "Elenco campagne con statistiche",
      description: "Lista delle campagne del tenant con per-campagna: inviati, aperture, click e tassi. Con ?format=csv restituisce il documento CSV.",
      security: tenantSec(),
      parameters: [
        { name: "format", in: "query", schema: { type: "string", enum: ["csv"] }, description: "Se 'csv' restituisce il documento CSV (text/csv)" },
      ],
      responses: {
        "200": { description: "Campagne con statistiche (JSON) o CSV", content: { "application/json": { schema: { type: "object", properties: { campaigns: { type: "array" } } } } } },
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/email-stats/campaigns/{id}"] = {
    get: {
      tags: ["Email Stats"],
      summary: "Statistiche dettagliate di una campagna",
      description: "Statistiche complete di una campagna del tenant (invii, aperture, click con URL). 404 se non trovata.",
      security: tenantSec(),
      parameters: [pathId()],
      responses: {
        "200": { description: "Statistiche campagna", content: { "application/json": { schema: { type: "object", properties: { emailStats: { type: "object" } } } } } },
        404: jsonError("Campagna non trovata"),
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/email-stats/sequences"] = {
    get: {
      tags: ["Email Stats"],
      summary: "Elenco sequenze con statistiche",
      description: "Lista delle sequenze email del tenant con per-sequenza: passi attivi, invii, aperture, click e tassi. Con ?format=csv restituisce il documento CSV.",
      security: tenantSec(),
      parameters: [
        { name: "format", in: "query", schema: { type: "string", enum: ["csv"] }, description: "Se 'csv' restituisce il documento CSV (text/csv)" },
      ],
      responses: {
        "200": { description: "Sequenze con statistiche (JSON) o CSV", content: { "application/json": { schema: { type: "object", properties: { sequences: { type: "array" } } } } } },
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/email-stats/sequences/{id}"] = {
    get: {
      tags: ["Email Stats"],
      summary: "Statistiche dettagliate di una sequenza",
      description: "Statistiche complete di una sequenza email del tenant: passi, invii, aperture, click con URL. 404 se non trovata.",
      security: tenantSec(),
      parameters: [pathId()],
      responses: {
        "200": { description: "Statistiche sequenza", content: { "application/json": { schema: { type: "object", properties: { emailStats: { type: "object" } } } } } },
        404: jsonError("Sequenza non trovata"),
        401: jsonError("Non autenticato"),
      },
    },
  };

  // ── ONDA 3: Report ────────────────────────────────────────────────
  base["/v1/reports"] = {
    get: {
      tags: ["Report"],
      summary: "Lista configurazioni report",
      description: "Elenco delle configurazioni di report periodici del tenant.",
      security: tenantSec(),
      responses: {
        "200": { description: "Configurazioni report", content: { "application/json": { schema: { type: "object", properties: { reports: { type: "array" } } } } } },
        401: jsonError("Non autenticato"),
      },
    },
    post: {
      tags: ["Report"],
      summary: "Crea una configurazione report",
      description: "Crea una config report (kind weekly|monthly, sections whitelist, recipients max 20).",
      security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: ["weekly", "monthly"] }, sections: { type: "array", items: { type: "string" } }, recipients: { type: "array", items: { type: "string", format: "email" } } }, required: ["name"] }),
      responses: {
        "201": { description: "Configurazione creata", content: { "application/json": { schema: { type: "object", properties: { report: { type: "object" } } } } } },
        400: jsonError("Validazione fallita"),
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/reports/{id}"] = {
    get: {
      tags: ["Report"],
      summary: "Dettaglio configurazione report",
      security: tenantSec(),
      parameters: [pathId()],
      responses: {
        "200": { description: "Configurazione", content: { "application/json": { schema: { type: "object", properties: { report: { type: "object" } } } } } },
        404: jsonError("Report non trovato"),
        401: jsonError("Non autenticato"),
      },
    },
    put: {
      tags: ["Report"],
      summary: "Aggiorna una configurazione report",
      security: tenantSec(),
      parameters: [pathId()],
      requestBody: jsonBody({ type: "object" }),
      responses: {
        "200": { description: "Configurazione aggiornata", content: { "application/json": { schema: { type: "object", properties: { report: { type: "object" } } } } } },
        404: jsonError("Report non trovato"),
        400: jsonError("Validazione fallita"),
        401: jsonError("Non autenticato"),
      },
    },
    delete: {
      tags: ["Report"],
      summary: "Elimina una configurazione report",
      security: tenantSec(),
      parameters: [pathId()],
      responses: {
        "200": { description: "Eliminata", content: { "application/json": { schema: { $ref: "#/components/schemas/Deleted" } } } },
        404: jsonError("Report non trovato"),
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/reports/{id}/run"] = {
    post: {
      tags: ["Report"],
      summary: "Genera un report (dry-run, non invia email)",
      description: "Genera i dati del report { config_id, generated_at, json, html } senza inviare alcuna email SMTP.",
      security: tenantSec(),
      parameters: [pathId()],
      responses: {
        "200": { description: "Report generato", content: { "application/json": { schema: { type: "object", properties: { report: { type: "object" } } } } } },
        404: jsonError("Report non trovato"),
        401: jsonError("Non autenticato"),
      },
    },
  };

  base["/v1/reports/{id}/runs"] = {
    get: {
      tags: ["Report"],
      summary: "Storico esecuzioni di un report",
      security: tenantSec(),
      parameters: [pathId(), { name: "limit", in: "query", schema: { type: "integer" }, description: "Max righe (default 50)" }],
      responses: {
        "200": { description: "Storico run", content: { "application/json": { schema: { type: "object", properties: { runs: { type: "array" } } } } } },
        401: jsonError("Non autenticato"),
      },
    },
  };

  // ── Import dati (bulk upsert) ─────────────────────────────────────
  base["/v1/import"] = {
    post: {
      tags: ["Import"],
      summary: "Import collegate dati (contatti + task, upsert per email)",
      description: "Esegue un bulk upsert per-tenant: i contatti vengono inseriti/aggiornati per email, le task collegate. Ritorna job_id e conteggi.",
      security: tenantSec(),
      requestBody: jsonBody({ type: "object", properties: { contacts: { type: "array" }, tasks: { type: "array" }, createdBy: { type: "string" }, created_by: { type: "string" } } }),
      responses: jsonResponse(201, { job_id: { type: "integer" }, imported: { type: "integer" }, skipped: { type: "integer" } }),
    },
  };
  base["/v1/import/jobs"] = {
    get: {
      tags: ["Import"],
      summary: "Elenco job di import del tenant",
      security: tenantSec(),
      parameters: [{ name: "limit", in: "query", schema: { type: "integer" }, description: "Max righe (default 50)" }],
      responses: jsonResponse(200, { jobs: { type: "array" } }),
    },
  };
  base["/v1/import/jobs/{id}"] = {
    get: {
      tags: ["Import"],
      summary: "Dettaglio job di import",
      parameters: [pathId()], security: tenantSec(),
      responses: jsonResponse(200, { job: { type: "object" } }),
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
