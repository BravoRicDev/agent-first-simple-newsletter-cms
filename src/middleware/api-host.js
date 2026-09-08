import { findSiteByApiDomain } from "../services/api-hosts.js";

// ─────────────────────────────────────────────────────────────────────────
// Vhost API dedicato: se req.hostname corrisponde a un sites.api_domain
// configurato, l'INTERA richiesta viene deviata al router clone (root-level,
// es. GET /contacts invece di /v1/contacts) invece di proseguire verso gli
// altri router del CMS (pagine pubbliche, /admin, ecc.). Il router clone
// termina sempre la catena da sé (200/4xx/404 JSON): per un hostname che
// matcha, next() non viene mai chiamato oltre questo punto.
//
// Hostname che non matchano nessun api_domain: next() immediato, zero
// impatto sul routing esistente.
// ─────────────────────────────────────────────────────────────────────────

export function apiHostMiddleware(apiCloneRouter) {
  return async (req, res, next) => {
    let site;
    try {
      site = await findSiteByApiDomain(req.hostname);
    } catch (err) {
      return next(err);
    }
    if (!site) return next();

    req.tenantApi = { site };
    apiCloneRouter(req, res, next);
  };
}
