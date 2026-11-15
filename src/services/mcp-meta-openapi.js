import { z } from "zod";
export const META = {
  "GET /api/agent/openapi.json": {
    name: "agent_openapi_get",
    description: { en: "OpenAPI 3.1 document of the whole agent API (generated from this tool catalog). The full document is large: pass area (content|newsletter|crm|automation|integrations|admin) to keep it small. lang: en|it.", it: "Documento OpenAPI 3.1 dell'intera API agente (generato da questo catalogo). Il documento completo e grande: passa area (content|newsletter|crm|automation|integrations|admin) per ridurlo. lang: en|it." },
    inputSchema: { area: z.string().optional(), lang: z.enum(["en", "it"]).optional() },
  },
};
