import { z } from "zod";

export const META = {
  "GET /api/agent/sites/:siteId/validate-path": {
    name: "validate_path",
    description: { en: "Checks whether a proposed URL path is well-formed and available on the specified site; provide url_path as a query value before creating a page.", it: "Verifica che un path URL proposto sia valido e disponibile sul sito indicato; passa url_path come query prima di creare una pagina." },
    inputSchema: { site_id: z.number(), url_path: z.string() },
  },
  "POST /api/agent/sites/:siteId/snippets/bulk-rename": {
    name: "snippets_bulk_rename",
    description: { en: "Renames up to 50 snippets by id and records the updates in the site audit log; names must contain snippet_id and new_name.", it: "Rinomina fino a 50 snippet per ID e registra gli aggiornamenti nel log di audit del sito; names deve contenere snippet_id e new_name." },
    inputSchema: { site_id: z.number(), names: z.array(z.object({ snippet_id: z.number().int().positive(), new_name: z.string().min(1) })).min(1).max(50) },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/tracking": {
    name: "page_tracking_get",
    description: { en: "Reads page-specific tracking overrides for the selected site page, including pixel, event tracking and consent-cookie settings.", it: "Legge gli override di tracking della pagina selezionata, inclusi pixel, eventi tracciati e impostazioni del cookie di consenso." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/pages/:pageId/tracking": {
    name: "page_tracking_set",
    description: { en: "Updates page-specific tracking overrides; omitted fields remain unchanged. Supports pixelEnabled, trackPageview, trackLead, consentCookieHours and trackCompleteRegistration.", it: "Aggiorna gli override di tracking della pagina; i campi omessi restano invariati. Supporta pixelEnabled, trackPageview, trackLead, consentCookieHours e trackCompleteRegistration." },
    inputSchema: { site_id: z.number(), page_id: z.number(), pixelEnabled: z.boolean().optional(), trackPageview: z.boolean().optional(), trackLead: z.boolean().optional(), consentCookieHours: z.number().optional(), trackCompleteRegistration: z.boolean().optional() },
  },
  "POST /api/agent/sites/:siteId/newsletter/complaints": {
    name: "newsletter_complaint_create",
    description: { en: "Records an email complaint and suppresses the matching newsletter subscriber; email is required and source defaults to fbl.", it: "Registra una segnalazione email e sopprime il relativo iscritto alla newsletter; email è obbligatoria e source predefinito a fbl." },
    inputSchema: { site_id: z.number(), email: z.string().email(), source: z.string().optional() },
  },
  "GET /api/agent/sites/:siteId/newsletter/metrics": {
    name: "newsletter_metrics_get",
    description: { en: "Returns complaint metrics for the specified site's newsletter without changing subscriber or campaign data.", it: "Restituisce le metriche dei reclami per la newsletter del sito indicato senza modificare iscritti o campagne." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/import-jobs/:jobId": {
    name: "import_jobs_get",
    description: { en: "Gets the status and details of one import job belonging to the specified site, identified by jobId.", it: "Recupera stato e dettagli di un job di importazione del sito indicato, identificato da jobId." },
    inputSchema: { site_id: z.number(), job_id: z.string() },
  },
  "GET /api/agent/sites/:siteId/source-sync/config": {
    name: "source_sync_config_get",
    description: { en: "Reads source synchronization configuration for a site; credentials are masked and only tokenSet is exposed.", it: "Legge la configurazione di sincronizzazione sorgente del sito; le credenziali sono mascherate e viene esposto solo tokenSet." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/source-sync/config": {
    name: "source_sync_config_set",
    description: { en: "Creates or updates source sync configuration. Accepts optional baseUrl, locationId, companyId, token, flags, quotas, push settings and syncMasterSiteId.", it: "Crea o aggiorna la configurazione source sync. Accetta baseUrl, locationId, companyId, token, flag, quote, impostazioni push e syncMasterSiteId opzionali." },
    inputSchema: { site_id: z.number(), enabled: z.boolean().optional(), baseUrl: z.string().optional(), locationId: z.string().optional(), companyId: z.string().optional(), token: z.string().optional(), matchByEmail: z.boolean().optional(), handleDeletes: z.boolean().optional(), throttleRps: z.number().optional(), dailyQuota: z.number().optional(), budgetPercent: z.number().optional(), minIntervalMinutes: z.number().optional(), pushEnabled: z.boolean().optional(), pushDirection: z.enum(["in", "out", "bidirectional"]).optional(), pushEvents: z.array(z.enum(["contact", "opportunity"])).optional(), syncMasterSiteId: z.union([z.number(), z.string(), z.null()]).optional() },
  },
  "POST /api/agent/sites/:siteId/source-sync/run": {
    name: "source_sync_run",
    description: { en: "Starts a background source sync for the site; optionally restrict resources or set dryRun to preview without applying changes.", it: "Avvia una sincronizzazione sorgente in background; è possibile limitare resources o impostare dryRun per simulare senza applicare modifiche." },
    inputSchema: { site_id: z.number(), resources: z.array(z.string()).optional(), dryRun: z.boolean().optional() },
  },
  "POST /api/agent/sites/:siteId/source-sync/stop-waiting": {
    name: "source_sync_running_get",
    description: { en: "Checks whether a source synchronization is currently running for the specified site; despite POST, it does not stop the run.", it: "Controlla se una sincronizzazione sorgente è in corso per il sito indicato; nonostante POST, non interrompe l'esecuzione." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/source-sync/runs": {
    name: "source_sync_runs_list",
    description: { en: "Lists recent source sync runs and state for a site; optional limit is capped at 50 and defaults to 10.", it: "Elenca le sincronizzazioni recenti e lo stato del sito; limit opzionale è massimo 50 e predefinito a 10." },
    inputSchema: { site_id: z.number(), limit: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/source-sync/budget": {
    name: "source_sync_budget_get",
    description: { en: "Reads the site's source API call budget, including today's usage, maximum allowance and remaining calls.", it: "Legge il budget di chiamate API sorgente del sito, inclusi utilizzo odierno, massimo consentito e chiamate rimanenti." },
    inputSchema: { site_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/source-push/run": {
    name: "source_push_run",
    description: { en: "Starts draining the site's outbound source push queue in the background; optional limit defaults to 20 and is capped at 100.", it: "Avvia in background lo svuotamento della coda push sorgente del sito; limit opzionale predefinito a 20 e massimo 100." },
    inputSchema: { site_id: z.number(), limit: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/source-push": {
    name: "source_push_status",
    description: { en: "Reads outbound source push queue counts and the 25 most recent queue entries for the specified site.", it: "Legge i conteggi della coda push sorgente e le 25 voci più recenti per il sito indicato." },
    inputSchema: { site_id: z.number() },
  },
  "GET /api/agent/sites/:siteId/access-grants": {
    name: "access_grants_list",
    description: { en: "Lists protected-content access grants for a site, optionally filtered by recipient email.", it: "Elenca i permessi di accesso ai contenuti protetti del sito, con filtro email destinatario opzionale." },
    inputSchema: { site_id: z.number(), email: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/access-grants": {
    name: "access_grants_create",
    description: { en: "Creates an access grant for protected media and returns its share URL; accepts email, mediaPath (or media_path, required), expiry, use limit and source.", it: "Crea un permesso per media protetti e restituisce l'URL di condivisione; accetta email, mediaPath (o media_path, obbligatorio), scadenza, limite utilizzi e source." },
    inputSchema: { site_id: z.number(), email: z.string().optional(), mediaPath: z.string().optional(), media_path: z.string().optional(), expiresAt: z.string().optional(), expires_at: z.string().optional(), maxUses: z.number().optional(), max_uses: z.number().optional(), source: z.string().optional() },
  },
  "DELETE /api/agent/sites/:siteId/access-grants/:grantId": {
    name: "access_grants_revoke",
    description: { en: "Revokes one access grant by grantId for the selected site; the grant cannot be used to access protected media afterward.", it: "Revoca un permesso tramite grantId per il sito selezionato; il permesso non potrà più accedere ai media protetti." },
    inputSchema: { site_id: z.number(), grant_id: z.number() },
  },
};
