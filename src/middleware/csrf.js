const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Protezione CSRF via verifica Origin/Referer. Si applica solo alle richieste
// autenticate via cookie (sessione browser): le chiamate agent usano JWT via
// header Authorization, non sono soggette a CSRF (un sito terzo non può
// impostare header custom su una richiesta cross-site "semplice") e vengono
// escluse esplicitamente.
export function csrfProtection(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();
  // Esenzione SOLO quando l'identità viene dall'header Authorization (API
  // agent/n8n: un sito terzo non può impostare header custom su una richiesta
  // cross-site "semplice"). Se c'è ANCHE il cookie, requireAuth autentica col
  // cookie (auth.js:8 dà precedenza al cookie) → la richiesta è una sessione
  // browser e DEVE passare la verifica Origin. Prima esentavamo con un header
  // Authorization qualunque (anche bogus) mentre l'utente era autenticato dal
  // cookie: bypass CSRF per richieste con cookie+header insieme.
  if (req.headers.authorization && !req.cookies?.token) return next();
  if (!req.cookies?.token) return next();

  const host = req.get("host");
  const sourceHeader = req.headers.origin || req.headers.referer;
  if (!sourceHeader) {
    // Richiesta state-changing autenticata via cookie senza alcun header di
    // origine: prima passava (next()), lasciando la verifica Origin/Referer
    // come unica difesa aggirabile da client che omettono gli header. Un
    // browser moderno invia sempre Origin su POST/PUT/DELETE; rifiuta.
    const message = res.locals.t("api.csrf.invalidOrigin");
    if (req.path.startsWith("/api")) return res.status(403).json({ error: message });
    return res.status(403).render("error", { message });
  }

  let sourceHost;
  try {
    sourceHost = new URL(sourceHeader).host;
  } catch {
    sourceHost = null;
  }

  if (sourceHost !== host) {
    const message = res.locals.t("api.csrf.invalidOrigin");
    if (req.path.startsWith("/api")) return res.status(403).json({ error: message });
    return res.status(403).render("error", { message });
  }

  next();
}
