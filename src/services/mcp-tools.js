import { z } from "zod";
import agentRouter from "../routes/agent.js";
import { logger } from "./logger.js";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────
// Tool set MCP = introspezione del router /api/agent reale + arricchimento
// opzionale. Un endpoint aggiunto/rimosso da agent.js compare/scompare qui
// al riavvio successivo, senza alcuna azione manuale: è la garanzia di
// allineamento richiesta, non una convenzione da ricordare. TOOL_META
// arricchisce con nome/descrizione/schema leggibili gli endpoint noti; un
// endpoint privo di entry resta comunque un tool funzionante (schema
// generico, mai assente). Vedi MCP.md.
//
// Le description sono bilingue ({en, it}, inglese come base/fallback) e
// risolte per lingua in discoverTools(lang) — stessa convenzione EN-base
// usata da locales/it.json+en.json, senza duplicare qui l'infrastruttura
// JSON (le description non sono condivise tra tool, non c'è valore nel
// centralizzarle come le stringhe API dell'Stadio 2). Gli hint dei singoli
// campi (.describe()) restano in inglese: è già la lingua di fallback,
// quindi sempre valida anche senza traduzione dedicata.
// ─────────────────────────────────────────────────────────────────────────

function pick(lang, dict) {
  if (!dict) return undefined;
  return dict[lang] || dict.en;
}

