import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  APPROVAL_KINDS,
  enqueueApproval, listApprovals, approveApproval, rejectApproval, deleteApproval,
} from "../services/hitl.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 32 — Human-in-the-loop: coda di approvazione.
// L'agente AI enqueue un'azione sensibile, l'operatore approva/rifiuta da
// UI o API; solo all'approvazione il payload viene eseguito (task,
// messaggio out nel thread conversazioni, modifica contatto…). Stesso
// pattern di crm-agent.js: ogni route verifica canAccessSite e passa gli
// errori a next(err). L'auth (requireAuth + requireAgent) è applicata dal
// router padre — qui NON ripetiamo router.use('/api/agent', ...).
// ─────────────────────────────────────────────────────────────────────────

export function registerHitlRoutes(router) {
  // ── Coda di approvazione ───────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/approvals", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const approvals = await listApprovals(siteId, {
        status: req.query.status, kind: req.query.kind,
        limit: req.query.limit, offset: req.query.offset,
      });
      res.json({ approvals });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/approvals", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const kind = String(req.body.kind || "custom");
      if (!APPROVAL_KINDS.includes(kind)) return res.status(400).json({ error: `kind non valido: ${kind}` });
      // requested_by SEMPRE dal token autenticato, mai dal body: i token API
      // (agenti/runtime) si firmano come api:<sub>, gli umani come user:<email>.
      const requestedBy = req.user?.api_token
        ? `api:${req.user.sub}`
        : `user:${String(req.user?.email || "").trim().toLowerCase() || req.user?.sub || "unknown"}`;
      const approval = await enqueueApproval(siteId, {
        kind,
        payload: req.body.payload,
        requested_by: requestedBy,
      });
      res.json({ approval });
    } catch (err) { next(err); }
  });

  // Decisore: identità costruita DAL TOKEN (mai dal body). Solo umani
  // admin/superadmin possono approvare/rifiutare; auto-approvazione vietata.
  function actorFromUser(user) {
    return {
      sub: user?.sub,
      email: user?.email,
      role: user?.role,
      apiToken: user?.api_token === true,
    };
  }

  function sendDecisionError(res, result) {
    if (result.forbidden) return res.status(403).json({ error: result.forbidden });
    if (result.notFound) return res.status(404).json({ error: "Approvazione non trovata" });
    if (result.selfApproval) return res.status(403).json({ error: "Auto-approvazione non consentita", approval: result.approval });
    return null;
  }

  router.post("/api/agent/sites/:siteId/approvals/:approvalId/approve", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await approveApproval(siteId, req.params.approvalId, actorFromUser(req.user));
      const errRes = sendDecisionError(res, result);
      if (errRes) return errRes;
      if (result.conflict) return res.status(409).json({ error: "Approvazione già decisa", approval: result.approval });
      res.json({ approval: result.approval, action_error: result.action_error || null });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/approvals/:approvalId/reject", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const result = await rejectApproval(siteId, req.params.approvalId, actorFromUser(req.user));
      const errRes = sendDecisionError(res, result);
      if (errRes) return errRes;
      if (result.conflict) return res.status(409).json({ error: "Approvazione già decisa", approval: result.approval });
      res.json({ approval: result.approval });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/approvals/:approvalId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const deleted = await deleteApproval(siteId, req.params.approvalId);
      if (!deleted) return res.status(404).json({ error: "Approvazione non trovata" });
      res.json({ deleted: parseInt(req.params.approvalId, 10) });
    } catch (err) { next(err); }
  });
}
