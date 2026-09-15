import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import config from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "../../locales");
export const SUPPORTED_LANGS = ["it", "en"];
const FALLBACK_LANG = "en";

const cache = new Map();

function loadLocale(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let strings = {};
  try {
    strings = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${lang}.json`), "utf8"));
  } catch {
    strings = {};
  }
  cache.set(lang, strings);
  return strings;
}

// Lookup puro con interpolazione {placeholder} — riusabile sia dentro una
// request (res.locals.t, sotto) sia da servizi background senza req/res
// (email, scheduler): translate(config.defaultLang, "api.pages.notFound").
export function translate(lang, key, vars) {
  const strings = loadLocale(SUPPORTED_LANGS.includes(lang) ? lang : FALLBACK_LANG);
  const fallbackStrings = lang === FALLBACK_LANG ? strings : loadLocale(FALLBACK_LANG);
  let str = strings[key] ?? fallbackStrings[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }
  return str;
}

// Legge un documento markdown multilingua da locales/{lang}/{filename}
// (es. AGENT.md, MCP.md), con fallback a "en" se il file per quella lingua
// non esiste ancora.
export function readLocaleMarkdown(lang, filename) {
  // Whitelist lang PRIMA del path.join (come loadLocale): evita path
  // traversal via lang arbitrario ("../../etc"). I chiamanti attuali passano
  // già lang filtrato (res.locals.lang), ma la funzione non deve dipenderne.
  const safeLang = SUPPORTED_LANGS.includes(lang) ? lang : FALLBACK_LANG;
  const primary = path.join(LOCALES_DIR, safeLang, filename);
  const fallback = path.join(LOCALES_DIR, FALLBACK_LANG, filename);
  try {
    return fs.readFileSync(primary, "utf8");
  } catch {
    return fs.readFileSync(fallback, "utf8");
  }
}

export function resolveLang(req) {
  const cookieLang = req.cookies?.lang;
  return SUPPORTED_LANGS.includes(cookieLang)
    ? cookieLang
    : (SUPPORTED_LANGS.includes(config.defaultLang) ? config.defaultLang : FALLBACK_LANG);
}

export function i18nMiddleware(req, res, next) {
  const lang = resolveLang(req);

  req.lang = lang;
  res.locals.t = (key, vars) => translate(lang, key, vars);
  res.locals.lang = lang;
  next();
}
