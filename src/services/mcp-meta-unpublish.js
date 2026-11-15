import { z } from "zod";

const pageFields = {
  url_path: z.string(), title: z.string().optional(), content: z.string().optional(),
  layout_mode: z.enum(["standalone", "wrapped"]).optional(), published: z.boolean().optional(),
  publish_at: z.string().nullable().optional().describe("ISO 8601 datetime WITH offset (e.g. 2026-12-01T09:00:00+01:00): scheduled publication"),
  unpublish_at: z.string().nullable().optional().describe("ISO 8601 datetime WITH offset: automatic unpublication. Must be in the future and after publish_at. null clears it. On PUT, omitted = keep current"),
  post_type: z.enum(["page", "article"]).optional(), category_id: z.number().nullable().optional(),
  excerpt: z.string().optional(), featured_image: z.string().optional(), published_at: z.string().optional(),
  card_title: z.string().optional(), reading_time_minutes: z.number().nullable().optional(),
};

export const META = {
  "POST /api/agent/sites/:siteId/pages": {
    name: "pages_create",
    description: { en: "Creates a page or article. Supports publish_at (scheduled publication) and unpublish_at (automatic expiry). Inline base64 in the content is extracted to files automatically.", it: "Crea una pagina o un articolo. Supporta publish_at (pubblicazione programmata) e unpublish_at (scadenza automatica). Il base64 inline nel contenuto viene estratto automaticamente in file." },
    inputSchema: { site_id: z.number(), ...pageFields },
  },
  "PUT /api/agent/sites/:siteId/pages/:pageId": {
    name: "pages_replace",
    description: { en: "Overwrites the ENTIRE content of a page (saves a version first). Prefer find-replace for partial edits. unpublish_at omitted = unchanged.", it: "Sovrascrive TUTTO il contenuto di una pagina (salva versione prima). Preferire find-replace per modifiche parziali. unpublish_at omesso = invariato." },
    inputSchema: { site_id: z.number(), page_id: z.number(), ...pageFields },
  },
};
