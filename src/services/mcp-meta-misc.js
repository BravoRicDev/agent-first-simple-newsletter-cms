import { z } from "zod";

export const META = {
  "GET /api/agent/capabilities": {
    name: "agent_capabilities_get",
    description: { en: "Returns the current agent's capabilities.", it: "Restituisce le funzionalità dell'agente corrente." },
    inputSchema: {},
  },
  "GET /api/agent/sites/:siteId/events": {
    name: "sites_events_stream",
    description: { en: "Opens an SSE stream for site events.", it: "Apre un flusso SSE per gli eventi del sito." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/satellites": {
    name: "satellites_list",
    description: { en: "Lists all satellites.", it: "Elenca tutti i satelliti." },
    inputSchema: {},
  },
  "POST /api/agent/satellites": {
    name: "satellites_create",
    description: { en: "Creates a new satellite.", it: "Crea un nuovo satellite." },
    inputSchema: {
      name: z.string(),
      origin: z.string(),
      enabled: z.boolean().optional(),
      capabilities: z.array(z.string()).optional(),
      webhooks: z.array(z.object({ event: z.string(), url: z.string(), secret_ref: z.string().optional() })).optional(),
      base_internal: z.string().optional(),
      user_id: z.number().optional(),
      agent_token: z.string().optional(),
    },
  },
  "PUT /api/agent/satellites/:id": {
    name: "satellites_update",
    description: { en: "Updates an existing satellite.", it: "Aggiorna un satellite esistente." },
    inputSchema: {
      id: z.number(),
      name: z.string().optional(),
      origin: z.string().optional(),
      enabled: z.boolean().optional(),
      capabilities: z.array(z.string()).optional(),
      webhooks: z.array(z.object({ event: z.string(), url: z.string(), secret_ref: z.string().optional() })).optional(),
      base_internal: z.string().optional(),
      user_id: z.number().optional(),
      agent_token: z.string().optional(),
    },
  },
  "DELETE /api/agent/satellites/:id": {
    name: "satellites_delete",
    description: { en: "Deletes a satellite.", it: "Elimina un satellite." },
    inputSchema: { id: z.number() },
  },
  "GET /api/agent/satellites/capabilities": {
    name: "satellites_capabilities_list",
    description: { en: "Lists all satellites' capabilities.", it: "Elenca le funzionalità di tutti i satelliti." },
    inputSchema: {},
  },
  "GET /api/agent/satellites/:name/capabilities": {
    name: "satellites_get_capabilities",
    description: { en: "Gets capabilities for a specific satellite.", it: "Ottiene le funzionalità per uno specifico satellite." },
    inputSchema: { name: z.string() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/snippet-candidates": {
    name: "pages_snippet_candidates_list",
    description: { en: "Lists snippet candidates for a page.", it: "Elenca i candidati snippet per una pagina." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/blog-settings": {
    name: "blog_settings_update",
    description: { en: "Updates blog settings for a site (blog_articles_per_page, blog_card_template, blog_article_embed_template, blog_index_title, blog_index_intro_html, homepage_custom_css, homepage_custom_js). Unknown keys are ignored; send only the fields to change.", it: "Aggiorna le impostazioni del blog di un sito (blog_articles_per_page, blog_card_template, blog_article_embed_template, blog_index_title, blog_index_intro_html, homepage_custom_css, homepage_custom_js). Le chiavi sconosciute sono ignorate; invia solo i campi da cambiare." },
    inputSchema: { site_id: z.number(), blog_articles_per_page: z.union([z.string(), z.number()]).optional(), blog_card_template: z.string().optional(), blog_article_embed_template: z.string().optional(), blog_index_title: z.string().optional(), blog_index_intro_html: z.string().optional(), homepage_custom_css: z.string().optional(), homepage_custom_js: z.string().optional() },
  },
};
