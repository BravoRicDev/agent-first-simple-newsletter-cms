import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../db.js";
import config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.resolve(__dirname, "../../views");

// Un sito può avere sites.layout_template valorizzato con un nome che non
// corrisponde a nessun file .ejs esistente (inserito manualmente, o layout
// rimosso in seguito) — verifica sempre il file fisico prima di usarlo,
// altrimenti il rendering pubblico del sito si romperebbe.
export function resolveLayoutName(layoutTemplate) {
  if (!layoutTemplate) return "site";
  // Path traversal: `path.join` normalizza, quindi un layout_template tipo
  // `../../admin/dashboard` risolveva in VIEWS_DIR/admin/dashboard.ejs e,
  // se il file esisteva, veniva renderizzato come layout del sito pubblico
  // (disclosure della UI admin). Il candidate DEVE stare dentro views/layouts.
  const candidate = path.resolve(VIEWS_DIR, "layouts", `${layoutTemplate}.ejs`);
  if (!candidate.startsWith(path.join(VIEWS_DIR, "layouts") + path.sep)) return "site";
  return fs.existsSync(candidate) ? layoutTemplate : "site";
}

// Unica query a site_variables per il set di chiavi di tema/branding —
// va chiamata una sola volta per render (serve.js / static-export.js /
// pages.js preview), mai duplicata per feature separate nello stesso punto.
export async function getSiteThemeVars(siteId) {
  const rows = siteId
    ? (await query(
        `SELECT key, value FROM site_variables
         WHERE site_id = $1 AND key IN ('primary_color','secondary_color','logo_text','brand_name','contact_email','legal_line','ai_disclosure_text','footer_tagline')`,
        [siteId]
      )).rows
    : [];
  const map = {};
  for (const r of rows) map[r.key] = r.value;

  const brandName = map.brand_name || config.siteDefaultBrand;
  return {
    primaryColor: map.primary_color || "#37ca37",
    secondaryColor: map.secondary_color || "#188bf6",
    logoText: map.logo_text || brandName,
    brandName,
    contactEmail: map.contact_email || "",
    legalLine: map.legal_line || `© ${new Date().getFullYear()} ${brandName} - All rights reserved.`,
    // Tagline nel footer: per-sito (site_variables.footer_tagline) con
    // fallback globale da .env (FOOTER_TAGLINE). Se entrambi vuoti, la
    // riga non viene renderizzata dal footer.
    footerTagline: map.footer_tagline || config.footerTagline,
    // Art. 50 AI Act: dicitura opzionale, testo libero deciso dal sito (non
    // obbligatoria se i contenuti IA passano da revisione editoriale umana,
    // che è già il flusso normale di questo CMS — vedi help text in admin).
    aiDisclosureText: map.ai_disclosure_text || "",
  };
}
