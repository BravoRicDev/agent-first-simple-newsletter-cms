import { z } from "zod";

export const META = {
  "POST /api/agent/sites/:siteId/pages/bulk-categorize": {
    name: "pages_bulk_categorize",
    description: { en: "Assigns or removes a category for up to 50 pages on a site; updates blog listings and homepage sections when articles are affected.", it: "Assegna o rimuove una categoria per un massimo di 50 pagine del sito; aggiorna gli elenchi del blog e le sezioni homepage se coinvolge articoli." },
    inputSchema: { site_id: z.number(), page_ids: z.array(z.number().int().positive()).min(1).max(50), category_id: z.number().int().positive().nullable().optional() },
  },
  "GET /api/agent/sites/:siteId/categories": {
    name: "categories_list",
    description: { en: "Lists a site's categories with pagination; limit is capped at 200 and offset selects the starting position.", it: "Elenca le categorie di un sito con paginazione; limit è limitato a 200 e offset seleziona la posizione iniziale." },
    inputSchema: { site_id: z.number(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/categories/:categoryId": {
    name: "categories_get",
    description: { en: "Reads one category by its id within the specified site; returns not found if the category does not belong to that site.", it: "Legge una categoria tramite il suo id nel sito specificato; restituisce non trovato se la categoria non appartiene a quel sito." },
    inputSchema: { site_id: z.number(), category_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/categories": {
    name: "categories_create",
    description: { en: "Creates a category for a site. Name and URL slug are required; description, color, icon and custom CSS are optional.", it: "Crea una categoria per un sito. Nome e slug URL sono obbligatori; descrizione, colore, icona e CSS personalizzato sono facoltativi." },
    inputSchema: { site_id: z.number(), name: z.string().min(1).max(100), slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().optional(), color: z.union([z.string().regex(/^#[0-9a-fA-F]{3,8}$/), z.literal("")]).optional(), icon: z.string().max(10).optional(), custom_css: z.string().optional() },
  },
  "PUT /api/agent/sites/:siteId/categories/:categoryId": {
    name: "categories_update",
    description: { en: "Replaces a site's category fields; name and slug are required, while description, color, icon and custom CSS may be omitted, but omitted optional fields are cleared.", it: "Sostituisce i campi di una categoria del sito; nome e slug sono obbligatori, mentre descrizione, colore, icona e CSS personalizzato possono essere omessi, ma i campi facoltativi omessi vengono svuotati." },
    inputSchema: { site_id: z.number(), category_id: z.number(), name: z.string().min(1).max(100), slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().optional(), color: z.union([z.string().regex(/^#[0-9a-fA-F]{3,8}$/), z.literal("")]).optional(), icon: z.string().max(10).optional(), custom_css: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/categories/:categoryId": {
    name: "categories_delete",
    description: { en: "Deletes a category belonging to the specified site; this changes site content and requires a write-authorized token.", it: "Elimina una categoria appartenente al sito specificato; modifica i contenuti del sito e richiede un token autorizzato alla scrittura." },
    inputSchema: { site_id: z.number(), category_id: z.number() },
  },
  "DELETE /api/agent/sites/:siteId/pages/:pageId": {
    name: "pages_delete",
    description: { en: "Deletes a page, synchronizes homepage sections and, for articles, blog listings, and removes its static export.", it: "Elimina una pagina, sincronizza le sezioni homepage e, per gli articoli, gli elenchi del blog, e rimuove l'export statico." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "PATCH /api/agent/sites/:siteId/pages/:pageId/card-override": {
    name: "pages_card_override_set",
    description: { en: "Sets or clears a page's HTML card override; null or an empty string removes it and restores the template card.", it: "Imposta o rimuove la sostituzione HTML della card della pagina; null o una stringa vuota la rimuove e ripristina la card del template." },
    inputSchema: { site_id: z.number(), page_id: z.number(), card_html_override: z.union([z.string(), z.null()]).optional() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/snippet-candidates/apply": {
    name: "pages_snippet_candidate_apply",
    description: { en: "Creates a reusable snippet from a detected page block and replaces matching blocks across pages, saving a version for each changed page.", it: "Crea uno snippet riutilizzabile da un blocco rilevato e sostituisce i blocchi corrispondenti nelle pagine, salvando una versione per ciascuna pagina modificata." },
    inputSchema: { site_id: z.number(), page_id: z.number(), hash: z.string().regex(/^[a-f0-9]{64}$/), name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/), description: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/homepage-sections": {
    name: "homepage_sections_list",
    description: { en: "Lists homepage sections in display order and reports whether dynamic homepage rendering is enabled for the site.", it: "Elenca le sezioni homepage nell'ordine di visualizzazione e indica se il rendering dinamico della homepage è attivo per il sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/homepage-sections/activate": {
    name: "homepage_sections_activate",
    description: { en: "Enables dynamic homepage sections, synchronizes their rendered content and exports published pages for the site.", it: "Attiva le sezioni homepage dinamiche, sincronizza il contenuto renderizzato ed esporta le pagine pubblicate del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/homepage-sections/deactivate": {
    name: "homepage_sections_deactivate",
    description: { en: "Disables dynamic homepage sections, synchronizes the frozen content and exports published pages for the site.", it: "Disattiva le sezioni homepage dinamiche, sincronizza il contenuto congelato ed esporta le pagine pubblicate del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/homepage-sections/reorder": {
    name: "homepage_sections_reorder",
    description: { en: "Changes the positions of multiple homepage sections in one request; every supplied section id must belong to this site.", it: "Modifica le posizioni di più sezioni homepage in un'unica richiesta; ogni id sezione fornito deve appartenere a questo sito." },
    inputSchema: { site_id: z.number(), positions: z.array(z.object({ id: z.number().int().positive(), position: z.number().int() })).min(1) },
  },
  "GET /api/agent/sites/:siteId/homepage-sections/:sectionId": {
    name: "homepage_sections_get",
    description: { en: "Reads one homepage section and its category name by section id within the specified site.", it: "Legge una sezione homepage e il nome della relativa categoria tramite id nel sito specificato." },
    inputSchema: { site_id: z.number(), section_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/homepage-sections": {
    name: "homepage_sections_create",
    description: { en: "Creates a homepage section with type-specific content, ordering and display options; category_feed requires category_id.", it: "Crea una sezione homepage con tipo, contenuto, ordine e opzioni di visualizzazione; category_feed richiede category_id." },
    inputSchema: { site_id: z.number(), section_type: z.enum(["custom_html", "category_band", "category_feed", "all_feed"]), category_id: z.union([z.coerce.number().int().positive(), z.literal(""), z.null()]).optional(), title: z.string().max(255).optional(), articles_limit: z.coerce.number().int().min(1).max(1000).optional(), custom_html: z.string().optional(), card_template_override: z.string().max(5000).optional(), position: z.coerce.number().int().min(0).max(9999).optional(), enable_client_filter: z.union([z.boolean(), z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")]).optional(), enabled: z.union([z.boolean(), z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")]).optional() },
  },
  "PUT /api/agent/sites/:siteId/homepage-sections/:sectionId": {
    name: "homepage_sections_update",
    description: { en: "Replaces a homepage section's configuration; when dynamic rendering is enabled, the homepage is synchronized and exported.", it: "Sostituisce la configurazione di una sezione homepage; con rendering dinamico attivo, la homepage viene sincronizzata ed esportata." },
    inputSchema: { site_id: z.number(), section_id: z.number(), section_type: z.enum(["custom_html", "category_band", "category_feed", "all_feed"]), category_id: z.union([z.coerce.number().int().positive(), z.literal(""), z.null()]).optional(), title: z.string().max(255).optional(), articles_limit: z.coerce.number().int().min(1).max(1000).optional(), custom_html: z.string().optional(), card_template_override: z.string().max(5000).optional(), position: z.coerce.number().int().min(0).max(9999).optional(), enable_client_filter: z.union([z.boolean(), z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")]).optional(), enabled: z.union([z.boolean(), z.literal("on"), z.literal("true"), z.literal("1"), z.literal("")]).optional() },
  },
  "DELETE /api/agent/sites/:siteId/homepage-sections/:sectionId": {
    name: "homepage_sections_delete",
    description: { en: "Deletes a homepage section; if dynamic homepage rendering is active, synchronizes the homepage and exports published pages.", it: "Elimina una sezione homepage; se il rendering dinamico è attivo, sincronizza la homepage ed esporta le pagine pubblicate." },
    inputSchema: { site_id: z.number(), section_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/blog-settings": {
    name: "blog_settings_get",
    description: { en: "Reads the site's blog configuration, including its saved values and defaults for any unset settings.", it: "Legge la configurazione blog del sito, inclusi i valori salvati e i valori predefiniti per le impostazioni non configurate." },
    inputSchema: { site_id: z.number() },
  },
};
