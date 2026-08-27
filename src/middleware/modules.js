import { query } from "../db.js";
import { MODULE_KEYS } from "../constants/modules.js";

export async function isModuleEnabled(siteId, key) {
  if (!siteId) return false;
  const row = (await query(
    "SELECT enabled FROM site_modules WHERE site_id = $1 AND module_key = $2",
    [siteId, key]
  )).rows[0];
  return !!row?.enabled;
}

export async function listEnabledModules(siteId) {
  if (!siteId) return [];
  const rows = (await query(
    "SELECT module_key FROM site_modules WHERE site_id = $1 AND enabled = true",
    [siteId]
  )).rows;
  return rows.map(r => r.module_key);
}

// Stessa risoluzione siteId usata in giro per le route admin (forms.js,
// contacts.js, newsletter.js): superadmin puà passare ?site_id=, altrimenti
// il sito dell'utente. Duplicata qui invece di importata perché non esiste
// un middleware condiviso di risoluzione siteId in questo codebase — vedi
// nota in resolve-site.js, che risolve dal dominio, non da un parametro.
function resolveSiteId(req) {
  const isSuperadmin = req.user?.role === "superadmin";
  const fromQuery = req.query?.site_id || req.body?.site_id;
  let siteId = isSuperadmin && fromQuery ? parseInt(fromQuery, 10) : req.user?.site_id;
  if (!siteId && isSuperadmin) {
    return query("SELECT id FROM sites ORDER BY id LIMIT 1").then(rows => rows.rows[0]?.id);
  }
  return Promise.resolve(siteId);
}

export function requireModule(key) {
  return async (req, res, next) => {
    if (!req.user) {
      return req.path.startsWith("/api")
        ? res.status(401).json({ error: res.locals.t("api.auth.authRequired") })
        : res.redirect("/login");
    }
    const siteId = await resolveSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const enabled = req.user.role === "superadmin" || await isModuleEnabled(siteId, key);
    if (!enabled) {
      const message = res.locals.t("api.modules.notEnabled");
      return req.path.startsWith("/api") ? res.status(403).json({ error: message }) : res.status(403).render("error", { message });
    }
    req.moduleSiteId = siteId;
    next();
  };
}

// Montato globalmente su /admin (vedi index.js): rende disponibile
// enabledModules a res.locals per ogni pagina admin, così il layout può
// mostrare/nascondere le voci di menu senza che ogni singola route debba
// calcolarlo. Non blocca nulla: una lista vuota significa solo "nessuna
// voce di modulo in sidebar", i moduli restano comunque protetti da
// requireModule sulle rispettive route.
export async function attachEnabledModules(req, res, next) {
  try {
    const siteId = await resolveSiteId(req);
    res.locals.enabledModules = req.user?.role === "superadmin" ? MODULE_KEYS : await listEnabledModules(siteId);
  } catch {
    res.locals.enabledModules = [];
  }
  next();
}
