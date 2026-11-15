import { z } from "zod";
export const META = {
  "GET /api/agent/sites/:siteId/pages/:pageId/versions/:versionId": {
    name: "pages_version_get",
    description: { en: "Reads ONE version of a page (full content, capped by max_chars; truncated flag). Use pages_versions to list ids.", it: "Legge UNA versione di una pagina (contenuto completo, limitato da max_chars; flag truncated). Usa pages_versions per elencare gli id." },
    inputSchema: { site_id: z.number(), page_id: z.number(), version_id: z.number(), max_chars: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/version-diff": {
    name: "pages_version_diff",
    description: { en: "Bounded diff between two versions or a version and the current page: changed fields + line hunks of the content. Defaults: from = newest version, to = 'current'. Use before pages_restore_version.", it: "Diff limitato tra due versioni o tra una versione e la pagina corrente: campi cambiati + hunk di righe del contenuto. Default: from = versione piu recente, to = 'current'. Usalo prima di pages_restore_version." },
    inputSchema: { site_id: z.number(), page_id: z.number(), from: z.union([z.number(), z.literal("current")]).optional(), to: z.union([z.number(), z.literal("current")]).optional(), context: z.number().optional(), max_chars: z.number().optional() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/versions": {
    name: "pages_version_checkpoint",
    description: { en: "Creates a named checkpoint (full snapshot) of the page's current state.", it: "Crea un checkpoint con nome (snapshot completo) dello stato corrente della pagina." },
    inputSchema: { site_id: z.number(), page_id: z.number(), label: z.string().optional() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/versions/:versionId/restore": {
    name: "pages_restore_version",
    description: { en: "Restores a version atomically: a full snapshot of the current state is saved first, blog listings/homepage/static export are re-synced. Optional expected_updated_at (ISO, from pages_get) makes it fail with 409 stale_page if the page changed meanwhile.", it: "Ripristina una versione in modo atomico: prima salva uno snapshot completo dello stato corrente, poi risincronizza listing blog/homepage/export statico. expected_updated_at opzionale (ISO, da pages_get): se la pagina e cambiata nel frattempo risponde 409 stale_page." },
    inputSchema: { site_id: z.number(), page_id: z.number(), version_id: z.number(), expected_updated_at: z.string().optional() },
  },
};