function camelToSnake(s) {
  return s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

function pathParamNames(path) {
  return [...path.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
}

// ── TOOL_META — chiave "METHOD /path/con/:param" ────────────────────────────
// Le chiavi dei campi path-param nello schema sono lo snake_case del nome
// camelCase usato nella route reale (:siteId -> site_id, :formSlug ->
// form_slug, ecc.) — conversione automatica e reversibile, nessuna mappa
// separata da mantenere.

const TOOL_META = {
  // ── Me / Sites ─────────────────────────────────────────────────────────
  "GET /api/agent/me": {
    name: "me",
    description: { en: "Identity of the authenticated account (role, assigned site, token expiry).", it: "Identità dell'account autenticato (ruolo, sito assegnato, scadenza token)." },
    inputSchema: {},
  },
  "GET /api/agent/sites": {
    name: "sites_list",
    description: { en: "Lists accessible sites. If there's only one, always use that id.", it: "Elenca i siti accessibili. Se ce n'è uno solo, usa sempre quell'id." },
    inputSchema: {},
  },

  // ── Pages — search, scheduled, bulk ───────────────────────────────────
  "GET /api/agent/sites/:siteId/pages/scheduled": {
    name: "pages_scheduled",
    description: { en: "Pages with scheduled publication (not yet published).", it: "Pagine con pubblicazione programmata (non ancora pubblicate)." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/search": {
    name: "pages_search",
    description: { en: "Searches text in the title/content of ONE site's pages (1 call, never loop manually).", it: "Cerca testo nel titolo/contenuto delle pagine di UN sito (1 chiamata, mai loop manuale)." },
    inputSchema: { site_id: z.number(), q: z.string().min(2) },
  },
  "POST /api/agent/sites/:siteId/pages/bulk-publish": {
    name: "pages_bulk_publish",
    description: { en: "Publishes/hides up to 50 pages in 1 call.", it: "Pubblica/nasconde fino a 50 pagine in 1 chiamata." },
    inputSchema: { site_id: z.number(), page_ids: z.array(z.number()).min(1).max(50), published: z.boolean() },
  },

  // ── Pages — CRUD ───────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/pages": {
    name: "pages_list",
    description: { en: "Lists a site's pages (use 'fields' to limit the returned columns).", it: "Elenca le pagine di un sito (usa 'fields' per limitare le colonne restituite)." },
    inputSchema: { site_id: z.number(), fields: z.string().optional().describe("CSV of columns, e.g. 'id,url_path,title'") },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId": {
    name: "pages_get",
    description: { en: "Reads a page in full (content included). Prefer summary/full-report if you don't need the raw content.", it: "Legge una pagina per intero (contenuto incluso). Preferire summary/full-report se non serve il contenuto grezzo." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/summary": {
    name: "pages_summary",
    description: { en: "Metrics for a page without returning its content (size, snippets/variables used, inline base64).", it: "Metriche di una pagina senza restituirne il contenuto (dimensione, snippet/variabili usate, base64 inline)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/seo": {
    name: "page_seo_get",
    description: { en: "Reads a page's SEO fields (meta title/description/keywords, canonical URL, noindex, OG image). These affect rendering for BOTH layout modes: 'wrapped' pages get them from the layout EJS, 'standalone' pages get them stitched into the <head> by injectSeoIntoStandalone (override is non-destructive — an empty field leaves the handwritten tag in the template untouched).", it: "Legge i campi SEO di una pagina (meta title/description/keywords, canonical URL, noindex, immagine OG). Hanno effetto sul rendering per ENTRAMBI i layout_mode: le pagine 'wrapped' li ricevono dal layout EJS, le 'standalone' li ricevono cuciti nel <head> da injectSeoIntoStandalone (override non distruttivo — un campo vuoto lascia intatto il tag scritto a mano nel template)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/pages/:pageId/seo": {
    name: "page_seo_set",
    description: { en: "Sets a page's SEO fields. Omitted/null fields are left unchanged. canonical_url empty = self-referencing (page's own URL); og_image empty = falls back to the site's default_og_image (see seo_set).", it: "Imposta i campi SEO di una pagina. I campi omessi/null restano invariati. canonical_url vuoto = self-referencing (URL della pagina stessa); og_image vuoto = usa il default_og_image del sito (vedi seo_set)." },
    inputSchema: {
      site_id: z.number(), page_id: z.number(),
      meta_title: z.string().optional(), meta_description: z.string().optional(), meta_keywords: z.string().optional(),
      canonical_url: z.string().optional(), noindex: z.boolean().optional(), og_image: z.string().optional(),
    },
  },
  "POST /api/agent/sites/:siteId/pages": {
    name: "pages_create",
    description: { en: "Creates a page. Inline base64 in the content is automatically extracted to files (no need for inline-to-files afterward).", it: "Crea una pagina. Il base64 inline nel contenuto viene estratto automaticamente in file (non serve inline-to-files dopo)." },
    inputSchema: {
      site_id: z.number(), url_path: z.string(), title: z.string().optional(), content: z.string().optional(),
      layout_mode: z.enum(["standalone", "wrapped"]).optional(), published: z.boolean().optional(),
      publish_at: z.string().optional().describe("ISO datetime, scheduled publication"),
    },
  },
  "PUT /api/agent/sites/:siteId/pages/:pageId": {
    name: "pages_replace",
    description: { en: "Overwrites the ENTIRE content of a page (saves a version first). Prefer find-replace for partial edits.", it: "Sovrascrive TUTTO il contenuto di una pagina (salva versione prima). Preferire find-replace per modifiche parziali." },
    inputSchema: {
      site_id: z.number(), page_id: z.number(), url_path: z.string(), title: z.string().optional(), content: z.string().optional(),
      layout_mode: z.enum(["standalone", "wrapped"]).optional(), published: z.boolean().optional(), publish_at: z.string().optional(),
    },
  },

  // ── Pages — atomic actions ─────────────────────────────────────────────
  "POST /api/agent/sites/:siteId/pages/:pageId/publish-toggle": {
    name: "pages_publish_toggle",
    description: { en: "Publishes/hides a page without touching its content. Never use PUT for this.", it: "Pubblica/nasconde una pagina senza toccarne il contenuto. Non usare mai PUT per questo." },
    inputSchema: { site_id: z.number(), page_id: z.number(), published: z.boolean().optional().describe("Omitted: flips the current state") },
  },
  "POST /api/agent/sites/:siteId/pages/bulk-duplicate": {
    name: "pages_bulk_duplicate",
    description: { en: "Duplicates up to 50 pages in 1 call (copies are always drafts).", it: "Duplica fino a 50 pagine in 1 chiamata (le copie sono sempre bozze)." },
    inputSchema: {
      site_id: z.number(),
      pages: z.array(z.object({ page_id: z.number(), new_url_path: z.string(), new_title: z.string().optional() })).min(1).max(50),
    },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/duplicate": {
    name: "pages_duplicate",
    description: { en: "Duplicates a page (the copy is always a draft).", it: "Duplica una pagina (la copia è sempre una bozza)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), new_url_path: z.string(), new_title: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/rename-url": {
    name: "pages_rename_url",
    description: { en: "Changes a page's public path (saves a version, updates the static export).", it: "Cambia il path pubblico di una pagina (salva versione, aggiorna export statico)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), new_url_path: z.string() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/find-replace": {
    name: "pages_find_replace",
    description: { en: "Finds and replaces text in a page's content (automatically saves a version first). Prefer over PUT for partial edits.", it: "Cerca e sostituisce testo nel contenuto di una pagina (salva versione automaticamente prima). Preferire a PUT per modifiche parziali." },
    inputSchema: { site_id: z.number(), page_id: z.number(), find: z.string(), replace: z.string(), regex: z.boolean().optional(), flags: z.string().optional() },
  },

  // ── Cross-site search ──────────────────────────────────────────────────
  "POST /api/agent/pages/search": {
    name: "pages_search_all_sites",
    description: { en: "Searches text across ALL accessible sites in 1 call (site_ids optional to limit scope).", it: "Cerca testo su TUTTI i siti accessibili in 1 chiamata (site_ids opzionale per limitare)." },
    inputSchema: { q: z.string().min(2), site_ids: z.array(z.number()).optional() },
  },
  "POST /api/agent/sites/:siteId/pages/bulk-find-replace": {
    name: "pages_bulk_find_replace",
    description: { en: "Finds and replaces across ALL published pages of a site in 1 call. dry_run:true to preview the impact without changing anything.", it: "Cerca e sostituisce su TUTTE le pagine pubblicate di un sito in 1 chiamata. dry_run:true per vedere l'impatto senza modificare." },
    inputSchema: { site_id: z.number(), find: z.string(), replace: z.string().optional(), regex: z.boolean().optional(), dry_run: z.boolean().optional() },
  },

  // ── Versions / restore / undo ──────────────────────────────────────────
  "GET /api/agent/sites/:siteId/pages/:pageId/versions": {
    name: "pages_versions",
    description: { en: "Version history of a page. No need to call this before find-replace (it already saves one itself).", it: "Storico versioni di una pagina. Non serve chiamarlo prima di find-replace (salva già da solo)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/versions/:versionId/restore": {
    name: "pages_restore_version",
    description: { en: "Restores a specific version (the current version is saved first).", it: "Ripristina una versione specifica (la versione corrente viene salvata prima)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), version_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/restore-last": {
    name: "pages_restore_last",
    description: { en: "Restores the last saved version, without having to read the version list first (1 call instead of 2).", it: "Ripristina l'ultima versione salvata, senza dover prima leggere l'elenco versioni (1 chiamata invece di 2)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/undo": {
    name: "pages_undo",
    description: { en: "Undoes the last change to a page (saves the current state before rolling back).", it: "Annulla l'ultima modifica a una pagina (salva lo stato corrente prima del rollback)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },

  // ── Pages — utility / analysis ──────────────────────────────────────────
  "GET /api/agent/sites/:siteId/pages/:pageId/snippet-usage": {
    name: "pages_snippet_usage",
    description: { en: "Snippets referenced in a page and whether they actually exist (detects broken {{snippet:...}}).", it: "Snippet referenziati in una pagina e se esistono davvero (rileva {{snippet:...}} rotti)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/rendered": {
    name: "pages_rendered",
    description: { en: "A page's content with snippets/variables already expanded (as it would appear published).", it: "Contenuto di una pagina con snippet/variabili già espansi (come apparirebbe pubblicato)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/diff/:versionId": {
    name: "pages_diff_version",
    description: { en: "Difference statistics (lines/characters added-removed) between the current page and a version.", it: "Statistiche di differenza (righe/caratteri aggiunti-rimossi) tra la pagina corrente e una versione." },
    inputSchema: { site_id: z.number(), page_id: z.number(), version_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/full-report": {
    name: "pages_full_report",
    description: { en: "Full analysis of a page (snippets, assets, variables) in 1 call — prefer over separate reads.", it: "Analisi completa di una pagina (snippet, asset, variabili) in 1 chiamata — preferire a letture separate." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/asset-report": {
    name: "pages_asset_report",
    description: { en: "Asset analysis for a page before editing it: downloadable external URLs, inline base64, snippets used.", it: "Analisi asset di una pagina prima di modificarla: URL esterni scaricabili, base64 inline, snippet usati." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/pages/bulk-extract-assets": {
    name: "pages_bulk_extract_assets",
    description: { en: "Downloads external assets referenced across multiple pages, localizing them in 1 call.", it: "Scarica gli asset esterni referenziati in più pagine, localizzandoli in 1 chiamata." },
    inputSchema: { site_id: z.number(), page_ids: z.array(z.number()).min(1).max(50), force: z.boolean().optional().describe("Also force files >20MB, only after user confirmation") },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/extract-assets": {
    name: "pages_extract_assets",
    description: { en: "Downloads external URLs referenced in a page and replaces them with local URLs (also propagates to other pages referencing the same URL).", it: "Scarica gli URL esterni referenziati in una pagina e li sostituisce con URL locali (propaga anche alle altre pagine che referenziano lo stesso URL)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), force: z.boolean().optional().describe("Also force files >20MB, only after user confirmation") },
  },
  "POST /api/agent/sites/:siteId/pages/bulk-inline-to-files": {
    name: "pages_bulk_inline_to_files",
    description: { en: "Converts leftover inline base64 to local files across multiple pages in 1 call (usually not needed: extraction is already automatic on create/update).", it: "Converte il base64 inline residuo in file locali su più pagine in 1 chiamata (di norma non serve: l'estrazione è già automatica su create/update)." },
    inputSchema: { site_id: z.number(), page_ids: z.array(z.number()).min(1).max(50) },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/inline-to-files": {
    name: "pages_inline_to_files",
    description: { en: "Converts leftover inline base64 of ONE page to local files (only needed for existing pages with leftover base64, not right after a create/update).", it: "Converte il base64 inline residuo di UNA pagina in file locali (serve solo per pagine esistenti con base64 residuo, non dopo una create/update appena fatta)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), minimal: z.boolean().optional().describe("Reduced response, count only") },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/validate": {
    name: "pages_validate",
    description: { en: "Checks for errors after edits: broken snippets, leftover base64, external assets, unbalanced HTML tags.", it: "Controlla errori dopo modifiche: snippet rotti, base64 residuo, asset esterni, tag HTML sbilanciati." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },

  // ── Snippets ───────────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/snippets": {
    name: "snippets_list",
    description: { en: "Lists a site's snippets.", it: "Elenca gli snippet di un sito." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/snippets/:snippetId": {
    name: "snippets_get",
    description: { en: "Reads a snippet in full.", it: "Legge uno snippet per intero." },
    inputSchema: { site_id: z.number(), snippet_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/snippets": {
    name: "snippets_create",
    description: { en: "Creates a reusable snippet (referenceable in pages with {{snippet:name}}).", it: "Crea uno snippet riutilizzabile (referenziabile nelle pagine con {{snippet:nome}})." },
    inputSchema: { site_id: z.number(), name: z.string().regex(/^[a-zA-Z0-9_-]+$/), content: z.string().optional(), description: z.string().optional() },
  },
  "PUT /api/agent/sites/:siteId/snippets/:snippetId": {
    name: "snippets_update",
    description: { en: "Overwrites a snippet. The response indicates how many pages use it (the change is already live on all of them).", it: "Sovrascrive uno snippet. La risposta indica quante pagine lo usano (la modifica è già attiva su tutte)." },
    inputSchema: { site_id: z.number(), snippet_id: z.number(), name: z.string().regex(/^[a-zA-Z0-9_-]+$/), content: z.string().optional(), description: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/snippets/:snippetId/find-replace": {
    name: "snippets_find_replace",
    description: { en: "Finds and replaces text in a snippet's content (propagates to every page that uses it).", it: "Cerca e sostituisce testo nel contenuto di uno snippet (si propaga a tutte le pagine che lo usano)." },
    inputSchema: { site_id: z.number(), snippet_id: z.number(), find: z.string(), replace: z.string(), regex: z.boolean().optional(), flags: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/snippets/:snippetId/usage": {
    name: "snippets_usage",
    description: { en: "Lists which pages use a snippet, in 1 call (never loop over every page to find out).", it: "Elenca quali pagine usano uno snippet, in 1 chiamata (mai loop su tutte le pagine per scoprirlo)." },
    inputSchema: { site_id: z.number(), snippet_id: z.number() },
  },

  // ── Media ──────────────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/media": {
    name: "media_list",
    description: { en: "Lists the files in a site's media library.", it: "Elenca i file nella media library di un sito." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/media/unused": {
    name: "media_unused",
    description: { en: "Files in the media library not referenced by any page (cleanup candidates).", it: "File nella media library non referenziati da nessuna pagina (candidati alla pulizia)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/media/upload": {
    name: "media_upload",
    description: { en: "Uploads a file to the media library (content in base64). Prefer over pasting base64 directly into a page's content.", it: "Carica un file nella media library (contenuto in base64). Preferire a incollare base64 direttamente nel contenuto di una pagina." },
    inputSchema: { site_id: z.number(), filename: z.string(), content_base64: z.string() },
    multipart: true,
  },
  "POST /api/agent/sites/:siteId/media/fetch-url": {
    name: "media_fetch_url",
    description: { en: "Imports a file from an external URL into the media library (supports shared Google Drive links). Fails if >20MB, retry with force:true after user confirmation.", it: "Importa un file da URL esterna nella media library (supporta link Google Drive condivisi). Se >20MB fallisce, richiedi con force:true dopo conferma utente." },
    inputSchema: { site_id: z.number(), url: z.string().url(), force: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/media/:filename": {
    name: "media_delete",
    description: { en: "Deletes a single file from the media library.", it: "Elimina un singolo file dalla media library." },
    inputSchema: { site_id: z.number(), filename: z.string() },
  },
  "POST /api/agent/sites/:siteId/media/cleanup": {
    name: "media_cleanup",
    description: { en: "Bulk-deletes orphan media files (all_unused:true) or a specific list (filenames[]) in 1 call.", it: "Elimina in blocco i file media orfani (all_unused:true) o un elenco specifico (filenames[]) in 1 chiamata." },
    inputSchema: { site_id: z.number(), all_unused: z.boolean().optional(), filenames: z.array(z.string()).optional() },
  },
  "POST /api/agent/sites/:siteId/media/:filename/transcribe": {
    name: "media_transcribe",
    description: { en: "Transcribes an audio/video file already in the media library (Whisper if OPENAI_API_KEY is configured, otherwise returns the extracted wav).", it: "Trascrive un file audio/video già in media library (Whisper se OPENAI_API_KEY configurata, altrimenti restituisce il wav estratto)." },
    inputSchema: { site_id: z.number(), filename: z.string(), language: z.string().optional().describe("Default 'it'") },
  },

  // ── Settings ───────────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/settings": {
    name: "settings_list",
    description: { en: "A site's key/value settings (including homepage_path).", it: "Impostazioni chiave/valore di un sito (incluso homepage_path)." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/settings/:key": {
    name: "settings_set",
    description: { en: "Sets a site configuration key (the 'homepage_path' key is handled specially).", it: "Imposta una chiave di configurazione del sito (la chiave 'homepage_path' è gestita in modo speciale)." },
    inputSchema: { site_id: z.number(), key: z.string(), value: z.string() },
  },

  // ── Audit log / Stats ────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/audit-log": {
    name: "audit_log",
    description: { en: "Log of changes made to the site (who did what and when).", it: "Log delle modifiche effettuate sul sito (chi ha fatto cosa e quando)." },
    inputSchema: { site_id: z.number(), limit: z.number().optional(), offset: z.number().optional(), entity_type: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/stats": {
    name: "stats_overview",
    description: { en: "General site statistics: total/published/draft pages, snippets, media files, last update.", it: "Statistiche generali del sito: pagine totali/pubblicate/bozze, snippet, file media, ultimo aggiornamento." },
    inputSchema: { site_id: z.number() },
  },

  // ── Moduli opzionali (attivabili per sito) ─────────────────────────────
  "GET /api/agent/sites/:siteId/modules": {
    name: "modules_list",
    description: { en: "Lists optional modules (sales pipeline, call scheduling) with their enabled state for this site.", it: "Elenca i moduli opzionali (pipeline vendite, chiamate) con il loro stato attivo/disattivo per questo sito." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/modules/:key": {
    name: "modules_toggle",
    description: { en: "Enables or disables an optional module for this site (key: sales_pipeline, call_scheduling).", it: "Attiva o disattiva un modulo opzionale per questo sito (key: sales_pipeline, call_scheduling)." },
    inputSchema: { site_id: z.number(), key: z.string(), enabled: z.boolean() },
  },

  // ── Pipeline vendite (richiede modulo sales_pipeline attivo) ───────────
  "GET /api/agent/sites/:siteId/pipeline": {
    name: "pipeline_board",
    description: { en: "Sales pipeline board: contacts grouped by fixed stage (lead/contattato/chiamata_fissata/proposta_inviata/vinto/perso), plus an unassigned bucket, with total estimated value per stage. Move a contact's stage with contact_update (status field).", it: "Board della pipeline vendite: contatti raggruppati per stadio fisso (lead/contattato/chiamata_fissata/proposta_inviata/vinto/perso), più un bucket 'da assegnare', con valore totale stimato per stadio. Sposta lo stadio di un contatto con contact_update (campo status)." },
    inputSchema: { site_id: z.number() },
  },

  // ── Chiamate (richiede modulo call_scheduling attivo) ──────────────────
  "GET /api/agent/sites/:siteId/calls": {
    name: "calls_list",
    description: { en: "Lists calls (most recent first), or all calls for one contact if email is given. Optionally filter by calendar_id (multi-calendar booking).", it: "Elenca le chiamate (dalla più recente), o tutte quelle di un contatto se viene passata email. Filtrabile per calendar_id (prenotazioni multi-calendario)." },
    inputSchema: { site_id: z.number(), email: z.string().optional(), calendar_id: z.number().optional().describe("Only calls booked on this calendar (multi-calendar)") },
  },
  "POST /api/agent/sites/:siteId/calls": {
    name: "calls_schedule",
    description: { en: "Manually schedules a call for a contact (admin/internal use — skips public availability check). Creates the contact if it doesn't exist. Optionally on a specific calendar (calendar_id).", it: "Programma manualmente una chiamata per un contatto (uso admin/interno — salta il controllo di disponibilità pubblico). Crea il contatto se non esiste. Opzionalmente su un calendario specifico (calendar_id)." },
    inputSchema: { site_id: z.number(), email: z.string(), name: z.string().optional(), scheduled_at: z.string().describe("ISO datetime"), duration_minutes: z.number().optional(), calendar_id: z.number().optional().describe("Calendar to book on (multi-calendar)") },
  },
  "PUT /api/agent/sites/:siteId/calls/:callId": {
    name: "calls_set_outcome",
    description: { en: "Sets a call's status/outcome (programmata, completata, no_show, annullata) and outcome notes.", it: "Imposta stato/esito di una chiamata (programmata, completata, no_show, annullata) e note esito." },
    inputSchema: { site_id: z.number(), call_id: z.number(), status: z.string().optional(), outcome_notes: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/calls/availability": {
    name: "calls_availability_get",
    description: { en: "Weekly recurring availability rules used to compute public booking slots. Without calendar_id: site-wide (legacy) rules; with calendar_id: that calendar's own rules (fallback to site-wide if it has none).", it: "Regole di disponibilità settimanale ricorrente usate per calcolare gli slot prenotabili pubblicamente. Senza calendar_id: regole generali (legacy); con calendar_id: le regole di quel calendario (fallback alle generali se non ne ha)." },
    inputSchema: { site_id: z.number(), calendar_id: z.number().optional().describe("Calendar-specific rules (multi-calendar)") },
  },
  "PUT /api/agent/sites/:siteId/calls/availability": {
    name: "calls_availability_set",
    description: { en: "Atomically replaces all availability rules. weekday: 0=Sunday..6=Saturday. Times as \"HH:MM\". Pass calendar_id to set a specific calendar's rules (multi-calendar), omit for site-wide legacy rules.", it: "Sostituisce atomicamente tutte le regole di disponibilità. weekday: 0=domenica..6=sabato. Orari come \"HH:MM\". Passa calendar_id per impostare le regole di un calendario specifico (multi-calendario), omettilo per le regole generali legacy." },
    inputSchema: { site_id: z.number(), rules: z.array(z.object({ weekday: z.number(), start_time: z.string(), end_time: z.string(), slot_minutes: z.number().optional() })), calendar_id: z.number().optional().describe("Calendar to set rules for (multi-calendar)") },
  },
  "GET /api/agent/sites/:siteId/calls/slots": {
    name: "calls_available_slots",
    description: { en: "Computed available booking slots for the next N days (default 14), from availability rules minus already-booked calls. Pass calendar_id to get that calendar's slots (multi-calendar).", it: "Slot di prenotazione disponibili calcolati per i prossimi N giorni (default 14), dalle regole di disponibilità meno le chiamate già prenotate. Passa calendar_id per gli slot di un calendario specifico (multi-calendario)." },
    inputSchema: { site_id: z.number(), days: z.number().optional(), calendar_id: z.number().optional().describe("Calendar to compute slots for (multi-calendar)") },
  },
  "POST /api/agent/sites/:siteId/calls/book": {
    name: "calls_book",
    description: { en: "Books a call on someone's behalf (e.g. from an n8n flow after a WhatsApp/email reply) — re-verifies the slot is still free, sends confirmation email unless notify:false. Pass calendar_id to book on a specific calendar (multi-calendar).", it: "Prenota una chiamata per conto di qualcuno (es. da un flow n8n dopo una risposta WhatsApp/email) — ri-verifica che lo slot sia ancora libero, invia l'email di conferma a meno di notify:false. Passa calendar_id per prenotare su un calendario specifico (multi-calendario)." },
    inputSchema: { site_id: z.number(), email: z.string(), name: z.string().optional(), start: z.string().describe("ISO datetime"), duration_minutes: z.number().optional(), notify: z.boolean().optional(), calendar_id: z.number().optional().describe("Calendar to book on (multi-calendar)") },
  },

  // ── Calendari (multi-agenda, richiede modulo call_scheduling attivo) ─────
  "GET /api/agent/sites/:siteId/calendars": {
    name: "calendars_list",
    description: { en: "Lists the site's bookable calendars (multi-calendar booking, e.g. 'Consulenza', 'Demo') with owner email. Each calendar has its own availability and calls. Embed in pages with {{calendar:slug}}.", it: "Elenca i calendari prenotabili del sito (prenotazioni multi-calendario, es. 'Consulenza', 'Demo') con email del proprietario. Ogni calendario ha la propria disponibilità e le proprie chiamate. Si integra nelle pagine con {{calendar:slug}}." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/calendars": {
    name: "calendars_create",
    description: { en: "Creates a bookable calendar (multi-agenda). Slug is auto-sanitized (lowercase, hyphens); enabled defaults to true. The calendar becomes available as {{calendar:slug}} in pages and /book/:siteId/:slug. Optional ty_page: thank-you page the visitor is redirected to after a successful booking (relative path like /grazie or same-domain URL; empty = standard confirmation).", it: "Crea un calendario prenotabile (multi-agenda). Lo slug è sanitizzato automaticamente (minuscolo, trattini); enabled di default true. Il calendario diventa disponibile come {{calendar:slug}} nelle pagine e su /book/:siteId/:slug. ty_page opzionale: pagina di ringraziamento a cui portare il visitatore dopo una prenotazione riuscita (path relativo tipo /grazie o URL stesso dominio; vuoto = conferma standard)." },
    inputSchema: { site_id: z.number(), name: z.string().describe("Display name, e.g. 'Consulenza'"), slug: z.string().optional().describe("URL slug; if omitted, derived from name"), description: z.string().optional(), user_id: z.number().optional().describe("Owner user id"), enabled: z.boolean().optional(), ty_page: z.string().optional().describe("Thank-you page/redirect after booking, e.g. /grazie") },
  },
  "PUT /api/agent/sites/:siteId/calendars/:calendarId": {
    name: "calendars_update",
    description: { en: "Updates a calendar's name/slug/description/owner/enabled/ty_page. Disabling it stops {{calendar:slug}} expansion and /book/:siteId/:slug resolution; existing bookings stay linked. ty_page: thank-you page after a successful booking (relative path or same-domain URL; empty string clears it).", it: "Aggiorna nome/slug/descrizione/proprietario/enabled/ty_page di un calendario. Disattivandolo, {{calendar:slug}} non viene più espanso e /book/:siteId/:slug non lo risolve; le prenotazioni esistenti restano collegate. ty_page: pagina di ringraziamento dopo una prenotazione riuscita (path relativo o URL stesso dominio; stringa vuota la rimuove)." },
    inputSchema: { site_id: z.number(), calendar_id: z.number(), name: z.string().optional(), slug: z.string().optional(), description: z.string().optional(), user_id: z.number().optional().describe("Owner user id; pass null to unassign"), enabled: z.boolean().optional(), ty_page: z.string().optional().describe("Thank-you page/redirect after booking; empty string clears") },
  },
  "DELETE /api/agent/sites/:siteId/calendars/:calendarId": {
    name: "calendars_delete",
    description: { en: "Deletes a calendar. Its availability rules are cascade-deleted; existing bookings stay but are unlinked (calendar_id set to NULL).", it: "Elimina un calendario. Le sue regole di disponibilità vengono eliminate a cascata; le prenotazioni esistenti restano ma vengono scollegate (calendar_id a NULL)." },
    inputSchema: { site_id: z.number(), calendar_id: z.number() },
  },

  // ── Tracking & Analytics ────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/tracking": {
    name: "tracking_get",
    description: { en: "Reads tracking/analytics config for the site: GA4, GTM, Meta Pixel + Conversions API, Microsoft Clarity, Search Console verification. Meta CAPI access token is masked (never returned in clear).", it: "Legge la configurazione tracking/analytics del sito: GA4, GTM, Meta Pixel + Conversions API, Microsoft Clarity, verifica Search Console. Il token di accesso Meta CAPI è mascherato (mai restituito in chiaro)." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/tracking": {
    name: "tracking_set",
    description: { en: "Sets tracking/analytics config for the site. Omitted fields are left unchanged; pass an empty string to clear a field (consent banner texts fall back to sensible Italian defaults when cleared). Once ga4_id/gtm_id/meta_pixel_id/clarity_id is set, the GDPR consent banner (Consent Mode v2) automatically appears on the public site — no separate toggle.", it: "Imposta la configurazione tracking/analytics del sito. I campi omessi restano invariati; stringa vuota per cancellare un campo (i testi del banner di consenso tornano ai default in italiano se cancellati). Appena ga4Id/gtmId/metaPixelId/clarityId è impostato, il banner di consenso GDPR (Consent Mode v2) compare automaticamente sul sito pubblico — nessun toggle separato." },
    inputSchema: { site_id: z.number(), ga4Id: z.string().optional(), gtmId: z.string().optional(), metaPixelId: z.string().optional(), metaCapiToken: z.string().optional().describe("Meta Conversions API access token, from Events Manager"), metaCapiTestCode: z.string().optional(), clarityId: z.string().optional(), searchConsoleVerification: z.string().optional(), consentBannerText: z.string().optional().describe("Cookie banner main message"), consentAcceptLabel: z.string().optional(), consentRejectLabel: z.string().optional(), consentPrivacyUrl: z.string().optional().describe("Optional link shown in the banner, e.g. to a privacy policy page") },
  },

  // ── SEO ────────────────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/seo": {
    name: "seo_get",
    description: { en: "Reads site-wide SEO defaults: default OG/Twitter image (used by pages without their own), Twitter handle, extra robots.txt rules.", it: "Legge i default SEO a livello di sito: immagine OG/Twitter predefinita (usata dalle pagine senza una propria), handle Twitter, regole extra per robots.txt." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/seo": {
    name: "seo_set",
    description: { en: "Sets site-wide SEO defaults. Omitted fields are left unchanged; pass an empty string to clear a field. robots_extra: one robots.txt directive per line (User-agent/Disallow/Allow/Crawl-delay/Sitemap, or # comments) — invalid lines are silently dropped, never use Disallow here for pages that should just be noindex (a Disallow blocks crawlers from even reading the noindex tag).", it: "Imposta i default SEO a livello di sito. I campi omessi restano invariati; stringa vuota per cancellare un campo. robots_extra: una direttiva robots.txt per riga (User-agent/Disallow/Allow/Crawl-delay/Sitemap, o commenti #) — le righe non valide vengono scartate silenziosamente; non usare Disallow qui per pagine che devono solo essere noindex (un Disallow impedisce ai crawler di leggere anche il tag noindex)." },
    inputSchema: {
      site_id: z.number(),
      defaultOgImage: z.string().optional().describe("Absolute URL or /media/... path"),
      twitterHandle: z.string().optional().describe("e.g. @account"),
      robotsExtra: z.string().optional().describe("Multi-line robots.txt directives"),
    },
  },

  // ── Guide / Ingest ─────────────────────────────────────────────────────
  "GET /api/agent/guide": {
    name: "guide",
    description: { en: "Returns AGENT.md in full (rules, recipes, endpoint table) — useful if context has been compacted.", it: "Restituisce AGENT.md per intero (regole, ricette, tabella endpoint) — utile se il contesto è stato compattato." },
    inputSchema: {},
  },
  "POST /api/agent/ingest": {
    name: "ingest_url",
    description: { en: "Extracts text/title/media from an external URL (to import content from other sites).", it: "Estrae testo/titolo/media da una URL esterna (per importare contenuti da altri siti)." },
    inputSchema: { url: z.string().url(), site_id: z.number().optional() },
  },

  // ── Templates ──────────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/templates": {
    name: "templates_list",
    description: { en: "Lists a site's reusable page templates.", it: "Elenca i template di pagina riutilizzabili di un sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/templates": {
    name: "templates_create",
    description: { en: "Creates a template with placeholders (automatically extracted from the content).", it: "Crea un template con placeholder (estratti automaticamente dal contenuto)." },
    inputSchema: { site_id: z.number(), name: z.string(), description: z.string().optional(), content: z.string() },
  },
  "GET /api/agent/sites/:siteId/templates/:templateId": {
    name: "templates_get",
    description: { en: "Reads a template in full (content and placeholders).", it: "Legge un template per intero (contenuto e placeholder)." },
    inputSchema: { site_id: z.number(), template_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/templates/:templateId/instantiate": {
    name: "templates_instantiate",
    description: { en: "Creates a new page from a template, replacing placeholders with the given values.", it: "Crea una nuova pagina a partire da un template, sostituendo i placeholder con i valori forniti." },
    inputSchema: {
      site_id: z.number(), template_id: z.number(), url_path: z.string(), title: z.string().optional(),
      published: z.boolean().optional(), values: z.record(z.string()).optional().describe("placeholder -> value"),
    },
  },

  // ── Atomic sections ────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/pages/:pageId/sections": {
    name: "pages_sections_list",
    description: { en: "Lists the named sections inside a page's content (for targeted atomic edits).", it: "Elenca le sezioni nominate dentro il contenuto di una pagina (per modifiche atomiche mirate)." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "PATCH /api/agent/sites/:siteId/pages/:pageId/sections/:sectionName": {
    name: "pages_section_update",
    description: { en: "Replaces the content of a single named section of a page (saves a version first).", it: "Sostituisce il contenuto di una singola sezione nominata di una pagina (salva versione prima)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), section_name: z.string(), content: z.string() },
  },

  // ── Site variables ─────────────────────────────────────────────────────
  "PUT /api/agent/sites/:siteId/variables/bulk": {
    name: "variables_bulk_set",
    description: { en: "Updates multiple site variables in 1 call (key -> value object).", it: "Aggiorna più variabili di sito in 1 chiamata (oggetto chiave -> valore)." },
    inputSchema: { site_id: z.number(), variables: z.record(z.string()) },
  },
  "GET /api/agent/sites/:siteId/variables": {
    name: "variables_list",
    description: { en: "Lists site variables (used in pages as {{var:key}}).", it: "Elenca le variabili di sito (usate nelle pagine come {{var:chiave}})." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/variables/:key": {
    name: "variables_set",
    description: { en: "Creates/updates a single site variable. Conventional keys with special handling: brand_name/contact_email/legal_line (footer), ai_disclosure_text (AI Act Art. 50 disclosure shown in footer if set — only enable for a real case of unreviewed AI-published content on matters of public interest, ask the user first).", it: "Crea/aggiorna una singola variabile di sito. Chiavi convenzionali con trattamento speciale: brand_name/contact_email/legal_line (footer), ai_disclosure_text (dicitura AI Act art. 50 mostrata in footer se valorizzata — attivala solo per un caso reale di contenuto IA pubblicato senza revisione su temi di interesse pubblico, chiedi prima all'utente)." },
    inputSchema: { site_id: z.number(), key: z.string().regex(/^[a-zA-Z0-9_-]+$/), value: z.string(), description: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/variables/:key": {
    name: "variables_delete",
    description: { en: "Deletes a site variable.", it: "Elimina una variabile di sito." },
    inputSchema: { site_id: z.number(), key: z.string() },
  },

  // ── Sitemap / Redirects ────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/sitemap": {
    name: "sitemap_overview",
    description: { en: "Overview of a site's pages by status (published/drafts/scheduled) and active redirects.", it: "Vista d'insieme delle pagine del sito per stato (pubblicate/bozze/programmate) e redirect attivi." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/redirects": {
    name: "redirects_list",
    description: { en: "Lists redirects configured for a site.", it: "Elenca i redirect configurati per un sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/redirects": {
    name: "redirects_create",
    description: { en: "Creates/updates a redirect (code 301/302/307/308).", it: "Crea/aggiorna un redirect (codice 301/302/307/308)." },
    inputSchema: { site_id: z.number(), from_path: z.string(), to_path: z.string(), code: z.number().optional().describe("301|302|307|308, default 301") },
  },
  "DELETE /api/agent/sites/:siteId/redirects/:redirectId": {
    name: "redirects_delete",
    description: { en: "Deletes a redirect.", it: "Elimina un redirect." },
    inputSchema: { site_id: z.number(), redirect_id: z.number() },
  },

  // ── Public forms ───────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/forms": {
    name: "forms_list",
    description: { en: "Lists forms with at least one submission received, with counts.", it: "Elenca i form con almeno un invio ricevuto, con conteggi." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/forms/:formSlug/submissions": {
    name: "forms_submissions",
    description: { en: "Submissions received by a specific form, paginated.", it: "Invii ricevuti da un form specifico, paginati." },
    inputSchema: { site_id: z.number(), form_slug: z.string(), limit: z.number().optional(), offset: z.number().optional(), since: z.string().optional().describe("ISO datetime") },
  },
  "GET /api/agent/sites/:siteId/forms/search": {
    name: "forms_search",
    description: { en: "Free-text search across submissions of all forms on the site (matches any field value).", it: "Ricerca libera negli invii di tutti i form del sito (su qualsiasi valore di campo)." },
    inputSchema: { site_id: z.number(), q: z.string().describe("min 2 characters"), limit: z.number().optional() },
  },

  // ── Questionari (quiz con punteggi) ─────────────────────────────────────
  "GET /api/agent/sites/:siteId/quizzes": {
    name: "quizzes_list",
    description: { en: "Lists the site's scored quizzes (lead qualification, assessments, tests) with their questions/thresholds and submission count. Embed in pages with {{quiz:slug}}.", it: "Elenca i questionari con punteggi del sito (qualifica lead, assessment, test) con domande/soglie e conteggio risultati. Si integrano nelle pagine con {{quiz:slug}}." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/quizzes": {
    name: "quizzes_create",
    description: { en: "Creates a scored quiz. questions: [{key?, label, options:[{label, points}]}], thresholds: [{min, max?, title, message?, class?('ok'|'warn'|'cold')}]. The score is recomputed server-side on every submission. ask_email:true adds an optional email field (lead goes to CRM contacts with contact_tag). Embed with {{quiz:slug}}.", it: "Crea un questionario con punteggi. questions: [{key?, label, options:[{label, points}]}], thresholds: [{min, max?, title, message?, class?('ok'|'warn'|'cold')}]. Il punteggio viene ricalcolato server-side a ogni submit. ask_email:true aggiunge un campo email opzionale (il lead entra nei contatti CRM con contact_tag). Si integra con {{quiz:slug}}." },
    inputSchema: {
      site_id: z.number(),
      name: z.string().describe("Display name, e.g. 'Qualifica lead'"),
      slug: z.string().optional().describe("URL slug; if omitted, derived from name"),
      intro: z.string().optional(),
      questions: z.array(z.object({
        key: z.string().optional(), label: z.string(),
        options: z.array(z.object({ label: z.string(), points: z.number() })),
      })).describe("Quiz questions with point-scored options"),
      thresholds: z.array(z.object({
        min: z.number(), max: z.number().nullable().optional().describe("null/omitted = up to infinity"),
        title: z.string(), message: z.string().optional(), class: z.enum(["ok", "warn", "cold"]).optional(),
      })).describe("Score thresholds -> verdict (sorted by min)"),
      submit_label: z.string().optional(), success_message: z.string().optional(),
      ask_email: z.boolean().optional(), contact_tag: z.string().optional().describe("CRM tag assigned to contacts who complete the quiz with email"),
      redirect_url: z.string().optional().describe("Thank-you page/redirect after submit, e.g. /grazie"),
      enabled: z.boolean().optional(),
    },
  },
  "PUT /api/agent/sites/:siteId/quizzes/:quizId": {
    name: "quizzes_update",
    description: { en: "Updates a scored quiz (questions, thresholds, texts, ask_email, contact_tag, enabled). Omitted fields are left unchanged; slug empty/invalid keeps the current one. Existing submissions stay linked to the slug.", it: "Aggiorna un questionario con punteggi (domande, soglie, testi, ask_email, contact_tag, enabled). I campi omessi restano invariati; slug vuoto/non valido mantiene quello attuale. I risultati esistenti restano collegati allo slug." },
    inputSchema: {
      site_id: z.number(), quiz_id: z.number(),
      name: z.string().optional(), slug: z.string().optional(), intro: z.string().optional(),
      questions: z.array(z.object({
        key: z.string().optional(), label: z.string(),
        options: z.array(z.object({ label: z.string(), points: z.number() })),
      })).optional(),
      thresholds: z.array(z.object({
        min: z.number(), max: z.number().nullable().optional(), title: z.string(),
        message: z.string().optional(), class: z.enum(["ok", "warn", "cold"]).optional(),
      })).optional(),
      submit_label: z.string().optional(), success_message: z.string().optional(),
      ask_email: z.boolean().optional(), contact_tag: z.string().nullable().optional(),
      redirect_url: z.string().nullable().optional(), enabled: z.boolean().optional(),
    },
  },
  "DELETE /api/agent/sites/:siteId/quizzes/:quizId": {
    name: "quizzes_delete",
    description: { en: "Deletes a quiz definition. Existing submissions are kept (not cascade-deleted).", it: "Elimina la definizione di un questionario. I risultati esistenti restano salvati (niente cascade delete)." },
    inputSchema: { site_id: z.number(), quiz_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/quizzes/:quizSlug/submissions": {
    name: "quizzes_submissions",
    description: { en: "Scored quiz submissions: answers chosen, recomputed total points and verdict title. Paginated, optional since filter.", it: "Risultati dei questionari: risposte scelte, punteggio totale ricalcolato e titolo del verdetto. Paginati, filtro since opzionale." },
    inputSchema: { site_id: z.number(), quiz_slug: z.string(), limit: z.number().optional(), offset: z.number().optional(), since: z.string().optional().describe("ISO datetime") },
  },

  // ── Segmenti dinamici (F1) ─────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/segments": {
    name: "segments_list",
    description: { en: "Lists the site's dynamic segments (saved contact queries) with member counts.", it: "Elenca i segmenti dinamici del sito (query sui contatti salvate) con conteggio membri." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/segments": {
    name: "segments_create",
    description: { en: "Creates a dynamic segment. rules: [{field,op,value,days?}] — fields: tag/status/score/value_estimate/email/notes/utm_source/utm_medium/utm_campaign/first_source/pref_*, or event (op gte_days_ago/lt_days_ago/exists, value=event_type, days=N). match_mode 'all'|'any'. Members are recomputed on every contact event.", it: "Crea un segmento dinamico. rules: [{field,op,value,days?}] — campi: tag/status/score/value_estimate/email/notes/utm_source/utm_medium/utm_campaign/first_source/pref_*, oppure event (op gte_days_ago/lt_days_ago/exists, value=tipo evento, days=N). match_mode 'all'|'any'. La membership è ricalcolata a ogni evento del contatto." },
    inputSchema: {
      site_id: z.number(), name: z.string(), description: z.string().optional(),
      rules: z.array(z.object({
        field: z.string(), op: z.string(), value: z.string().optional(),
        days: z.number().optional(),
      })),
      match_mode: z.enum(["all", "any"]).optional(),
    },
  },
  "PUT /api/agent/sites/:siteId/segments/:segmentId": {
    name: "segments_update",
    description: { en: "Updates a segment (name/rules/match_mode/enabled). Omitted fields unchanged.", it: "Aggiorna un segmento (nome/regole/match_mode/attivo). Campi omessi invariati." },
    inputSchema: { site_id: z.number(), segment_id: z.number(), name: z.string().optional(), description: z.string().optional(), rules: z.array(z.any()).optional(), match_mode: z.enum(["all", "any"]).optional(), enabled: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/segments/:segmentId": {
    name: "segments_delete",
    description: { en: "Deletes a segment (membership is cascade-deleted).", it: "Elimina un segmento (la membership viene eliminata a cascata)." },
    inputSchema: { site_id: z.number(), segment_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/segments/:segmentId/members": {
    name: "segments_members",
    description: { en: "Emails currently in a segment, with tags/status/score.", it: "Email attualmente in un segmento, con tag/stato/punteggio." },
    inputSchema: { site_id: z.number(), segment_id: z.number(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/segments/:segmentId/recount": {
    name: "segments_recount",
    description: { en: "Recomputes the full membership of a segment from all known contacts (manual refresh).", it: "Ricalcola la membership completa di un segmento da tutti i contatti noti (refresh manuale)." },
    inputSchema: { site_id: z.number(), segment_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/segments/preview": {
    name: "segments_preview",
    description: { en: "Dry-run: how many known contacts match the given rules, without saving a segment. rules as JSON string in query param.", it: "Dry-run: quanti contatti noti matchano le regole date, senza salvare un segmento. rules come stringa JSON nel query param." },
    inputSchema: { site_id: z.number(), rules: z.string(), match_mode: z.enum(["all", "any"]).optional() },
  },

  // ── Workflow a trigger (F2) ────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/workflows": {
    name: "workflows_list",
    description: { en: "Lists the site's trigger workflows (automations) with action counts.", it: "Elenca i workflow a trigger del sito (automazioni) con conteggio azioni." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/workflows": {
    name: "workflows_create",
    description: { en: "Creates an automation workflow. trigger_type: form_submitted|quiz_completed|email_opened|email_clicked|call_booked|call_status_changed|stage_changed|tag_added|contact_created|score_threshold|segment_entered|manual. trigger_config filters (form_slug/quiz_slug/to_stage/tag/min_score/segment_id). actions: [{action_type: add_tag|remove_tag|set_stage|send_campaign|send_sequence|create_task|notify_email|wait_days, action_config}] executed in order.", it: "Crea un workflow di automazione. trigger_type: form_submitted|quiz_completed|email_opened|email_clicked|call_booked|call_status_changed|stage_changed|tag_added|contact_created|score_threshold|segment_entered|manual. trigger_config filtra (form_slug/quiz_slug/to_stage/tag/min_score/segment_id). actions: [{action_type: add_tag|remove_tag|set_stage|send_campaign|send_sequence|create_task|notify_email|wait_days, action_config}] eseguite in ordine." },
    inputSchema: {
      site_id: z.number(), name: z.string(),
      trigger_type: z.string(), trigger_config: z.record(z.any()).optional(),
      active: z.boolean().optional(),
      actions: z.array(z.object({
        action_type: z.string(), action_config: z.record(z.any()).optional(),
      })),
    },
  },
  "PUT /api/agent/sites/:siteId/workflows/:workflowId": {
    name: "workflows_update",
    description: { en: "Updates a workflow (name/active/trigger_config/actions). Omitted fields unchanged; pass actions to replace ALL actions.", it: "Aggiorna un workflow (nome/attivo/trigger_config/azioni). Campi omessi invariati; passa actions per sostituire TUTTE le azioni." },
    inputSchema: { site_id: z.number(), workflow_id: z.number(), name: z.string().optional(), active: z.boolean().optional(), trigger_type: z.string().optional(), trigger_config: z.record(z.any()).optional(), actions: z.array(z.any()).optional() },
  },
  "DELETE /api/agent/sites/:siteId/workflows/:workflowId": {
    name: "workflows_delete",
    description: { en: "Deletes a workflow (actions cascade, run log kept on the workflow id).", it: "Elimina un workflow (azioni a cascata, log esecuzioni collegato all'id)." },
    inputSchema: { site_id: z.number(), workflow_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/workflows/:workflowId/runs": {
    name: "workflows_runs",
    description: { en: "Execution log of a workflow (email, trigger, status, error, date).", it: "Log esecuzioni di un workflow (email, trigger, stato, errore, data)." },
    inputSchema: { site_id: z.number(), workflow_id: z.number(), limit: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/workflows/:workflowId/test": {
    name: "workflows_test",
    description: { en: "Dry-run of a workflow against an email: lists the actions that WOULD run, without executing anything.", it: "Dry-run di un workflow su un'email: elenca le azioni che PARTIREBBERO, senza eseguirle." },
    inputSchema: { site_id: z.number(), workflow_id: z.number(), email: z.string().email() },
  },

  // ── Scoring (F4) ───────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/scoring-rules": {
    name: "scoring_rules_list",
    description: { en: "Lists lead scoring rules (event -> points).", it: "Elenca le regole di lead scoring (evento -> punti)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/scoring-rules": {
    name: "scoring_rules_create",
    description: { en: "Creates a scoring rule: event_type + optional event_filter (form_slug/quiz_slug/min_score/tag/stage/status) -> points. Applied automatically on contact events.", it: "Crea una regola di scoring: event_type + event_filter opzionale (form_slug/quiz_slug/min_score/tag/stage/status) -> punti. Applicata automaticamente sugli eventi contatto." },
    inputSchema: { site_id: z.number(), name: z.string(), event_type: z.string(), event_filter: z.record(z.any()).optional(), points: z.number(), enabled: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/scoring-rules/:ruleId": {
    name: "scoring_rules_update",
    description: { en: "Updates a scoring rule (points/enabled/name/event_filter).", it: "Aggiorna una regola di scoring (punti/attiva/nome/event_filter)." },
    inputSchema: { site_id: z.number(), rule_id: z.number(), name: z.string().optional(), points: z.number().optional(), enabled: z.boolean().optional(), event_filter: z.record(z.any()).optional() },
  },
  "DELETE /api/agent/sites/:siteId/scoring-rules/:ruleId": {
    name: "scoring_rules_delete",
    description: { en: "Deletes a scoring rule.", it: "Elimina una regola di scoring." },
    inputSchema: { site_id: z.number(), rule_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/scoring-thresholds": {
    name: "scoring_thresholds_list",
    description: { en: "Lists scoring thresholds (min_score -> action).", it: "Elenca le soglie di scoring (min_score -> azione)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/scoring-thresholds": {
    name: "scoring_thresholds_create",
    description: { en: "Creates a scoring threshold: when a contact's score reaches min_score, run the action (set_stage/add_tag/notify_email).", it: "Crea una soglia di scoring: quando il punteggio di un contatto raggiunge min_score, esegue l'azione (set_stage/add_tag/notify_email)." },
    inputSchema: { site_id: z.number(), min_score: z.number(), action_type: z.enum(["set_stage", "add_tag", "notify_email"]).optional(), action_config: z.record(z.any()).optional(), enabled: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/scoring-thresholds/:thresholdId": {
    name: "scoring_thresholds_delete",
    description: { en: "Deletes a scoring threshold.", it: "Elimina una soglia di scoring." },
    inputSchema: { site_id: z.number(), threshold_id: z.number() },
  },

  // ── Task + Funnel (F5) ─────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/tasks": {
    name: "tasks_list",
    description: { en: "Lists sales tasks (filters: assignee_id, status open/done/cancelled, email).", it: "Elenca le task vendite (filtri: assignee_id, status open/done/cancelled, email)." },
    inputSchema: { site_id: z.number(), assignee_id: z.number().optional(), status: z.string().optional(), email: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/tasks": {
    name: "tasks_create",
    description: { en: "Creates a sales task (title required; optional email contact, assignee_id, due_at ISO, notes).", it: "Crea una task vendite (titolo obbligatorio; opzionali email contatto, assignee_id, due_at ISO, note)." },
    inputSchema: { site_id: z.number(), title: z.string(), email: z.string().optional(), assignee_id: z.number().optional(), due_at: z.string().optional(), notes: z.string().optional() },
  },
  "PUT /api/agent/sites/:siteId/tasks/:taskId": {
    name: "tasks_update",
    description: { en: "Updates a task (status done sets done_at). Omitted fields unchanged.", it: "Aggiorna una task (status done imposta done_at). Campi omessi invariati." },
    inputSchema: { site_id: z.number(), task_id: z.number(), title: z.string().optional(), email: z.string().optional(), assignee_id: z.number().nullable().optional(), due_at: z.string().nullable().optional(), notes: z.string().optional(), status: z.enum(["open", "done", "cancelled"]).optional() },
  },
  "DELETE /api/agent/sites/:siteId/tasks/:taskId": {
    name: "tasks_delete",
    description: { en: "Deletes a task.", it: "Elimina una task." },
    inputSchema: { site_id: z.number(), task_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/funnel": {
    name: "funnel_overview",
    description: { en: "Conversion funnel snapshots per channel/day (visits, leads, calls, wins, revenue). Optional from/to dates (YYYY-MM-DD).", it: "Snapshot funnel di conversione per canale/giorno (visite, lead, chiamate, vinti, revenue). Filtri opzionali from/to (AAAA-MM-GG)." },
    inputSchema: { site_id: z.number(), from: z.string().optional(), to: z.string().optional() },
  },

  // ── Email stats (F3) ───────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/email-stats/:campaignId": {
    name: "email_stats_campaign",
    description: { en: "Open/click stats for a broadcast campaign (rates, top clicked URLs).", it: "Statistiche open/click di una campagna broadcast (tassi, URL più cliccati)." },
    inputSchema: { site_id: z.number(), campaign_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/email-stats/sequence/:sequenceId": {
    name: "email_stats_sequence",
    description: { en: "Open/click stats for an evergreen sequence (per step).", it: "Statistiche open/click di una sequenza evergreen (per step)." },
    inputSchema: { site_id: z.number(), sequence_id: z.number() },
  },

  // ── Preferenze contatto (F7) ───────────────────────────────────────────
  "POST /api/agent/sites/:siteId/contacts/:email/pref-token": {
    name: "contact_pref_token",
    description: { en: "Generates (or reuses) the public preferences token for a contact — use to build the {{pref_url}} link in emails.", it: "Genera (o riusa) il token pubblico delle preferenze per un contatto — usalo per costruire il link {{pref_url}} nelle email." },
    inputSchema: { site_id: z.number(), email: z.string() },
  },

  // ── Merge (F8) ─────────────────────────────────────────────────────────
  "POST /api/agent/sites/:siteId/contacts/:email/merge": {
    name: "contact_merge",
    description: { en: "Merges a contact into another (into_email): union of tags, max score/value, most advanced stage, first UTM; submissions/calls/tasks/events re-linked; source deleted. Transactional.", it: "Unisce un contatto in un altro (into_email): unione tag, score/valore massimo, stadio più avanzato, primo UTM; invii/chiamate/task/eventi riagganciati; sorgente eliminato. Transazionale." },
    inputSchema: { site_id: z.number(), email: z.string(), into_email: z.string() },
  },

  // ── Pipeline multiple (F9) ─────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/pipelines": {
    name: "pipelines_list",
    description: { en: "Lists the site's sales pipelines (multiple boards with custom stages).", it: "Elenca le pipeline vendite del sito (più board con stadi custom)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/pipelines": {
    name: "pipelines_create",
    description: { en: "Creates a sales pipeline with custom stages: [{key?, label}]. is_default:true marks the fallback for contacts without a pipeline.", it: "Crea una pipeline vendite con stadi custom: [{key?, label}]. is_default:true la marca come fallback per i contatti senza pipeline." },
    inputSchema: { site_id: z.number(), name: z.string(), stages: z.array(z.object({ key: z.string().optional(), label: z.string() })).optional(), is_default: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/pipelines/:pipelineId": {
    name: "pipelines_update",
    description: { en: "Updates a pipeline (name/stages/is_default). Omitted fields unchanged.", it: "Aggiorna una pipeline (nome/stadi/is_default). Campi omessi invariati." },
    inputSchema: { site_id: z.number(), pipeline_id: z.number(), name: z.string().optional(), stages: z.array(z.any()).optional(), is_default: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/pipelines/:pipelineId": {
    name: "pipelines_delete",
    description: { en: "Deletes a pipeline. Contacts linked to it fall back to the site's default pipeline.", it: "Elimina una pipeline. I contatti collegati tornano alla pipeline default del sito." },
    inputSchema: { site_id: z.number(), pipeline_id: z.number() },
  },

  // ── Contact extras (score/utm/preferences/events) ──────────────────────
  "GET /api/agent/sites/:siteId/contacts/:email/extras": {
    name: "contact_extras_get",
    description: { en: "Full CRM record for a contact: score, UTM source, preferences, recent events (timeline).", it: "Record CRM completo di un contatto: punteggio, sorgente UTM, preferenze, eventi recenti (timeline)." },
    inputSchema: { site_id: z.number(), email: z.string(), limit: z.number().optional() },
  },
  "PUT /api/agent/sites/:siteId/contacts/:email/extras": {
    name: "contact_extras_set",
    description: { en: "Updates a contact's score (score or add_score), preferences (prefs object) and/or UTM (only fills empty fields).", it: "Aggiorna punteggio (score o add_score), preferenze (oggetto prefs) e/o UTM (riempie solo campi vuoti) di un contatto." },
    inputSchema: { site_id: z.number(), email: z.string(), score: z.number().optional(), add_score: z.number().optional(), prefs: z.record(z.boolean()).optional(), utm: z.record(z.string()).optional() },
  },

  // ── Note lead (timeline) ────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/contacts/:email/notes": {
    name: "contact_notes_list",
    description: { en: "Timeline of notes on a contact (each with author type/name and date). The single 'notes' field still exists for compat; this is the proper CRM note history.", it: "Timeline delle note su un contatto (ognuna con autore/tipo e data). Il campo singolo 'notes' esiste ancora per compatibilità; questa è la vera storia note del CRM." },
    inputSchema: { site_id: z.number(), email: z.string() },
  },
  "POST /api/agent/sites/:siteId/contacts/:email/notes": {
    name: "contact_note_add",
    description: { en: "Adds a note to a contact's timeline (author_type: human|agent|system; author_name optional, e.g. the AI agent name). Use after any meaningful interaction to keep the lead history readable by humans.", it: "Aggiunge una nota alla timeline di un contatto (author_type: human|agent|system; author_name opzionale, es. il nome dell'agente AI). Usala dopo ogni interazione significativa per tenere la storia del lead leggibile dagli umani." },
    inputSchema: { site_id: z.number(), email: z.string(), body: z.string().describe("Note text"), author_type: z.enum(["human", "agent", "system"]).optional(), author_name: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/contacts/:email/notes/:noteId": {
    name: "contact_note_delete",
    description: { en: "Deletes a note from the contact timeline.", it: "Elimina una nota dalla timeline del contatto." },
    inputSchema: { site_id: z.number(), email: z.string(), note_id: z.number() },
  },

  // ── Conversazioni (email/WhatsApp) ─────────────────────────────────────
  "GET /api/agent/sites/:siteId/conversations": {
    name: "conversations_list",
    description: { en: "Lists conversation threads (email/whatsapp) with last message and message count. Filters: email, channel (email|whatsapp), status (open|pending|closed).", it: "Elenca i thread di conversazione (email/whatsapp) con ultimo messaggio e conteggio. Filtri: email, channel (email|whatsapp), status (open|pending|closed)." },
    inputSchema: { site_id: z.number(), email: z.string().optional(), channel: z.enum(["email", "whatsapp"]).optional(), status: z.enum(["open", "pending", "closed"]).optional() },
  },
  "GET /api/agent/sites/:siteId/conversations/:conversationId/messages": {
    name: "conversation_messages",
    description: { en: "Full message history of a conversation thread, oldest first, with direction (in/out).", it: "Storia completa dei messaggi di un thread, dal più vecchio, con direzione (in/out)." },
    inputSchema: { site_id: z.number(), conversation_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/contacts/:email/conversations/:channel/messages": {
    name: "conversation_message_send",
    description: { en: "Records a message in the contact's conversation thread (channel: email|whatsapp). direction 'out' = sent by us, 'in' = received from the lead. WhatsApp is not sent by the CMS (the bot does that) — this keeps the history in one place. Creates the thread if missing. meta: free JSON (e.g. campaign_id, message_id).", it: "Registra un messaggio nel thread di conversazione del contatto (channel: email|whatsapp). direction 'out' = inviato da noi, 'in' = ricevuto dal lead. WhatsApp NON viene inviato dal CMS (lo fa il bot) — qui si registra la storia in un unico posto. Crea il thread se manca. meta: JSON libero (es. campaign_id, message_id)." },
    inputSchema: { site_id: z.number(), email: z.string(), channel: z.enum(["email", "whatsapp"]), direction: z.enum(["in", "out"]).optional().describe("default out"), subject: z.string().optional(), body: z.string().describe("Message text"), meta: z.record(z.any()).optional() },
  },
  "PATCH /api/agent/sites/:siteId/conversations/:conversationId": {
    name: "conversation_update",
    description: { en: "Updates a conversation thread: status (open|pending|closed) or subject. Setting status closed stops it from appearing in the open list.", it: "Aggiorna un thread di conversazione: status (open|pending|closed) o subject. Chiudere (closed) lo toglie dalla lista aperte." },
    inputSchema: { site_id: z.number(), conversation_id: z.number(), status: z.enum(["open", "pending", "closed"]).optional(), subject: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/conversations/:conversationId": {
    name: "conversation_delete",
    description: { en: "Deletes a conversation thread and all its messages.", it: "Elimina un thread di conversazione e tutti i suoi messaggi." },
    inputSchema: { site_id: z.number(), conversation_id: z.number() },
  },

  // ── Opportunità/affari (26) ────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/opportunities": {
    name: "opportunities_list",
    description: { en: "Lists deals/opportunities (amount, probability, stage, status open/won/lost). Filters: status, stage, email.", it: "Elenca gli affari/opportunità (importo, probabilità, stadio, stato open/won/lost). Filtri: status, stage, email." },
    inputSchema: { site_id: z.number(), status: z.enum(["open", "won", "lost"]).optional(), stage: z.string().optional(), email: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/opportunities": {
    name: "opportunities_create",
    description: { en: "Creates a deal/opportunity for a contact (title + email required). stage is a pipeline stage key, probability 0-100.", it: "Crea un affare/opportunità per un contatto (titolo + email obbligatori). stage è una chiave di stadio della pipeline, probability 0-100." },
    inputSchema: { site_id: z.number(), email: z.string(), title: z.string(), pipeline_id: z.number().nullable().optional(), stage: z.string().optional(), amount: z.number().optional(), probability: z.number().optional(), expected_close_at: z.string().nullable().optional(), notes: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/opportunities/:opportunityId": {
    name: "opportunities_get",
    description: { en: "Deal detail with its quotes.", it: "Dettaglio affare con i suoi preventivi." },
    inputSchema: { site_id: z.number(), opportunity_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/opportunities/:opportunityId": {
    name: "opportunities_update",
    description: { en: "Updates a deal: title/stage/status(open|won|lost)/amount/probability/pipeline_id/expected_close_at/notes. Stage changes fire opportunity_stage_changed, status changes fire opportunity_status_changed.", it: "Aggiorna un affare: title/stage/status(open|won|lost)/amount/probability/pipeline_id/expected_close_at/notes. Il cambio stadio genera opportunity_stage_changed, il cambio stato opportunity_status_changed." },
    inputSchema: { site_id: z.number(), opportunity_id: z.number(), title: z.string().optional(), stage: z.string().optional(), status: z.enum(["open", "won", "lost"]).optional(), amount: z.number().optional(), probability: z.number().optional(), pipeline_id: z.number().nullable().optional(), expected_close_at: z.string().nullable().optional(), notes: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/opportunities/:opportunityId": {
    name: "opportunities_delete",
    description: { en: "Deletes a deal. Its quotes remain but lose the opportunity link.", it: "Elimina un affare. I suoi preventivi restano ma perdono il collegamento." },
    inputSchema: { site_id: z.number(), opportunity_id: z.number() },
  },

  // ── Preventivi (26) ────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/quotes": {
    name: "quotes_list",
    description: { en: "Lists quotes with totals and status (draft/sent/viewed/signed). Filters: status, email, opportunity_id.", it: "Elenca i preventivi con totali e stato (draft/sent/viewed/signed). Filtri: status, email, opportunity_id." },
    inputSchema: { site_id: z.number(), status: z.enum(["draft", "sent", "viewed", "signed"]).optional(), email: z.string().optional(), opportunity_id: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/quotes": {
    name: "quotes_create",
    description: { en: "Creates a quote. items: [{description, qty, price}]. Returns the quote with token — build the client link as /quote/:token and send it by email/WhatsApp.", it: "Crea un preventivo. items: [{description, qty, price}]. Ritorna il preventivo col token — il link cliente è /quote/:token, invialo via email/WhatsApp." },
    inputSchema: { site_id: z.number(), email: z.string(), opportunity_id: z.number().optional(), title: z.string().optional(), items: z.array(z.object({ description: z.string(), qty: z.number().optional(), price: z.number().optional() })).optional(), notes: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/quotes/:quoteId": {
    name: "quotes_get",
    description: { en: "Quote detail with total and public_url (/quote/:token).", it: "Dettaglio preventivo con totale e public_url (/quote/:token)." },
    inputSchema: { site_id: z.number(), quote_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/quotes/:quoteId": {
    name: "quotes_update",
    description: { en: "Updates a quote (title/items/notes/status).", it: "Aggiorna un preventivo (title/items/notes/status)." },
    inputSchema: { site_id: z.number(), quote_id: z.number(), title: z.string().optional(), items: z.array(z.any()).optional(), notes: z.string().optional(), status: z.enum(["draft", "sent", "viewed", "signed"]).optional() },
  },
  "POST /api/agent/sites/:siteId/quotes/:quoteId/status": {
    name: "quotes_set_status",
    description: { en: "Sets quote status: sent (client notified, link usable), viewed (client opened), signed (accepted). Each transition fires the matching event (quote_sent/quote_viewed/quote_signed).", it: "Imposta lo stato del preventivo: sent (inviato al cliente, link attivo), viewed (cliente ha aperto), signed (accettato). Ogni transizione genera l'evento corrispondente (quote_sent/quote_viewed/quote_signed)." },
    inputSchema: { site_id: z.number(), quote_id: z.number(), status: z.enum(["sent", "viewed", "signed"]) },
  },
  "DELETE /api/agent/sites/:siteId/quotes/:quoteId": {
    name: "quotes_delete",
    description: { en: "Deletes a quote.", it: "Elimina un preventivo." },
    inputSchema: { site_id: z.number(), quote_id: z.number() },
  },

  // ── Contatti (CRM-lite, derivato dagli invii form) ─────────────────────
  "GET /api/agent/sites/:siteId/contacts": {
    name: "contacts_list",
    description: { en: "Contacts derived from form submissions, grouped by email (from an 'email'-type field, or a name heuristic for hand-written forms). Shows who filled more than one form. Optionally filter by tag.", it: "Contatti dedotti dagli invii dei form, raggruppati per email (da un campo di tipo 'email', o euristica sul nome per i form scritti a mano). Mostra chi ha compilato più di un form. Filtrabile per tag." },
    inputSchema: { site_id: z.number(), tag: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/contacts/tags": {
    name: "contacts_tags_list",
    description: { en: "Distinct tags currently assigned to any contact on the site — use to pick a valid target_tag for campaigns/sequences.", it: "Tag distinti attualmente assegnati a un contatto del sito — usalo per scegliere un target_tag valido per campagne/sequenze." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/contacts/:email": {
    name: "contact_timeline",
    description: { en: "All submissions from a specific contact (by email), across all forms, most recent first, plus its tags/status/notes.", it: "Tutti gli invii di un contatto specifico (per email), su tutti i form, dal più recente, più i suoi tag/stato/note." },
    inputSchema: { site_id: z.number(), email: z.string() },
  },
  "PUT /api/agent/sites/:siteId/contacts/:email": {
    name: "contact_update",
    description: { en: "Sets tags/status/notes/estimated deal value for a contact (creates it if it doesn't exist yet). Omitted fields are left unchanged. If the sales_pipeline module is active, status should be one of the fixed stage keys (see pipeline_board).", it: "Imposta tag/stato/note/valore stimato affare di un contatto (lo crea se non esiste ancora). I campi omessi restano invariati. Se il modulo sales_pipeline è attivo, status dovrebbe essere una delle chiavi di stadio fisse (vedi pipeline_board)." },
    inputSchema: { site_id: z.number(), email: z.string(), tags: z.array(z.string()).optional(), status: z.string().optional(), notes: z.string().optional(), value_estimate: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/contacts/:email/export": {
    name: "contact_export",
    description: { en: "GDPR data access/portability: full JSON export of everything known about this email (form submissions, calls, newsletter subscription, tags/status/notes). Use to answer a data access request.", it: "Diritto GDPR di accesso/portabilità: export JSON completo di tutto ciò che si sa su questa email (invii form, chiamate, iscrizione newsletter, tag/stato/note). Usalo per rispondere a una richiesta di accesso ai dati." },
    inputSchema: { site_id: z.number(), email: z.string() },
  },
  "DELETE /api/agent/sites/:siteId/contacts/:email": {
    name: "contact_erase",
    description: { en: "GDPR right to erasure: PERMANENTLY deletes everything linked to this email across all tables (form submissions, contacts row, calls, newsletter subscription). Not reversible — confirm with the user before calling, this isn't a decision to make unprompted.", it: "Diritto GDPR alla cancellazione: elimina IN MODO PERMANENTE tutto ciò che è collegato a questa email in tutte le tabelle (invii form, riga contatto, chiamate, iscrizione newsletter). Non reversibile — conferma con l'utente prima di chiamarlo, non è una decisione da prendere di propria iniziativa." },
    inputSchema: { site_id: z.number(), email: z.string() },
  },

  // ── Changelog / Deploy ─────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/changelog": {
    name: "changelog",
    description: { en: "Human-readable changelog (natural-language messages) of recent changes to the site.", it: "Changelog leggibile (messaggi in linguaggio naturale) delle modifiche recenti al sito." },
    inputSchema: { site_id: z.number(), limit: z.number().optional(), since: z.string().optional().describe("ISO datetime") },
  },
  "POST /api/agent/sites/:siteId/deploy": {
    name: "deploy",
    description: { en: "Invalidates the Cloudflare cache and notifies configured webhooks. Use after important changes.", it: "Invalida la cache Cloudflare e notifica i webhook configurati. Usa dopo modifiche importanti." },
    inputSchema: { site_id: z.number(), pages: z.array(z.string()).optional(), note: z.string().optional() },
  },

  // ── Bulk import / Rewrite ──────────────────────────────────────────────
  "POST /api/agent/sites/bulk-import": {
    name: "pages_bulk_import",
    description: { en: "Imports up to 50 external URLs as new draft pages (extracts text/title automatically).", it: "Importa fino a 50 URL esterne come nuove pagine bozza (estrae testo/titolo automaticamente)." },
    inputSchema: { site_id: z.number(), urls: z.array(z.string().url()).min(1).max(50), prefix_path: z.string().optional().describe("Default '/imported/'") },
  },
  "POST /api/agent/rewrite": {
    name: "text_rewrite",
    description: { en: "Rewrites a text via LLM (actions: shorter, longer, professional, simple, friendly).", it: "Riscrive un testo via LLM (azioni: shorter, longer, professional, simple, friendly)." },
    inputSchema: { text: z.string().min(1).max(100000), action: z.enum(["shorter", "longer", "professional", "simple", "friendly"]) },
  },

  // ── Social posts ───────────────────────────────────────────────────────
  "POST /api/agent/sites/:siteId/social-posts": {
    name: "social_posts_create",
    description: { en: "Schedules a social post linked to a page (note: actual publishing isn't implemented, see AGENT.md).", it: "Pianifica un post social collegato a una pagina (nota: pubblicazione reale non implementata, vedi AGENT.md)." },
    inputSchema: { site_id: z.number(), page_id: z.number(), platform: z.enum(["twitter", "linkedin", "facebook"]), message: z.string().max(2800), scheduled_at: z.string().describe("ISO datetime") },
  },
  "GET /api/agent/sites/:siteId/social-posts": {
    name: "social_posts_list",
    description: { en: "Lists social posts scheduled for a site.", it: "Elenca i post social pianificati per un sito." },
    inputSchema: { site_id: z.number() },
  },

  // ── Internal links / rendered diff ─────────────────────────────────────
  "GET /api/agent/sites/:siteId/pages/:pageId/internal-links": {
    name: "pages_internal_link_suggestions",
    description: { en: "Suggests relevant internal links to add to a page's content.", it: "Suggerisce link interni pertinenti da aggiungere al contenuto di una pagina." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/rendered-diff/:versionId": {
    name: "pages_rendered_diff",
    description: { en: "Line-by-line diff between the current content and a previous version.", it: "Diff riga per riga tra il contenuto corrente e una versione precedente." },
    inputSchema: { site_id: z.number(), page_id: z.number(), version_id: z.number() },
  },

  // ── Stats views ────────────────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/stats/views": {
    name: "stats_views_by_page",
    description: { en: "Views per page over the given period (default 30 days), with unique visitors.", it: "Visite per pagina nel periodo indicato (default 30gg), con visitatori unici." },
    inputSchema: { site_id: z.number(), days: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/stats/views/timeline": {
    name: "stats_views_timeline",
    description: { en: "Daily trend of the site's views over the given period.", it: "Andamento giornaliero delle visite del sito nel periodo indicato." },
    inputSchema: { site_id: z.number(), days: z.number().optional() },
  },

  // ── Backup / Static export ─────────────────────────────────────────────
  "POST /api/agent/sites/:siteId/backup": {
    name: "site_backup",
    description: { en: "Generates a full ZIP backup of the site (pages, snippets, settings, media) — binary response, not JSON.", it: "Genera un backup ZIP completo del sito (pagine, snippet, impostazioni, media) — risposta binaria, non JSON." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/export-static": {
    name: "export_static",
    description: { en: "Forces the static export of a site's published pages (normally automatic after every change).", it: "Forza l'export statico delle pagine pubblicate di un sito (normalmente automatico dopo ogni modifica)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/export-static-all": {
    name: "export_static_all",
    description: { en: "Forces the static export of ALL sites (superadmin only).", it: "Forza l'export statico di TUTTI i siti (solo superadmin)." },
    inputSchema: {},
  },

  // ── Newsletter — settings/signature ─────────────────────────────────────
  "GET /api/agent/sites/:siteId/newsletter/settings": {
    name: "newsletter_settings_get",
    description: { en: "Newsletter SMTP/signature configuration (the password is never returned in clear text, only smtp_pass_set).", it: "Configurazione SMTP/firma della newsletter (la password non è mai restituita in chiaro, solo smtp_pass_set)." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/newsletter/settings": {
    name: "newsletter_settings_set",
    description: { en: "One-time newsletter setup (dedicated SMTP + signature) — do this before any send. Partial body: omitted fields stay unchanged.", it: "Setup una tantum della newsletter (SMTP dedicato + firma) — fallo prima di qualunque invio. Body parziale: i campi omessi restano invariati." },
    inputSchema: {
      site_id: z.number(), smtp_host: z.string().optional(), smtp_port: z.number().optional(), smtp_user: z.string().optional(),
      smtp_pass: z.string().optional(), from_email: z.string().optional(), rate_per_hour: z.number().optional(), signature_html: z.string().optional(),
    },
  },

  // ── Newsletter — email template per sito ────────────────────────────────
  // Override di oggetto/corpo per ogni email di sistema del sito; se non
  // configurato si usa il default standard. Placeholder: {siteName},
  // {siteDomain}, {confirmUrl}, {cancelUrl}, {when}, {formSlug},
  // {fieldsHtml}, {title}, {url}, {urlPath}, {date}, {pageList}, {note}.
  "GET /api/agent/sites/:siteId/email-templates": {
    name: "email_templates_list",
    description: { en: "Lists the per-site email templates (which kinds are customized, with subject/body if set). Email kinds: newsletter_confirm, newsletter_test, call_confirmation, call_reminder, form_notify, deploy_notify, review_reminder.", it: "Elenca i template email per sito (quali tipi sono personalizzati, con oggetto/corpo se impostati). Tipi: newsletter_confirm, newsletter_test, call_confirmation, call_reminder, form_notify, deploy_notify, review_reminder." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/email-templates/:kind": {
    name: "email_templates_set",
    description: { en: "Sets the subject/body override for an email kind of this site. Empty subject/body = fall back to the standard default for that field. Use {siteName}, {confirmUrl}, {cancelUrl} etc. as placeholders.", it: "Imposta l'override di oggetto/corpo per un tipo di email del sito. Oggetto/corpo vuoti = torna al default standard per quel campo. Usa i placeholder {siteName}, {confirmUrl}, {cancelUrl} ecc." },
    inputSchema: {
      site_id: z.number(),
      kind: z.enum(["newsletter_confirm", "newsletter_test", "call_confirmation", "call_reminder", "form_notify", "deploy_notify", "review_reminder"]),
      subject: z.string().optional(), body_html: z.string().optional(),
    },
  },
  "DELETE /api/agent/sites/:siteId/email-templates/:kind": {
    name: "email_templates_delete",
    description: { en: "Removes the per-site override for an email kind (back to the standard default).", it: "Rimuove l'override per sito di un tipo di email (torna al default standard)." },
    inputSchema: {
      site_id: z.number(),
      kind: z.enum(["newsletter_confirm", "newsletter_test", "call_confirmation", "call_reminder", "form_notify", "deploy_notify", "review_reminder"]),
    },
  },

  // ── Newsletter — subscribers ────────────────────────────────────────────
  "GET /api/agent/sites/:siteId/newsletter/subscribers": {
    name: "newsletter_subscribers_list",
    description: { en: "Lists newsletter subscribers (optional status filter).", it: "Elenca gli iscritti alla newsletter (filtro opzionale per stato)." },
    inputSchema: { site_id: z.number(), status: z.enum(["pending", "confirmed", "unsubscribed"]).optional(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/newsletter/subscribers/stats": {
    name: "newsletter_subscribers_stats",
    description: { en: "Subscriber count by status (pending/confirmed/unsubscribed).", it: "Conteggio iscritti per stato (pending/confirmed/unsubscribed)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/newsletter/subscribers": {
    name: "newsletter_subscribers_add",
    description: { en: "Assisted import of a subscriber. confirmed:true skips double opt-in — use only for lists the user already has consent for.", it: "Import assistito di un iscritto. confirmed:true salta il doppio opt-in — usalo solo per liste di cui l'utente ha già il consenso." },
    inputSchema: { site_id: z.number(), email: z.string().email(), confirmed: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/newsletter/subscribers/:email": {
    name: "newsletter_subscribers_remove",
    description: { en: "Unsubscribes an address from the newsletter.", it: "Disiscrive un indirizzo dalla newsletter." },
    inputSchema: { site_id: z.number(), email: z.string().email() },
  },

  // ── Newsletter — broadcast campaigns ────────────────────────────────────
  "GET /api/agent/sites/:siteId/newsletter/campaigns": {
    name: "newsletter_campaigns_list",
    description: { en: "Lists broadcast campaigns with send/open counts.", it: "Elenca le campagne broadcast con conteggio invii/aperture." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/newsletter/campaigns/:campaignId": {
    name: "newsletter_campaigns_get",
    description: { en: "Reads a broadcast campaign in full.", it: "Legge una campagna broadcast per intero." },
    inputSchema: { site_id: z.number(), campaign_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/newsletter/campaigns": {
    name: "newsletter_campaigns_create",
    description: { en: "Creates a broadcast campaign draft. Content can use {{snippet:name}}/{{var:key}}, expanded at send time. target_tag restricts recipients to contacts with that tag (see contacts_tags_list); omitted/empty = all confirmed subscribers.", it: "Crea una campagna broadcast in bozza. Il contenuto può usare {{snippet:nome}}/{{var:chiave}}, espansi all'invio. target_tag limita i destinatari ai contatti con quel tag (vedi contacts_tags_list); omesso/vuoto = tutti gli iscritti confermati." },
    inputSchema: { site_id: z.number(), subject: z.string(), html_content: z.string().optional(), target_tag: z.string().optional() },
  },
  "PUT /api/agent/sites/:siteId/newsletter/campaigns/:campaignId": {
    name: "newsletter_campaigns_update",
    description: { en: "Edits a campaign (only if still a draft). Pass target_tag: \"\" to remove segmentation (target everyone again).", it: "Modifica una campagna (solo se ancora in bozza). Passa target_tag: \"\" per rimuovere la segmentazione (torna a targettare tutti)." },
    inputSchema: { site_id: z.number(), campaign_id: z.number(), subject: z.string().optional(), html_content: z.string().optional(), target_tag: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/newsletter/campaigns/:campaignId/send": {
    name: "newsletter_campaigns_send",
    description: { en: "Queues a campaign for sending (in batches, respecting the hourly quota). Use test-send first to check the content.", it: "Mette in coda una campagna per l'invio (a lotti, rispettando la quota oraria). Usa test-send prima per verificare il contenuto." },
    inputSchema: { site_id: z.number(), campaign_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/newsletter/campaigns/:campaignId/test-send": {
    name: "newsletter_campaigns_test_send",
    description: { en: "Test send of a campaign ([TEST] subject, no real unsubscribe/pixel, doesn't count as a send). If email is omitted, it goes to the authenticated account.", it: "Invio di prova di una campagna (oggetto [PROVA], niente unsubscribe/pixel reali, non conta come invio). Se email è omessa, va all'account autenticato." },
    inputSchema: { site_id: z.number(), campaign_id: z.number(), email: z.string().email().optional() },
  },
  "DELETE /api/agent/sites/:siteId/newsletter/campaigns/:campaignId": {
    name: "newsletter_campaigns_delete",
    description: { en: "Deletes a campaign (only if still a draft).", it: "Elimina una campagna (solo se ancora in bozza)." },
    inputSchema: { site_id: z.number(), campaign_id: z.number() },
  },

  // ── Newsletter — evergreen sequences ────────────────────────────────────
  "GET /api/agent/sites/:siteId/newsletter/sequences": {
    name: "newsletter_sequences_list",
    description: { en: "Lists evergreen sequences with step counts.", it: "Elenca le sequenze evergreen con conteggio step." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/newsletter/sequences": {
    name: "newsletter_sequences_create",
    description: { en: "Creates an empty evergreen sequence (define its steps with newsletter_sequences_set_steps right after). target_tag restricts recipients to contacts with that tag; omitted/empty = all confirmed subscribers.", it: "Crea una sequenza evergreen vuota (definisci gli step con newsletter_sequences_set_steps subito dopo). target_tag limita i destinatari ai contatti con quel tag; omesso/vuoto = tutti gli iscritti confermati." },
    inputSchema: { site_id: z.number(), name: z.string(), target_tag: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/newsletter/sequences/:sequenceId": {
    name: "newsletter_sequences_get",
    description: { en: "Reads a sequence with all its steps (delay, subject, sends/opens).", it: "Legge una sequenza con tutti i suoi step (ritardo, oggetto, invii/aperture)." },
    inputSchema: { site_id: z.number(), sequence_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/newsletter/sequences/:sequenceId": {
    name: "newsletter_sequences_update",
    description: { en: "Renames a sequence, activates/deactivates automatic sending, and/or changes its target tag. Pass target_tag: \"\" to remove segmentation.", it: "Rinomina una sequenza, attiva/disattiva l'invio automatico e/o cambia il tag target. Passa target_tag: \"\" per rimuovere la segmentazione." },
    inputSchema: { site_id: z.number(), sequence_id: z.number(), name: z.string().optional(), active: z.boolean().optional(), target_tag: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/newsletter/sequences/:sequenceId": {
    name: "newsletter_sequences_delete",
    description: { en: "Deletes a sequence and its entire send history.", it: "Elimina una sequenza e tutto il suo storico invii." },
    inputSchema: { site_id: z.number(), sequence_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/newsletter/sequences/:sequenceId/steps": {
    name: "newsletter_sequences_set_steps",
    description: { en: "ATOMICALLY replaces all steps of a sequence in 1 call (delay_days is relative to subscription confirmation, not to the previous step). On an already-active sequence with subscribers in progress, resets the history of the redefined steps.", it: "Sostituisce ATOMICAMENTE tutti gli step di una sequenza in 1 chiamata (delay_days è relativo alla conferma iscrizione, non allo step precedente). Su una sequenza già attiva con iscritti in corso, resetta lo storico degli step ridefiniti." },
    inputSchema: {
      site_id: z.number(), sequence_id: z.number(),
      steps: z.array(z.object({
        step_order: z.number(), delay_days: z.number(), subject: z.string(), html_content: z.string().optional(),
      })).min(1),
    },
  },
  "POST /api/agent/sites/:siteId/newsletter/sequences/:sequenceId/steps/:stepId/test-send": {
    name: "newsletter_sequences_test_send_step",
    description: { en: "Test send of a single step (same behavior as newsletter_campaigns_test_send).", it: "Invio di prova di un singolo step (stesso comportamento di newsletter_campaigns_test_send)." },
    inputSchema: { site_id: z.number(), sequence_id: z.number(), step_id: z.number(), email: z.string().email().optional() },
  },

  // ── Task ricorrenti + follow-up intelligente (Advanced features) ──────────────
  "GET /api/agent/sites/:siteId/recurring-tasks": {
    name: "recurring_tasks_list",
    description: { en: "Lists recurring task templates for a site.", it: "Elenca i template di task ricorrenti del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/recurring-tasks": {
    name: "recurring_task_create",
    description: { en: "Creates a recurring task template (daily/weekly/monthly/custom).", it: "Crea un template di task ricorrente (daily/weekly/monthly/custom)." },
    inputSchema: { site_id: z.number(), title: z.string(), notes: z.string().optional(), assignee_id: z.number().nullable().optional(), cadence: z.enum(["daily", "weekly", "monthly", "custom"]).default("daily"), interval_days: z.number().int().positive().optional(), next_due_at: z.string().datetime().optional(), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/recurring-tasks/:taskId": {
    name: "recurring_task_update",
    description: { en: "Updates a recurring task template.", it: "Aggiorna un template di task ricorrente." },
    inputSchema: { site_id: z.number(), task_id: z.number(), title: z.string().optional(), notes: z.string().optional(), assignee_id: z.number().nullable().optional(), cadence: z.enum(["daily", "weekly", "monthly", "custom"]).optional(), interval_days: z.number().int().positive().optional(), next_due_at: z.string().datetime().optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/recurring-tasks/:taskId": {
    name: "recurring_task_delete",
    description: { en: "Deletes a recurring task template.", it: "Elimina un template di task ricorrente." },
    inputSchema: { site_id: z.number(), task_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/followup-rules": {
    name: "followup_rules_list",
    description: { en: "Lists intelligent follow-up rules for a site.", it: "Elenca le regole di follow-up intelligente del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/followup-rules": {
    name: "followup_rule_create",
    description: { en: "Creates a follow-up rule: wait N days without reply, then act (task/email/tag).", it: "Crea una regola di follow-up: se dopo N giorni non c'è risposta, esegue un'azione (task/email/tag)." },
    inputSchema: { site_id: z.number(), name: z.string(), wait_days: z.number().int().min(0).default(3), channel: z.enum(["conversation", "email", "whatsapp", "any"]).default("conversation"), statuses: z.array(z.string()).default(["pending", "open"]), action_type: z.enum(["create_task", "notify_email", "add_tag"]), action_config: z.record(z.any()).default({}), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/followup-rules/:ruleId": {
    name: "followup_rule_update",
    description: { en: "Updates a follow-up rule.", it: "Aggiorna una regola di follow-up." },
    inputSchema: { site_id: z.number(), rule_id: z.number(), name: z.string().optional(), wait_days: z.number().int().min(0).optional(), channel: z.enum(["conversation", "email", "whatsapp", "any"]).optional(), statuses: z.array(z.string()).optional(), action_type: z.enum(["create_task", "notify_email", "add_tag"]).optional(), action_config: z.record(z.any()).optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/followup-rules/:ruleId": {
    name: "followup_rule_delete",
    description: { en: "Deletes a follow-up rule.", it: "Elimina una regola di follow-up." },
    inputSchema: { site_id: z.number(), rule_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/followup-check": {
    name: "followups_check",
    description: { en: "Runs the follow-up check now for a site (waited conversations → actions).", it: "Esegue subito il controllo follow-up per il sito (conversazioni in attesa → azioni)." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/followup-runs": {
    name: "followup_runs_list",
    description: { en: "Lists follow-up execution log (filter by rule_id/email).", it: "Elenca il log delle esecuzioni follow-up (filtro per rule_id/email)." },
    inputSchema: { site_id: z.number(), rule_id: z.number().optional(), email: z.string().optional(), limit: z.number().int().max(500).optional() },
  },

  // ── Ruoli/permessi granulari, turni, audit (Advanced features) ─────────────────
  "GET /api/agent/sites/:siteId/roles": {
    name: "crm_list_roles",
    description: { en: "Lists custom roles of a site (plus global ones).", it: "Elenca i ruoli custom del sito (più quelli globali)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/roles": {
    name: "crm_create_role",
    description: { en: "Creates a custom role with granular per-module permissions (e.g. {contacts:['read','update']}).", it: "Crea un ruolo custom con permessi granulari per modulo (es. {contacts:['read','update']})." },
    inputSchema: { site_id: z.number(), name: z.string().min(1).max(255), permissions: z.record(z.string(), z.array(z.string())).optional() },
  },
  "PUT /api/agent/sites/:siteId/roles/:roleId": {
    name: "crm_update_role",
    description: { en: "Updates role name/permissions.", it: "Aggiorna nome/permessi di un ruolo." },
    inputSchema: { site_id: z.number(), role_id: z.number(), name: z.string().min(1).max(255).optional(), permissions: z.record(z.string(), z.array(z.string())).optional() },
  },
  "DELETE /api/agent/sites/:siteId/roles/:roleId": {
    name: "crm_delete_role",
    description: { en: "Deletes a custom role (users lose it via SET NULL).", it: "Elimina un ruolo custom (gli utenti lo perdono via SET NULL)." },
    inputSchema: { site_id: z.number(), role_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/users/:userId/role": {
    name: "crm_assign_user_role",
    description: { en: "Assigns/removes a custom role to a site user.", it: "Assegna/toglie un ruolo custom a un utente del sito." },
    inputSchema: { site_id: z.number(), user_id: z.number(), custom_role_id: z.number().nullable() },
  },
  "GET /api/agent/sites/:siteId/shifts": {
    name: "crm_list_shifts",
    description: { en: "Lists operator shifts (with operator name/email).", it: "Elenca i turni operatori (con nome/email operatore)." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/shifts": {
    name: "crm_create_shift",
    description: { en: "Creates an operator shift.", it: "Crea un turno operatore." },
    inputSchema: { site_id: z.number(), user_id: z.number(), day_of_week: z.number().int().min(0).max(6), start_min: z.number().int().min(0).max(1439), end_min: z.number().int().min(0).max(1439), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/shifts/:shiftId": {
    name: "crm_update_shift",
    description: { en: "Updates an operator shift.", it: "Aggiorna un turno operatore." },
    inputSchema: { site_id: z.number(), shift_id: z.number(), user_id: z.number().optional(), day_of_week: z.number().int().min(0).max(6).optional(), start_min: z.number().int().min(0).max(1439).optional(), end_min: z.number().int().min(0).max(1439).optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/shifts/:shiftId": {
    name: "crm_delete_shift",
    description: { en: "Deletes an operator shift.", it: "Elimina un turno operatore." },
    inputSchema: { site_id: z.number(), shift_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/operators-on-duty": {
    name: "crm_operators_on_duty",
    description: { en: "Operators currently on duty for the site.", it: "Operatori attualmente in turno per il sito." },
    inputSchema: { site_id: z.number(), date: z.string().datetime().optional() },
  },
  "GET /api/agent/sites/:siteId/audit-events": {
    name: "crm_search_audit_log",
    description: { en: "Searches the audit log with filters (user/action/entity/date range).", it: "Cerca nel log audit con filtri (utente/azione/entità/range date)." },
    inputSchema: { site_id: z.number(), user_id: z.number().optional(), action: z.string().optional(), entity_type: z.string().optional(), from: z.string().optional(), to: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional() },
  },

  // ── Runtime conversazionale per canale (Advanced features) ────────────────────
  "GET /api/agent/sites/:siteId/agent-runtimes": {
    name: "agent_runtime_list",
    description: { en: "Lists the conversational runtimes of a site.", it: "Elenca i runtime conversazionali del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/agent-runtimes": {
    name: "agent_runtime_create",
    description: { en: "Creates a channel conversational runtime with contact match filters and ordered rules.", it: "Crea un runtime conversazionale per canale con filtro contatto e regole ordinate." },
    inputSchema: { site_id: z.number(), name: z.string().optional(), channel: z.enum(["whatsapp", "email", "chat"]), enabled: z.boolean().optional(), match: z.object({ contact_email: z.string().email().optional(), segment_id: z.number().optional(), tag: z.string().optional() }).optional(), rules: z.array(z.object({ when: z.object({ type: z.enum(["contains", "starts", "equals", "regex"]), text: z.string().max(500) }), reply: z.object({ text: z.string().optional(), actions: z.array(z.object({ type: z.enum(["add_tag", "create_task", "set_stage", "close_conversation"]), config: z.record(z.any()) })).optional() }) })).max(50).optional(), fallback_text: z.string().optional(), llm_prompt: z.string().optional() },
  },
  "PUT /api/agent/sites/:siteId/agent-runtimes/:runtimeId": {
    name: "agent_runtime_update",
    description: { en: "Updates a conversational runtime (partial merge).", it: "Aggiorna un runtime conversazionale (merge parziale)." },
    inputSchema: { site_id: z.number(), runtime_id: z.number(), name: z.string().optional(), channel: z.enum(["whatsapp", "email", "chat"]).optional(), enabled: z.boolean().optional(), match: z.object({ contact_email: z.string().email().optional(), segment_id: z.number().optional(), tag: z.string().optional() }).optional(), rules: z.array(z.object({ when: z.object({ type: z.enum(["contains", "starts", "equals", "regex"]), text: z.string().max(500) }), reply: z.object({ text: z.string().optional(), actions: z.array(z.object({ type: z.enum(["add_tag", "create_task", "set_stage", "close_conversation"]), config: z.record(z.any()) })).optional() }) })).max(50).optional(), fallback_text: z.string().optional(), llm_prompt: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/agent-runtimes/:runtimeId": {
    name: "agent_runtime_delete",
    description: { en: "Deletes a conversational runtime.", it: "Elimina un runtime conversazionale." },
    inputSchema: { site_id: z.number(), runtime_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/agent-runtime/process": {
    name: "agent_runtime_process",
    description: { en: "Processes an incoming message through the site's active runtime for the channel (writes the OUT reply to the conversation log; WhatsApp is never sent by the CMS).", it: "Processa un messaggio in ingresso col runtime attivo del canale (scrive la risposta OUT nel registro conversazioni; WhatsApp non viene mai inviato dal CMS)." },
    inputSchema: { site_id: z.number(), channel: z.enum(["whatsapp", "email", "chat"]), contact_email: z.string().email(), message: z.string(), conversation_id: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/agent-runtimes/:runtimeId/test": {
    name: "agent_runtime_test",
    description: { en: "Dry-runs a runtime against a message: which rule would match, without any side effect.", it: "Prova un runtime su un messaggio: quale regola matcha, senza alcun side-effect." },
    inputSchema: { site_id: z.number(), runtime_id: z.number(), message: z.string(), contact_email: z.string().email().optional() },
  },

  // ── Knowledge base aziendale (Advanced features) ──────────────────────────────
  "GET /api/agent/sites/:siteId/kb/search": {
    name: "kb_search",
    description: { en: "Full-text search (Italian) across company knowledge base articles (title+content), ranked by relevance.", it: "Ricerca full-text (italiano) negli articoli della knowledge base aziendale (titolo+contenuto), ordinati per rilevanza." },
    inputSchema: { site_id: z.number(), q: z.string(), category: z.string().optional(), limit: z.number().int().max(100).optional() },
  },
  "GET /api/agent/sites/:siteId/kb": {
    name: "kb_list",
    description: { en: "Lists knowledge base articles with optional category filter and pagination.", it: "Elenca gli articoli della knowledge base con filtro categoria e paginazione." },
    inputSchema: { site_id: z.number(), category: z.string().optional(), limit: z.number().int().max(500).optional(), offset: z.number().int().optional() },
  },
  "POST /api/agent/sites/:siteId/kb": {
    name: "kb_create",
    description: { en: "Creates a knowledge base article.", it: "Crea un articolo della knowledge base." },
    inputSchema: { site_id: z.number(), title: z.string().min(1).max(255), content: z.string().max(100000).optional(), category: z.string().max(100).optional(), tags: z.array(z.string()).max(50).optional() },
  },
  "GET /api/agent/sites/:siteId/kb/:articleId": {
    name: "kb_get",
    description: { en: "Gets a single knowledge base article.", it: "Recupera un singolo articolo della knowledge base." },
    inputSchema: { site_id: z.number(), article_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/kb/:articleId": {
    name: "kb_update",
    description: { en: "Updates a knowledge base article (partial update).", it: "Aggiorna un articolo della knowledge base (aggiornamento parziale)." },
    inputSchema: { site_id: z.number(), article_id: z.number(), title: z.string().max(255).optional(), content: z.string().max(100000).optional(), category: z.string().max(100).optional(), tags: z.array(z.string()).max(50).optional() },
  },
  "DELETE /api/agent/sites/:siteId/kb/:articleId": {
    name: "kb_delete",
    description: { en: "Deletes a knowledge base article.", it: "Elimina un articolo della knowledge base." },
    inputSchema: { site_id: z.number(), article_id: z.number() },
  },

  // ── Agent builder + sandbox (Advanced features) ───────────────────────────────
  "GET /api/agent/sites/:siteId/agent-definitions": {
    name: "agent_definitions_list",
    description: { en: "Lists agent definitions for a site.", it: "Elenca le definizioni di agente di un sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/agent-definitions": {
    name: "agent_definition_create",
    description: { en: "Creates an agent definition with config.", it: "Crea una definizione di agente con configurazione." },
    inputSchema: { site_id: z.number(), name: z.string().min(1).max(255), description: z.string().optional(), config: z.record(z.any()).optional(), sandbox: z.boolean().optional(), active: z.boolean().optional() },
  },
  "GET /api/agent/sites/:siteId/agent-definitions/:defId": {
    name: "agent_definition_get",
    description: { en: "Gets one agent definition.", it: "Recupera una definizione di agente." },
    inputSchema: { site_id: z.number(), def_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/agent-definitions/:defId": {
    name: "agent_definition_update",
    description: { en: "Updates an agent definition (partial merge).", it: "Aggiorna una definizione di agente (merge parziale)." },
    inputSchema: { site_id: z.number(), def_id: z.number(), name: z.string().min(1).max(255).optional(), description: z.string().optional(), config: z.record(z.any()).optional(), sandbox: z.boolean().optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/agent-definitions/:defId": {
    name: "agent_definition_delete",
    description: { en: "Deletes an agent definition.", it: "Elimina una definizione di agente." },
    inputSchema: { site_id: z.number(), def_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/agent-definitions/:defId/test": {
    name: "agent_definition_test",
    description: { en: "Dry-run tests an agent definition (no side effects).", it: "Testa in sandbox una definizione senza side-effect (nessuna conversazione/task/tag)." },
    inputSchema: { site_id: z.number(), def_id: z.number(), message: z.string().min(1), contact_email: z.string().email().optional(), channel: z.enum(["whatsapp", "email", "chat", "all"]).optional() },
  },
  "GET /api/agent/sites/:siteId/sandbox-runs": {
    name: "sandbox_runs_list",
    description: { en: "Lists sandbox test history.", it: "Mostra lo storico dei test sandbox." },
    inputSchema: { site_id: z.number(), limit: z.number().int().min(1).max(200).optional(), definition_id: z.number().optional() },
  },

  // ── Human-in-the-loop (Advanced features) ─────────────────────────────────────
  "GET /api/agent/sites/:siteId/approvals": {
    name: "approvals_list",
    description: { en: "Lists the approval queue (pending/approved/rejected), filterable by status and kind.", it: "Elenca la coda di approvazioni (pending/approved/rejected), filtrabile per status e kind." },
    inputSchema: { site_id: z.number(), status: z.enum(["pending", "approved", "rejected"]).optional(), kind: z.enum(["outbound_message", "task", "quote", "campaign", "contact_change", "custom"]).optional(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/approvals": {
    name: "approvals_enqueue",
    description: { en: "Adds a sensitive action to the human approval queue (message out, task creation, contact change, campaign…). It runs only after a human approves.", it: "Mette un'azione sensibile nella coda di approvazione umana (messaggio out, creazione task, modifica contatto, campagna…). Viene eseguita solo dopo l'approvazione di un umano." },
    inputSchema: { site_id: z.number(), kind: z.enum(["outbound_message", "task", "quote", "campaign", "contact_change", "custom"]), payload: z.record(z.any()), requested_by: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/approvals/:approvalId/approve": {
    name: "approvals_approve",
    description: { en: "Approves a queued action: executes its payload (creates the task, records the outbound message in the conversation thread and reopens it, updates the contact). Returns action_error if execution fails.", it: "Approva un'azione in coda: esegue il payload (crea la task, registra il messaggio out nel thread conversazioni riaprendolo, aggiorna il contatto). Se l'esecuzione fallisce ritorna action_error." },
    inputSchema: { site_id: z.number(), approval_id: z.number(), decided_by: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/approvals/:approvalId/reject": {
    name: "approvals_reject",
    description: { en: "Rejects a queued action: no payload is executed.", it: "Rifiuta un'azione in coda: nessun payload viene eseguito." },
    inputSchema: { site_id: z.number(), approval_id: z.number(), decided_by: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/approvals/:approvalId": {
    name: "approvals_delete",
    description: { en: "Deletes an approval queue entry (even if still pending).", it: "Elimina una voce dalla coda di approvazioni (anche se ancora pending)." },
    inputSchema: { site_id: z.number(), approval_id: z.number() },
  },

  // ── Riepilogo IA chiamate (Advanced features) ──────────────────────────────────
  "GET /api/agent/sites/:siteId/call-summaries": {
    name: "call_summaries_list",
    description: { en: "Lists AI call summaries (filter by status/call).", it: "Elenca i riepiloghi IA delle chiamate (filtro per status/chiamata)." },
    inputSchema: { site_id: z.number(), status: z.enum(["pending", "done"]).optional(), call_id: z.number().optional(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/call-summaries/:callId/generate": {
    name: "call_summary_generate",
    description: { en: "Generates the AI summary for a call (LLM if configured, template fallback). 409 if it already exists unless force=true.", it: "Genera il riepilogo IA di una chiamata (LLM se configurato, fallback a template). 409 se esiste già, salvo force=true." },
    inputSchema: { site_id: z.number(), call_id: z.number(), force: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/call-summaries/:id": {
    name: "call_summary_update",
    description: { en: "Updates a call summary (human correction, mark done).", it: "Aggiorna un riepilogo chiamata (correzione manuale, marca done)." },
    inputSchema: { site_id: z.number(), id: z.number(), summary: z.string().optional(), action_items: z.array(z.string()).optional(), next_step: z.string().optional(), status: z.enum(["pending", "done"]).optional() },
  },
  "DELETE /api/agent/sites/:siteId/call-summaries/:id": {
    name: "call_summary_delete",
    description: { en: "Deletes a call summary.", it: "Elimina un riepilogo chiamata." },
    inputSchema: { site_id: z.number(), id: z.number() },
  },

  // ── Proposta risposta all'operatore (Advanced features) ───────────────────────
  "GET /api/agent/sites/:siteId/reply-suggestions": {
    name: "reply_suggestions_list",
    description: { en: "Lists reply suggestions for a site, filterable by status (pending/used/dismissed) and conversation_id.", it: "Elenca le proposte di risposta del sito, filtrabili per status (pending/used/dismissed) e conversation_id." },
    inputSchema: { site_id: z.number(), status: z.enum(["pending", "used", "dismissed"]).optional(), conversation_id: z.number().optional(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/reply-suggestions/generate": {
    name: "reply_suggestions_generate",
    description: { en: "Generates a draft reply for a conversation using the knowledge base (LLM if configured, template fallback). The operator approves it with one click.", it: "Genera una bozza di risposta per una conversazione usando la knowledge base (LLM se configurato, fallback a template). L'operatore la approva con un clic." },
    inputSchema: { site_id: z.number(), conversation_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/reply-suggestions/:id/use": {
    name: "reply_suggestions_use",
    description: { en: "Approves a pending reply suggestion (status → used). 409 if already used.", it: "Approva una proposta di risposta pending (status → used). 409 se già usata." },
    inputSchema: { site_id: z.number(), suggestion_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/reply-suggestions/:id/dismiss": {
    name: "reply_suggestions_dismiss",
    description: { en: "Dismisses a reply suggestion (status → dismissed).", it: "Scarta una proposta di risposta (status → dismissed)." },
    inputSchema: { site_id: z.number(), suggestion_id: z.number() },
  },
  "DELETE /api/agent/sites/:siteId/reply-suggestions/:id": {
    name: "reply_suggestions_delete",
    description: { en: "Permanently deletes a reply suggestion.", it: "Elimina definitivamente una proposta di risposta." },
    inputSchema: { site_id: z.number(), suggestion_id: z.number() },
  },

  // ── Webhook in/out (Advanced features) ────────────────────────────────────────
  "GET /api/agent/sites/:siteId/webhooks": {
    name: "webhooks_list",
    description: { en: "Lists webhooks (in/out) for a site.", it: "Elenca i webhook (in/out) del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/webhooks": {
    name: "webhook_create",
    description: { en: "Creates a webhook: in (receives external events via public endpoint with token) or out (forwards CMS events to a URL with HMAC signature).", it: "Crea un webhook: in (riceve eventi esterni via endpoint pubblico con token) o out (inoltra eventi del CMS a un URL con firma HMAC)." },
    inputSchema: { site_id: z.number(), name: z.string().min(1).max(255), direction: z.enum(["in", "out"]), url: z.string().optional(), secret: z.string().optional(), events: z.array(z.any()).optional(), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/webhooks/:webhookId": {
    name: "webhook_update",
    description: { en: "Updates a webhook.", it: "Aggiorna un webhook." },
    inputSchema: { site_id: z.number(), webhook_id: z.number(), name: z.string().min(1).max(255).optional(), url: z.string().optional(), secret: z.string().optional(), events: z.array(z.any()).optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/webhooks/:webhookId": {
    name: "webhook_delete",
    description: { en: "Deletes a webhook.", it: "Elimina un webhook." },
    inputSchema: { site_id: z.number(), webhook_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/webhook-deliveries": {
    name: "webhook_deliveries_list",
    description: { en: "Lists outbound webhook deliveries (filter by status).", it: "Elenca le consegne webhook in uscita (filtro per status)." },
    inputSchema: { site_id: z.number(), status: z.enum(["pending", "sent", "failed"]).optional(), limit: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/webhook-deliveries/run": {
    name: "webhook_deliveries_run",
    description: { en: "Runs pending outbound deliveries now (with retry/backoff).", it: "Esegue subito le consegne in uscita pendenti (con retry/backoff)." },
    inputSchema: { site_id: z.number(), limit: z.number().optional() },
  },

  // ── OAuth Google (Advanced features) ──────────────────────────────────────────
  "GET /api/agent/sites/:siteId/oauth-apps": {
    name: "oauth_list_apps",
    description: { en: "Lists OAuth apps configured for a site.", it: "Elenca le app OAuth configurate per il sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/oauth-apps": {
    name: "oauth_create_app",
    description: { en: "Registers Google OAuth credentials (client_id/secret) for a site.", it: "Registra le credenziali OAuth Google (client_id/secret) per un sito." },
    inputSchema: { site_id: z.number(), client_id: z.string(), client_secret: z.string().optional(), redirect_uri: z.string(), scopes: z.array(z.string()).optional(), enabled: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/oauth-apps/:appId": {
    name: "oauth_update_app",
    description: { en: "Updates an OAuth app.", it: "Aggiorna un'app OAuth." },
    inputSchema: { site_id: z.number(), app_id: z.number(), client_id: z.string().optional(), client_secret: z.string().optional(), redirect_uri: z.string().optional(), scopes: z.array(z.string()).optional(), enabled: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/oauth-apps/:appId": {
    name: "oauth_delete_app",
    description: { en: "Deletes an OAuth app.", it: "Elimina un'app OAuth." },
    inputSchema: { site_id: z.number(), app_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/oauth/auth-url": {
    name: "oauth_get_auth_url",
    description: { en: "Builds the Google consent URL to start the authorization code flow.", it: "Costruisce l'URL di consenso Google per avviare il flusso Authorization Code." },
    inputSchema: { site_id: z.number(), app_id: z.number(), scope: z.array(z.string()).optional(), state: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/oauth/exchange": {
    name: "oauth_exchange_code",
    description: { en: "Exchanges the authorization code for access/refresh tokens.", it: "Scambia il codice di autorizzazione con access/refresh token." },
    inputSchema: { site_id: z.number(), app_id: z.number(), code: z.string(), state: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/oauth/connections": {
    name: "oauth_list_connections",
    description: { en: "Lists saved OAuth connections for a site.", it: "Elenca le connessioni OAuth salvate per il sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/oauth/disconnect": {
    name: "oauth_disconnect",
    description: { en: "Deactivates an OAuth connection.", it: "Disattiva una connessione OAuth." },
    inputSchema: { site_id: z.number(), app_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/oauth/refresh": {
    name: "oauth_refresh_token",
    description: { en: "Refreshes an expired access token using the saved refresh token.", it: "Rinnova l'access_token scaduto usando il refresh_token salvato." },
    inputSchema: { site_id: z.number(), connection_id: z.number() },
  },

  // ── Sync calendario (Advanced features) ───────────────────────────────────────
  "GET /api/agent/sites/:siteId/calendar-sync-configs": {
    name: "calendar_sync_configs_list",
    description: { en: "Lists calendar sync configs for a site.", it: "Elenca le configurazioni di sync calendario del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/calendar-sync-configs": {
    name: "calendar_sync_configs_create",
    description: { en: "Creates a bidirectional calls↔Google Calendar sync config.", it: "Crea una configurazione di sync bidirezionale chiamate↔Google Calendar." },
    inputSchema: { site_id: z.number(), oauth_connection_id: z.number().optional(), calendar_id: z.string().max(255).optional(), direction: z.enum(["both", "in", "out"]).optional(), mapping: z.record(z.any()).optional(), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/calendar-sync-configs/:configId": {
    name: "calendar_sync_configs_update",
    description: { en: "Updates a calendar sync config.", it: "Aggiorna una configurazione di sync calendario." },
    inputSchema: { site_id: z.number(), config_id: z.number(), oauth_connection_id: z.number().nullable().optional(), calendar_id: z.string().max(255).optional(), direction: z.enum(["both", "in", "out"]).optional(), mapping: z.record(z.any()).optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/calendar-sync-configs/:configId": {
    name: "calendar_sync_configs_delete",
    description: { en: "Deletes a calendar sync config.", it: "Elimina una configurazione di sync calendario." },
    inputSchema: { site_id: z.number(), config_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/calendar-sync-configs/:configId/sync": {
    name: "calendar_sync_run",
    description: { en: "Runs calendar sync now (calls→Google and/or Google→calls); fails cleanly if OAuth not configured.", it: "Esegue subito il sync calendario (chiamate→Google e/o Google→chiamate); fallisce in modo pulito se OAuth non è configurato." },
    inputSchema: { site_id: z.number(), config_id: z.number(), direction: z.enum(["both", "in", "out"]).optional() },
  },
  "GET /api/agent/sites/:siteId/calendar-sync-configs/:configId/log": {
    name: "calendar_sync_logs",
    description: { en: "Lists calendar sync execution logs.", it: "Elenca i log delle esecuzioni del sync calendario." },
    inputSchema: { site_id: z.number(), config_id: z.number(), limit: z.number().int().min(1).max(500).optional() },
  },

  // ── Link pagamento Stripe (Advanced features) ─────────────────────────────────
  "GET /api/agent/sites/:siteId/payment-links": {
    name: "payment_links_list",
    description: { en: "Lists payment links for a site, optionally filtered by status.", it: "Elenca i link di pagamento di un sito, con filtro opzionale per stato." },
    inputSchema: { site_id: z.number(), status: z.enum(["draft", "active", "paid", "expired"]).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
  },
  "GET /api/agent/sites/:siteId/payment-links/:id": {
    name: "payment_links_get",
    description: { en: "Gets a single payment link.", it: "Recupera un singolo link di pagamento." },
    inputSchema: { site_id: z.number(), id: z.number() },
  },
  "POST /api/agent/sites/:siteId/payment-links": {
    name: "payment_links_create",
    description: { en: "Creates a payment link; if Stripe is configured a real Stripe Payment Link is created.", it: "Crea un link di pagamento; se Stripe è configurato viene creato anche il Payment Link reale." },
    inputSchema: { site_id: z.number(), title: z.string().min(1).max(255), amount: z.number().nonnegative(), contact_email: z.string().email().optional(), description: z.string().max(5000).optional(), currency: z.string().length(3).optional(), opportunity_id: z.number().nullable().optional() },
  },
  "PUT /api/agent/sites/:siteId/payment-links/:id": {
    name: "payment_links_update",
    description: { en: "Updates title, description, amount or status of a payment link.", it: "Aggiorna titolo, descrizione, importo o stato di un link di pagamento." },
    inputSchema: { site_id: z.number(), id: z.number(), title: z.string().min(1).max(255).optional(), description: z.string().max(5000).optional(), amount: z.number().nonnegative().optional(), status: z.enum(["draft", "active", "paid", "expired"]).optional() },
  },
  "DELETE /api/agent/sites/:siteId/payment-links/:id": {
    name: "payment_links_delete",
    description: { en: "Deletes a payment link.", it: "Elimina un link di pagamento." },
    inputSchema: { site_id: z.number(), id: z.number() },
  },
  "POST /api/agent/sites/:siteId/payment-links/:id/mark-paid": {
    name: "payment_links_mark_paid",
    description: { en: "Marks a payment link as paid (e.g. offline payment); emits payment_paid event.", it: "Marca un link di pagamento come pagato (es. pagamento offline); emette l'evento payment_paid." },
    inputSchema: { site_id: z.number(), id: z.number(), by: z.string().optional() },
  },

  // ── Export/import completo (Advanced features) ────────────────────────────────
  "GET /api/agent/sites/:siteId/data-export": {
    name: "crm_export_data",
    description: { en: "Exports CRM data: JSON dump of tables (contacts, tasks, opportunities, quotes, conversations, contact_events, kb_articles, segments, payment_links, call_summaries, reply_suggestions; max 10000 rows each) or CSV of contacts.", it: "Esporta i dati CRM: dump JSON delle tabelle (contatti, task, opportunità, preventivi, conversazioni, eventi, articoli KB, segmenti, payment link, riepiloghi chiamate, suggerimenti risposta; max 10000 righe ciascuna) o CSV dei contatti." },
    inputSchema: { site_id: z.number(), format: z.enum(["json", "csv"]).optional(), tables: z.array(z.string()).optional() },
  },
  "POST /api/agent/sites/:siteId/data-import": {
    name: "crm_import_data",
    description: { en: "Imports contacts (upsert by email) or full CRM (contacts + tasks). Valid rows are imported, invalid ones skipped and logged in import_jobs (stats with up to 20 errors).", it: "Importa contatti (upsert per email) o CRM completo (contatti + task). Le righe valide vengono importate, quelle non valide saltate e registrate in import_jobs (stats con fino a 20 errori)." },
    inputSchema: { site_id: z.number(), kind: z.enum(["contacts", "crm"]).optional(), rows: z.array(z.record(z.any())).optional(), contacts: z.array(z.record(z.any())).optional(), tasks: z.array(z.record(z.any())).optional(), created_by: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/import-jobs": {
    name: "crm_import_jobs_list",
    description: { en: "Lists the import jobs of a site (newest first) with status and stats.", it: "Elenca i job di import del sito (più recenti prima) con stato e statistiche." },
    inputSchema: { site_id: z.number(), limit: z.number().optional() },
  },

  // ── Dashboard realtime (Advanced features) ────────────────────────────────────
  "GET /api/agent/sites/:siteId/dashboard/kpis": {
    name: "crm_get_dashboard_kpis",
    description: { en: "Gets live CRM dashboard KPIs (leads by channel, pipeline value, task SLA, open conversations) for a site. Range: 7d|30d|90d (default 30d).", it: "Ottiene i KPI live della dashboard CRM (lead per canale, valore pipeline, SLA task, conversazioni aperte) di un sito. Range: 7d|30d|90d (default 30d)." },
    inputSchema: { site_id: z.number(), range: z.enum(["7d", "30d", "90d"]).optional() },
  },
  "GET /api/agent/sites/:siteId/dashboard/views": {
    name: "crm_list_dashboard_views",
    description: { en: "Lists saved dashboard views for a site.", it: "Elenca le viste salvate della dashboard di un sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/dashboard/views": {
    name: "crm_create_dashboard_view",
    description: { en: "Creates a saved dashboard view (name + widget config, max 20 widgets).", it: "Crea una vista salvata della dashboard (nome + config widget, max 20 widget)." },
    inputSchema: { site_id: z.number(), name: z.string().min(1).max(255), config: z.record(z.any()).optional() },
  },
  "PUT /api/agent/sites/:siteId/dashboard/views/:viewId": {
    name: "crm_update_dashboard_view",
    description: { en: "Renames/updates config of a saved dashboard view.", it: "Rinomina/aggiorna la config di una vista salvata della dashboard." },
    inputSchema: { site_id: z.number(), view_id: z.number(), name: z.string().min(1).max(255).optional(), config: z.record(z.any()).optional() },
  },
  "DELETE /api/agent/sites/:siteId/dashboard/views/:viewId": {
    name: "crm_delete_dashboard_view",
    description: { en: "Deletes a saved dashboard view.", it: "Elimina una vista salvata della dashboard." },
    inputSchema: { site_id: z.number(), view_id: z.number() },
  },

  // ── Report periodici (Advanced features) ──────────────────────────────────────
  "GET /api/agent/sites/:siteId/report-configs": {
    name: "crm_list_report_configs",
    description: { en: "Lists periodic report configurations for a site.", it: "Elenca le configurazioni dei report periodici di un sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/report-configs": {
    name: "crm_create_report_config",
    description: { en: "Creates a periodic report configuration (weekly/monthly with sections and recipients).", it: "Crea una configurazione di report periodico (settimanale/mensile con sezioni e destinatari)." },
    inputSchema: { site_id: z.number(), name: z.string().min(1).max(255), kind: z.enum(["weekly", "monthly"]).optional(), sections: z.array(z.enum(["leads", "pipeline", "tasks", "conversations", "email"])).optional(), recipients: z.array(z.string().email()).max(20).optional(), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/report-configs/:configId": {
    name: "crm_update_report_config",
    description: { en: "Updates a report configuration.", it: "Aggiorna una configurazione di report." },
    inputSchema: { site_id: z.number(), config_id: z.number(), name: z.string().min(1).max(255).optional(), kind: z.enum(["weekly", "monthly"]).optional(), sections: z.array(z.enum(["leads", "pipeline", "tasks", "conversations", "email"])).optional(), recipients: z.array(z.string().email()).max(20).optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/report-configs/:configId": {
    name: "crm_delete_report_config",
    description: { en: "Deletes a report configuration.", it: "Elimina una configurazione di report." },
    inputSchema: { site_id: z.number(), config_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/report-configs/:configId/generate": {
    name: "crm_generate_report",
    description: { en: "Generates a report preview (JSON + HTML) without sending emails.", it: "Genera un'anteprima del report (JSON + HTML) senza inviare email." },
    inputSchema: { site_id: z.number(), config_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/report-configs/:configId/send": {
    name: "crm_send_report",
    description: { en: "Generates and emails the report to configured recipients.", it: "Genera e invia il report via email ai destinatari configurati." },
    inputSchema: { site_id: z.number(), config_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/report-configs/:configId/runs": {
    name: "crm_list_report_runs",
    description: { en: "Lists report send history for a config.", it: "Elenca lo storico degli invii di report per una config." },
    inputSchema: { site_id: z.number(), config_id: z.number(), limit: z.number().int().min(1).max(500).optional() },
  },

  // ── Sandbox/staging (Advanced features) ───────────────────────────────────────
  "GET /api/agent/sites/:siteId/sandbox/scenarios": {
    name: "sandbox_scenarios_list",
    description: { en: "Lists saved sandbox scenarios (dry-run definitions) for a site, optionally filtered by kind.", it: "Elenca gli scenari sandbox salvati (definizioni di dry-run) di un sito, con filtro opzionale per kind." },
    inputSchema: { site_id: z.number(), kind: z.enum(["segment", "workflow", "agent", "quote"]).optional() },
  },
  "POST /api/agent/sites/:siteId/sandbox/scenarios": {
    name: "sandbox_scenario_create",
    description: { en: "Saves a reusable sandbox scenario (name, kind, input) for later dry-runs.", it: "Salva uno scenario sandbox riutilizzabile (name, kind, input) per dry-run successivi." },
    inputSchema: { site_id: z.number(), name: z.string(), kind: z.enum(["segment", "workflow", "agent", "quote"]), input: z.record(z.any()).default({}) },
  },
  "PUT /api/agent/sites/:siteId/sandbox/scenarios/:scenarioId": {
    name: "sandbox_scenario_update",
    description: { en: "Updates an existing sandbox scenario (name, kind or input).", it: "Aggiorna uno scenario sandbox esistente (name, kind o input)." },
    inputSchema: { site_id: z.number(), scenario_id: z.number(), name: z.string().optional(), kind: z.enum(["segment", "workflow", "agent", "quote"]).optional(), input: z.record(z.any()).optional() },
  },
  "DELETE /api/agent/sites/:siteId/sandbox/scenarios/:scenarioId": {
    name: "sandbox_scenario_delete",
    description: { en: "Deletes a saved sandbox scenario.", it: "Elimina uno scenario sandbox salvato." },
    inputSchema: { site_id: z.number(), scenario_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/sandbox/run": {
    name: "sandbox_run",
    description: { en: "Executes a dry-run without side effects (segment preview, workflow actions, agent reply or quote total); logs one row in sandbox_runs and returns {sandbox_run_id, output}.", it: "Esegue un dry-run senza side-effect (anteprima segmento, azioni workflow, risposta agente o totale preventivo); registra una riga in sandbox_runs e ritorna {sandbox_run_id, output}." },
    inputSchema: { site_id: z.number(), kind: z.enum(["segment", "workflow", "agent", "quote"]), input: z.record(z.any()) },
  },
  "GET /api/agent/sites/:siteId/sandbox/runs": {
    name: "sandbox_runs_list",
    description: { en: "Lists dry-run execution logs (sandbox_runs) for a site, optionally filtered by kind.", it: "Elenca i log delle esecuzioni dry-run (sandbox_runs) di un sito, con filtro opzionale per kind." },
    inputSchema: { site_id: z.number(), kind: z.enum(["segment", "workflow", "agent", "quote"]).optional(), limit: z.number().int().min(1).max(200).optional() },
  },
  "GET /api/agent/sites/:siteId/sandbox/runs/:runId": {
    name: "sandbox_run_get",
    description: { en: "Returns a single dry-run execution log with input and output.", it: "Ritorna un singolo log di esecuzione dry-run con input e output." },
    inputSchema: { site_id: z.number(), run_id: z.number() },
  },

  // ── Backup automatici con storico (Advanced features) ─────────────────────────
  "GET /api/agent/sites/:siteId/backup-jobs": {
    name: "backup_jobs_list",
    description: { en: "Lists backup jobs of a site (newest first).", it: "Elenca i job di backup del sito (più recenti prima)." },
    inputSchema: { site_id: z.number(), limit: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/backup-jobs": {
    name: "backup_job_run",
    description: { en: "Runs a backup now (db/full/media) and records the job; fails cleanly if pg_dump is missing.", it: "Esegue subito un backup (db/full/media) e registra il job; fallisce in modo pulito se pg_dump non c'è." },
    inputSchema: { site_id: z.number(), kind: z.enum(["full", "db", "media"]).optional() },
  },
  "GET /api/agent/sites/:siteId/backup-jobs/:jobId": {
    name: "backup_job_get",
    description: { en: "Gets a single backup job detail.", it: "Recupera il dettaglio di un job di backup." },
    inputSchema: { site_id: z.number(), job_id: z.number() },
  },
  "DELETE /api/agent/sites/:siteId/backup-jobs/:jobId": {
    name: "backup_job_delete",
    description: { en: "Deletes a backup job (and its file if under backups/).", it: "Elimina un job di backup (e il file se in backups/)." },
    inputSchema: { site_id: z.number(), job_id: z.number() },
  },

  // ── Quote/rate-limit per canale (Advanced features) ───────────────────────────
  "GET /api/agent/sites/:siteId/channel-limits": {
    name: "channel_limits_list",
    description: { en: "Lists channel rate limits for a site.", it: "Elenca i limiti per canale del sito." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/channel-limits": {
    name: "channel_limits_create",
    description: { en: "Creates a channel rate limit.", it: "Crea un limite per canale." },
    inputSchema: { site_id: z.number(), channel: z.enum(["email", "whatsapp", "call", "sms", "chat"]), period: z.enum(["hour", "day"]).optional(), max_count: z.number().int().min(1).max(1000000).optional(), notify_email: z.string().optional(), active: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/channel-limits/:limitId": {
    name: "channel_limits_update",
    description: { en: "Updates a channel rate limit.", it: "Aggiorna un limite per canale." },
    inputSchema: { site_id: z.number(), limit_id: z.number(), max_count: z.number().int().min(1).max(1000000).optional(), notify_email: z.string().optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/channel-limits/:limitId": {
    name: "channel_limits_delete",
    description: { en: "Deletes a channel rate limit.", it: "Elimina un limite per canale." },
    inputSchema: { site_id: z.number(), limit_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/channel-limits/check": {
    name: "channel_limits_check",
    description: { en: "Checks remaining quota for a channel without consuming.", it: "Verifica la quota residua di un canale senza consumare." },
    inputSchema: { site_id: z.number(), channel: z.enum(["email", "whatsapp", "call", "sms", "chat"]), period: z.enum(["hour", "day"]).optional() },
  },
  "POST /api/agent/sites/:siteId/channel-limits/consume": {
    name: "channel_limits_consume",
    description: { en: "Consumes one unit of channel quota; alerts by email when the limit is exceeded.", it: "Consuma una unità della quota canale; avvisa via email al superamento del limite." },
    inputSchema: { site_id: z.number(), channel: z.enum(["email", "whatsapp", "call", "sms", "chat"]), period: z.enum(["hour", "day"]).optional() },
  },
  "GET /api/agent/sites/:siteId/channel-usage": {
    name: "channel_usage_history",
    description: { en: "Gets recent channel usage history.", it: "Storico recente dell'utilizzo canale." },
    inputSchema: { site_id: z.number(), channel: z.enum(["email", "whatsapp", "call", "sms", "chat"]), period: z.enum(["hour", "day"]).optional(), limit: z.number().int().min(1).max(100).optional() },
  },
  "POST /api/agent/sites/:siteId/channel-usage/reset": {
    name: "channel_usage_reset",
    description: { en: "Resets the current period channel counter (maintenance/test).", it: "Azzera il contatore canale del periodo corrente (manutenzione/test)." },
    inputSchema: { site_id: z.number(), channel: z.enum(["email", "whatsapp", "call", "sms", "chat"]), period: z.enum(["hour", "day"]).optional() },
  },

  // ── Clienti + Servizi (area clienti generica) ─────────────────────────
  "GET /api/agent/sites/:siteId/services-catalog": {
    name: "services_catalog_list",
    description: { en: "Lists the generic services catalog (keys + labels) available to assign to clients.", it: "Elenca il catalogo servizi generico (chiavi + label) assegnabili ai clienti." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/services-catalog": {
    name: "services_catalog_create",
    description: { en: "Creates a service in the catalog (key is lowercase [a-z0-9_-], stable for access checks).", it: "Crea un servizio nel catalogo (key minuscola [a-z0-9_-], stabile per le verifiche accesso)." },
    inputSchema: { site_id: z.number(), key: z.string().min(1).max(50), label: z.string().min(1).max(100), description: z.string().optional() },
  },
  "PATCH /api/agent/sites/:siteId/services-catalog/:key": {
    name: "services_catalog_update",
    description: { en: "Updates a service in the catalog (label, description, active).", it: "Aggiorna un servizio del catalogo (label, description, active)." },
    inputSchema: { site_id: z.number(), key: z.string(), label: z.string().optional(), description: z.string().optional(), active: z.boolean().optional() },
  },
  "DELETE /api/agent/sites/:siteId/services-catalog/:key": {
    name: "services_catalog_delete",
    description: { en: "Deletes a service from the catalog (also removes client assignments).", it: "Elimina un servizio dal catalogo (rimuove anche le assegnazioni ai clienti)." },
    inputSchema: { site_id: z.number(), key: z.string() },
  },
  "GET /api/agent/sites/:siteId/clients": {
    name: "clients_list",
    description: { en: "Lists clients (contacts marked as client) with their active services. Optional status filter: active|suspended|inactive.", it: "Elenca i clienti (contatti marcati come cliente) con i servizi attivi. Filtro opzionale per status: active|suspended|inactive." },
    inputSchema: { site_id: z.number(), status: z.enum(["active", "suspended", "inactive"]).optional() },
  },
  "GET /api/agent/sites/:siteId/clients/:contactId": {
    name: "clients_get",
    description: { en: "Gets one client (contact) with their active services.", it: "Legge un cliente (contatto) con i suoi servizi attivi." },
    inputSchema: { site_id: z.number(), contact_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/clients/:contactId/mark": {
    name: "clients_mark",
    description: { en: "Marks/unmarks a contact as client and sets client_status (inactive|active|suspended).", it: "Marca/smarca un contatto come cliente e imposta client_status (inactive|active|suspended)." },
    inputSchema: { site_id: z.number(), contact_id: z.number(), is_client: z.boolean().optional(), client_status: z.enum(["inactive", "active", "suspended"]).optional() },
  },
  "GET /api/agent/sites/:siteId/clients/:contactId/services": {
    name: "client_services_list",
    description: { en: "Lists the catalog services with their activation state for one client.", it: "Elenca i servizi del catalogo con lo stato di attivazione per un cliente." },
    inputSchema: { site_id: z.number(), contact_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/clients/:contactId/services/:serviceKey/set": {
    name: "client_services_set",
    description: { en: "Activates/deactivates a service for a client. Body: { active: bool, config?: object }.", it: "Attiva/disattiva un servizio per un cliente. Body: { active: bool, config?: object }." },
    inputSchema: { site_id: z.number(), contact_id: z.number(), service_key: z.string(), active: z.boolean(), config: z.record(z.any()).optional() },
  },
  "GET /api/agent/sites/:siteId/clients/:contactId/access/:serviceKey": {
    name: "client_access_check",
    description: { en: "Checks whether a client can access a service (has_access true only if client active + service active + assigned). Used by an EXTERNAL client-area service.", it: "Verifica se un cliente può accedere a un servizio (has_access true solo se cliente attivo + servizio attivo + assegnato). Usato da un servizio esterno di area clienti." },
    inputSchema: { site_id: z.number(), contact_id: z.number(), service_key: z.string() },
  },
  "GET /api/agent/sites/:siteId/clients/access-by-email": {
    name: "client_access_check_by_email",
    description: { en: "Checks client access to a service by contact email (convenience for the external client-area service). Query: ?email=...&service=...", it: "Verifica l'accesso di un cliente a un servizio tramite email del contatto (comodo per il servizio esterno di area clienti). Query: ?email=...&service=..." },
    inputSchema: { site_id: z.number(), email: z.string().email(), service: z.string() },
  },

  // ── Link tracciati / QR (Feature 45) ──────────────────────────────────
  "GET /api/agent/sites/:siteId/tracked-links": {
    name: "tracked_links_list",
    description: { en: "Lists tracked links (QR/short link) of a site, optionally filtered by status, with visit_count.", it: "Elenca i link tracciati (QR/link corto) di un sito, con filtro opzionale per stato e visit_count." },
    inputSchema: { site_id: z.number(), status: z.enum(["active", "paused"]).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
  },
  "GET /api/agent/sites/:siteId/tracked-links/:id": {
    name: "tracked_links_get",
    description: { en: "Gets a single tracked link with visit_count.", it: "Recupera un singolo link tracciato con visit_count." },
    inputSchema: { site_id: z.number(), id: z.number() },
  },
  "GET /api/agent/sites/:siteId/tracked-links/:id/stats": {
    name: "tracked_links_stats",
    description: { en: "Gets visit stats of a tracked link: total, unique visitors, daily breakdown (last N days, default 30).", it: "Statistiche visite di un link tracciato: totali, visitatori unici, dettaglio giornaliero (ultimi N giorni, default 30)." },
    inputSchema: { site_id: z.number(), id: z.number(), days: z.number().int().min(1).max(365).optional() },
  },
  "POST /api/agent/sites/:siteId/tracked-links": {
    name: "tracked_links_create",
    description: { en: "Creates a tracked link (label + target_url required; slug auto-generated on collision; channel/utm_campaign hook the funnel; qr_enabled default true).", it: "Crea un link tracciato (label + target_url obbligatori; slug auto-generato in caso di collisione; channel/utm_campaign agganciano il funnel; qr_enabled default true)." },
    inputSchema: { site_id: z.number(), label: z.string().min(1).max(255), target_url: z.string().min(1).max(2048), slug: z.string().max(120).optional(), channel: z.string().max(255).optional(), utm_campaign: z.string().max(255).optional(), status: z.enum(["active", "paused"]).optional(), qr_enabled: z.boolean().optional() },
  },
  "PUT /api/agent/sites/:siteId/tracked-links/:id": {
    name: "tracked_links_update",
    description: { en: "Updates label, target_url, channel, utm_campaign, status, qr_enabled or slug of a tracked link.", it: "Aggiorna label, target_url, channel, utm_campaign, status, qr_enabled o slug di un link tracciato." },
    inputSchema: { site_id: z.number(), id: z.number(), label: z.string().min(1).max(255).optional(), target_url: z.string().min(1).max(2048).optional(), channel: z.string().max(255).optional(), utm_campaign: z.string().max(255).optional(), status: z.enum(["active", "paused"]).optional(), qr_enabled: z.boolean().optional(), slug: z.string().max(120).optional() },
  },
  "DELETE /api/agent/sites/:siteId/tracked-links/:id": {
    name: "tracked_links_delete",
    description: { en: "Deletes a tracked link and its visit events.", it: "Elimina un link tracciato e i suoi eventi di visita." },
    inputSchema: { site_id: z.number(), id: z.number() },
  },
};

// ── Generic fallback for routes not (yet) in TOOL_META ──────────────────────

function autoName(method, path) {
  const slug = path.replace(/^\/api\/agent\//, "").replace(/[:/]/g, "_").replace(/-/g, "_").replace(/__+/g, "_").replace(/_$/, "");
  return `${method.toLowerCase()}_${slug}`;
}

function genericInputSchema(path) {
  const shape = {};
  for (const p of pathParamNames(path)) {
    shape[camelToSnake(p)] = z.union([z.string(), z.number()]);
  }
  shape.extra = z.record(z.any()).optional().describe("Other body/query fields, not yet individually documented — see AGENT.md for this endpoint.");
  return shape;
}

// ── Discovery: iterates the real router, merges introspection + TOOL_META ──

export function discoverTools(lang = "en") {
  const tools = [];
  const seen = new Set();

  for (const layer of agentRouter.stack) {
    if (!layer.route || typeof layer.route.path !== "string") continue;
    const path = layer.route.path;
    if (!path.startsWith("/api/agent")) continue;

    const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
    for (const method of methods) {
      const httpMethod = method.toUpperCase();
      const key = `${httpMethod} ${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const meta = TOOL_META[key];
      tools.push({
        method: httpMethod,
        path,
        name: meta?.name || autoName(httpMethod, path),
        description: meta ? pick(lang, meta.description) : `Agent endpoint ${httpMethod} ${path} — generic schema, see AGENT.md.`,
        inputSchema: meta?.inputSchema || genericInputSchema(path),
        multipart: meta?.multipart || false,
        enriched: !!meta,
      });
    }
  }
  return tools;
}

// ── Internal HTTP proxy: same REST code, no duplicated logic ────────────────

function resolvePath(pathTemplate, args) {
  const consumed = new Set();
  const resolved = pathTemplate.replace(/:([a-zA-Z0-9_]+)/g, (_, camelParam) => {
    const snakeKey = camelToSnake(camelParam);
    consumed.add(snakeKey);
    const val = args[snakeKey];
    if (val === undefined || val === null) throw new Error(`Missing parameter: ${snakeKey}`);
    return encodeURIComponent(String(val));
  });

  const rest = {};
  for (const [k, v] of Object.entries(args)) {
    if (consumed.has(k)) continue;
    if (k === "extra" && v && typeof v === "object") { Object.assign(rest, v); continue; }
    if (v !== undefined) rest[k] = v;
  }
  return { resolved, rest };
}

async function buildRequestBody(tool, rest) {
  if (!tool.multipart) {
    return { body: Object.keys(rest).length > 0 ? JSON.stringify(rest) : undefined, headers: { "Content-Type": "application/json" } };
  }
  // Only special case: media_upload is multipart on the REST side (multer).
  const rawB64 = String(rest.content_base64 || "");
  // Base64 non valido decodificato silenziosamente → blob spazzatura che
  // fallisce solo dopo (magic-bytes) con messaggio fuorviante. Validazione
  // esplicita qui, con errore chiaro subito.
  if (!rawB64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawB64) || rawB64.length % 4 !== 0) {
    return { error: "content_base64 non è un base64 valido" };
  }
  let buf;
  try {
    buf = Buffer.from(rawB64, "base64");
    // Roundtrip: Buffer.from(s) senza formato interpreta UTF-8, non base64!
    if (buf.length === 0 || !buf.equals(Buffer.from(buf.toString("base64"), "base64"))) throw new Error("bad base64");
  } catch {
    return { error: "content_base64 non è un base64 valido" };
  }
  const form = new FormData();
  form.append("file", new Blob([buf]), rest.filename || "upload.bin");
  return { body: form, headers: {} };
}

async function contentFromResponse(resp) {
  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const data = await resp.json().catch(() => null);
    return { content: [{ type: "text", text: JSON.stringify(data) }], isError: !resp.ok };
  }
  if (contentType.startsWith("text/")) {
    const text = await resp.text();
    return { content: [{ type: "text", text }], isError: !resp.ok };
  }
  // Binary (e.g. the site_backup zip): base64 as an embedded resource.
  const buf = Buffer.from(await resp.arrayBuffer());
  return {
    content: [{
      type: "resource",
      resource: { uri: `internal://mcp-proxy${resp.url ? new URL(resp.url).pathname : ""}`, mimeType: contentType || "application/octet-stream", blob: buf.toString("base64") },
    }],
    isError: !resp.ok,
  };
}

export function makeToolHandler(tool) {
  return async (args, extra) => {
    const authHeader = extra?.requestInfo?.headers?.authorization;
    if (!authHeader) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Missing Authorization header in the MCP request" }) }], isError: true };
    }

    let resolved, rest;
    try {
      ({ resolved, rest } = resolvePath(tool.path, args || {}));
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
    }

    const isBodyMethod = ["POST", "PUT", "PATCH"].includes(tool.method);
    let url = `http://127.0.0.1:${config.port}${resolved}`;
    let fetchOptions = { method: tool.method, headers: { Authorization: authHeader } };

    if (isBodyMethod) {
      const built = await buildRequestBody(tool, rest);
      if (built.error) {
        return { content: [{ type: "text", text: JSON.stringify({ error: built.error }) }], isError: true };
      }
      const { body, headers } = built;
      fetchOptions.body = body;
      fetchOptions.headers = { ...fetchOptions.headers, ...headers };
    } else if (Object.keys(rest).length > 0) {
      url += "?" + new URLSearchParams(Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]))).toString();
    }

    try {
      const resp = await fetch(url, { ...fetchOptions, signal: AbortSignal.timeout(60_000) });
      return await contentFromResponse(resp);
    } catch (err) {
      logger.error(`MCP proxy: call to ${tool.method} ${resolved} failed: ${err.message}`);
      return { content: [{ type: "text", text: JSON.stringify({ error: "Internal call failed: " + err.message }) }], isError: true };
    }
  };
}
