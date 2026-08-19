import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listArticles, getArticle, createArticle, updateArticle, deleteArticle, searchKb,
} from "../services/kb.js";

// ─────────────────────────────────────────────────────────────────────────
// Route agent Knowledge base (F30): listini, FAQ, procedure.
// Registrate dal chiamante sullo stesso router agent (l'introspezione MCP
// discoverTools le vede come gli altri moduli CRM). NIENTE router.use qui:
// l'auth (requireAuth + requireAgent) è già applicata dal mount point.
// NB: route statiche (/kb/search) PRIMA delle parametriche (/:articleId).
// ─────────────────────────────────────────────────────────────────────────
export function registerKbRoutes(router) {
  // ── Ricerca full-text (statica: prima di /:articleId) ─────────────────
  router.get("/api/agent/sites/:siteId/kb/search", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const results = await searchKb(siteId, req.query.q, {
        category: req.query.category,
        limit: req.query.limit,
      });
      res.json({ results });
    } catch (err) { next(err); }
  });

  // ── Elenco articoli (filtro category, paginazione limit/offset) ───────
  router.get("/api/agent/sites/:siteId/kb", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const articles = await listArticles(siteId, {
        category: req.query.category,
        limit: req.query.limit,
        offset: req.query.offset,
      });
      res.json({ articles });
    } catch (err) { next(err); }
  });

  // ── Creazione articolo ─────────────────────────────────────────────────
  router.post("/api/agent/sites/:siteId/kb", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      if (!String(req.body.title || "").trim()) {
        return res.status(400).json({ error: "Titolo obbligatorio" });
      }
      const article = await createArticle(siteId, {
        title: req.body.title,
        content: req.body.content,
        category: req.body.category,
        tags: req.body.tags,
      });
      res.json({ article });
    } catch (err) { next(err); }
  });

  // ── Dettaglio singolo articolo ─────────────────────────────────────────
  router.get("/api/agent/sites/:siteId/kb/:articleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const article = await getArticle(siteId, req.params.articleId);
      if (!article) return res.status(404).json({ error: "Articolo non trovato" });
      res.json({ article });
    } catch (err) { next(err); }
  });

  // ── Modifica articolo ──────────────────────────────────────────────────
  router.put("/api/agent/sites/:siteId/kb/:articleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const article = await updateArticle(siteId, req.params.articleId, {
        title: req.body.title,
        content: req.body.content,
        category: req.body.category,
        tags: req.body.tags,
      });
      if (!article) return res.status(404).json({ error: "Articolo non trovato" });
      res.json({ article });
    } catch (err) { next(err); }
  });

  // ── Eliminazione articolo ──────────────────────────────────────────────
  router.delete("/api/agent/sites/:siteId/kb/:articleId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteArticle(siteId, req.params.articleId);
      if (!deleted) return res.status(404).json({ error: "Articolo non trovato" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });
}
