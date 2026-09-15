import { Router } from "express";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  createAccessGrant,
  listAccessGrants,
  revokeAccessGrant,
} from "../services/access-grants.js";

// ─────────────────────────────────────────────────────────────────────────
// R1 — Route agent per i permessi di accesso a contenuti protetti.
//
// CRUD minimo (lista, crea, revoca) così l'automazione esterna può emettere
// permessi nominativi (challenge 7 giorni = expires_at, acquisto =
// source='purchase'). NIENTE router.use qui: l'auth (requireAuth +
// requireAgent) è applicata dal mount point (stesso pattern di
// agent-tracked-links.js), quindi ogni route richiede requireAgent e
// verifica canAccessSite. L'introspezione MCP (discoverTools) le vede
// automaticamente perché registrate sullo stesso router agent.
// ─────────────────────────────────────────────────────────────────────────

export function registerAccessGrantsRoutes(router) {
  // ── Elenco permessi (filtro email) ─────────────────────────────────────
  router.get("/api/agent/sites/:siteId/access-grants", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const access_grants = await listAccessGrants(siteId, { email: req.query.email || null });
      res.json({ access_grants });
    } catch (err) { next(err); }
  });

  // ── Creazione permesso (ritorna il grant CON l'url completo) ───────────
  router.post("/api/agent/sites/:siteId/access-grants", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const body = req.body || {};
      const grant = await createAccessGrant(siteId, {
        email: body.email,
        mediaPath: body.mediaPath !== undefined ? body.mediaPath : body.media_path,
        expiresAt: body.expiresAt !== undefined ? body.expiresAt : body.expires_at,
        maxUses: body.maxUses !== undefined ? body.maxUses : body.max_uses,
        source: body.source,
        createdBy: req.user.id,
      });
      if (!grant) return res.status(400).json({ error: "mediaPath valido obbligatorio" });
      res.json({ access_grant: { ...grant, url: `/shared/${grant.token}` } });
    } catch (err) { next(err); }
  });

  // ── Revoca permesso ────────────────────────────────────────────────────
  router.delete("/api/agent/sites/:siteId/access-grants/:grantId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await revokeAccessGrant(siteId, req.params.grantId);
      if (!deleted) return res.status(404).json({ error: "Permesso di accesso non trovato" });
      res.json({ deleted: true });
    } catch (err) { next(err); }
  });
}

// Router autonomo esportato per i test (montato con requireAuth +
// requireAgent su un router locale) e per chi preferisce app.use(...).
export const accessGrantsAgentRouter = Router();
registerAccessGrantsRoutes(accessGrantsAgentRouter);