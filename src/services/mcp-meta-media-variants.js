import { z } from "zod";
export const META = {
  "GET /api/agent/sites/:siteId/media/:filename/variants": {
    name: "media_variants_get",
    description: { en: "Variants info of an image: generated widths, srcset strings, focal point, current images_srcset_mode (set it with blog_settings_update) and an on-demand URL example /img/<siteId>/<file>?w=640&fmt=auto.", it: "Info sulle varianti di un'immagine: larghezze generate, stringhe srcset, punto focale, images_srcset_mode corrente (si imposta con blog_settings_update) e un esempio di URL on-demand /img/<siteId>/<file>?w=640&fmt=auto." },
    inputSchema: { site_id: z.number(), filename: z.string() },
  },
  "PUT /api/agent/sites/:siteId/media/:filename/focal": {
    name: "media_focal_set",
    description: { en: "Sets the focal point (x,y in 0..1) used by on-demand crops (/img with w and h); clear:true removes it.", it: "Imposta il punto focale (x,y in 0..1) usato dai ritagli on-demand (/img con w e h); clear:true lo rimuove." },
    inputSchema: { site_id: z.number(), filename: z.string(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), clear: z.boolean().optional() },
  },
  "POST /api/agent/sites/:siteId/media/:filename/variants/regenerate": {
    name: "media_variants_regenerate",
    description: { en: "Generates (or refreshes) the WebP/AVIF variants of one image synchronously (a large photo takes several seconds).", it: "Genera (o aggiorna) in modo sincrono le varianti WebP/AVIF di una immagine (una foto grande richiede alcuni secondi)." },
    inputSchema: { site_id: z.number(), filename: z.string() },
  },
};
