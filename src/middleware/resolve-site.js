import { query } from "../db.js";

// Hostname plausibile (stesso pattern di serve.js resolvePublicBaseUrl): blocca
// caratteri pericolosi in req.hostname prima che finisca in query/wildcard
// lookup. Il multi-tenant serve host arbitrari noti, quindi niente allowlist:
// solo difesa contro hostname malformati (spazi, /, .., ecc.) che altrimenti
// alimenterebbero il fallback wildcard o query senza senso.
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i;

export async function resolveSite(req, res, next) {
  const host = req.hostname || "";
  if (!HOSTNAME_RE.test(host)) {
    req.site = null;
    res.locals.site = null;
    return next();
  }
  try {
    let result = await query(
      `SELECT s.id, s.name, s.domain, s.layout_template, s.homepage_path
       FROM sites s
       JOIN site_domains sd ON sd.site_id = s.id
       WHERE sd.domain = $1`,
      [host]
    );

    // Fallback: prova pattern wildcard (*.dominio)
    if (result.rows.length === 0 && host.includes(".")) {
      const parts = host.split(".");
      if (parts.length >= 3) {
        const wildcardHost = "*." + parts.slice(1).join(".");
        result = await query(
          `SELECT s.id, s.name, s.domain, s.layout_template, s.homepage_path
           FROM sites s
           JOIN site_domains sd ON sd.site_id = s.id
           WHERE sd.domain = $1`,
          [wildcardHost]
        );
      }
    }

    if (result.rows.length > 0) {
      req.site = result.rows[0];
      res.locals.site = result.rows[0];
    } else {
      req.site = null;
      res.locals.site = null;
    }
  } catch {
    req.site = null;
    res.locals.site = null;
  }
  next();
}
