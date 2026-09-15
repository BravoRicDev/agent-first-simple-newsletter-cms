// ─────────────────────────────────────────────────────────────────────────
// Scope enforcement per i token API (agtok_).
//
// Un agtok_ nasce read-only o read+write a scelta dell'admin (vedi
// services/api-tokens.js). Questo middleware protegge gli endpoint di
// SCrittura esposti ai satelliti/automazioni: un token senza scope "write"
// riceve 403 anche se il ruolo RBAC del suo utente consentirebbe l'azione.
//
// Le sessioni browser/JWT NON vengono filtrate qui: hanno già il controllo
// permessi completo via authorize()/RBAC, e non c'è alcun scope da onorare.
// ─────────────────────────────────────────────────────────────────────────

export function requireTokenWrite(req, res, next) {
  // Solo per richieste autenticate con API token: le sessioni interattive
  // passano sempre (il loro perimetro è definito dal ruolo/RBAC).
  if (!req.user?.api_token) return next();

  const scopes = Array.isArray(req.user.scopes) ? req.user.scopes : [];
  if (!scopes.includes("write")) {
    return res.status(403).json({
      error: "token_scope_required",
      required_scope: "write",
      message: "Questo API token è in sola lettura: rigeneralo con i permessi di scrittura abilitati.",
    });
  }
  next();
}
