// ─────────────────────────────────────────────────────────────────────────
// Body validation per la surface /v1 API-compatibile ( "API compatibili con
// CRM diffusi" ).
//
// Middleware da montare DOPO requireTenant() ma PRIMA delle route specifiche.
// - POST/PUT: verifica Content-Type application/json, body non vuoto.
// - DELETE: non richiede body, nessuna validazione.
// - GET: nessuna validazione.
// ─────────────────────────────────────────────────────────────────────────

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

export function v1BodyValidator() {
  return (req, res, next) => {
    // GET e DELETE non hanno body significativo
    if (req.method === "GET" || req.method === "DELETE") {
      return next();
    }

    // POST e PUT: verifica Content-Type. Oltre a JSON/urlencoded, la route
    // /v1/import accetta multipart/form-data (upload CSV/JSON) e text/csv
    // (body CSV grezzo): qui vengono solo tollerati (il parsing lo fa la
    // route/multer), non validati come JSON.
    const contentType = (req.get("Content-Type") || "").toLowerCase().trim();
    const isJsonLike = contentType.includes("application/json") || contentType.includes("application/x-www-form-urlencoded");
    const isUpload = contentType.includes("multipart/form-data") || contentType.includes("text/csv");
    if (contentType && !isJsonLike && !isUpload) {
      return res.status(415).json({ error: "Content-Type deve essere application/json (o multipart/text/csv per /v1/import)" });
    }

    // POST: body non vuoto (per multipart/text-csv il body è gestito
    // dalla route, qui non lo blocchiamo se è un upload di file)
    if (req.method === "POST" && isJsonLike) {
      const body = req.body;
      if (body === undefined || body === null || body === "") {
        return res.status(400).json({ error: "Body JSON richiesto" });
      }
      // Se e' un oggetto vuoto o array vuoto, alcune route lo accettano
      // (es. GET /custom-fields con query params). Non blocchiamo oggetti
      // vuoti per non rompere compatibilita.
    }

    // Limite dimensione body
    try {
      const bodyStr = typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body || {});
      if (bodyStr && Buffer.byteLength(bodyStr, "utf8") > MAX_BODY_SIZE) {
        return res.status(413).json({ error: "Body troppo grande (max 1MB)" });
      }
    } catch {
      // Se stringify fallisce, il body e' gia troppo complesso -> passa
    }

    next();
  };
}