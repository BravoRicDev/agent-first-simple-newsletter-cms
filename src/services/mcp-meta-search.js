import { z } from "zod";
export const META = {
  "GET /api/agent/sites/:siteId/search": {
    name: "search_pages",
    description: { en: "Full-text search (stemming in the site search_language) over live pages; include_unpublished adds drafts. For plain substring search use pages_search.", it: "Ricerca full-text (stemming nella lingua search_language del sito) sulle pagine live; include_unpublished aggiunge le bozze. Per la ricerca per sottostringa usa pages_search." },
    inputSchema: { site_id: z.number(), q: z.string().min(2), limit: z.number().optional(), offset: z.number().optional(), include_unpublished: z.boolean().optional() },
  },
  "POST /api/agent/sites/:siteId/search/reindex": {
    name: "search_reindex",
    description: { en: "Rebuilds the search index of the site (needed only after bulk SQL changes or a search_language change; normal saves reindex automatically).", it: "Ricostruisce l'indice di ricerca del sito (serve solo dopo modifiche SQL massive o un cambio di search_language; i salvataggi normali reindicizzano da soli)." },
    inputSchema: { site_id: z.number() },
  },
};
