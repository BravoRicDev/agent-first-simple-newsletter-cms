import { z } from "zod";
export const META = {
  "GET /api/agent/sites/:siteId/editorial/queue": {
    name: "editorial_queue",
    description: { en: "Pages waiting in an editorial status (default in_review) for the site. Only meaningful when editorial_workflow_enabled=1 (blog_settings_update).", it: "Pagine in attesa in uno stato editoriale (default in_review) del sito. Ha senso solo con editorial_workflow_enabled=1 (blog_settings_update)." },
    inputSchema: { site_id: z.number(), status: z.enum(["draft", "in_review", "approved", "rejected", "published"]).optional(), limit: z.number().optional(), offset: z.number().optional() },
  },
  "GET /api/agent/sites/:siteId/pages/:pageId/editorial": {
    name: "pages_editorial_get",
    description: { en: "Editorial status of a page, the actions YOU may perform now, and the review history.", it: "Stato editoriale di una pagina, le azioni che TU puoi eseguire ora e lo storico delle revisioni." },
    inputSchema: { site_id: z.number(), page_id: z.number() },
  },
  "POST /api/agent/sites/:siteId/pages/:pageId/editorial/:action": {
    name: "pages_editorial_transition",
    description: { en: "Editorial transition: submit (draft/rejected -> in_review), withdraw, approve, reject (comment required), publish (approved -> published), unpublish, reopen. With the workflow ON, direct publishing is blocked for non-publishers (403 editorial_review_required): use submit.", it: "Transizione editoriale: submit (draft/rejected -> in_review), withdraw, approve, reject (commento obbligatorio), publish (approved -> published), unpublish, reopen. Con il workflow attivo la pubblicazione diretta e bloccata per chi non puo pubblicare (403 editorial_review_required): usa submit." },
    inputSchema: { site_id: z.number(), page_id: z.number(), action: z.enum(["submit", "withdraw", "approve", "reject", "publish", "unpublish", "reopen"]), comment: z.string().optional() },
  },
};
