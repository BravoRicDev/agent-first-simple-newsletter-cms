import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import {
  listDefinitions,
  createDefinition,
  updateDefinition,
  deleteDefinition,
  runSandboxTest,
  listSandboxRuns,
} from "../services/agent-builder.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 31 — Admin: agent builder visuale + sandbox di test.
// Vista essenziale: tabella definizioni + form config JSON + test dry-run.
// Registrate su un router passato dal chiamante (registerAdminAgentBuilderRoutes).
// ─────────────────────────────────────────────────────────────────────────

function resolveSiteId(req) {
  const isSuperadmin = req.user.role === "superadmin";
  if (isSuperadmin && req.query.site_id) return parseInt(req.query.site_id, 10);
  return req.user.site_id;
}

export function registerAdminAgentBuilderRoutes(router) {
  router.get("/admin/agent-builder", requireAuth, authorize("forms", "read"), async (req, res, next) => {
    try {
      const isSuperadmin = req.user.role === "superadmin";
      const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
      let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
      if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
      if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

      const definitions = await listDefinitions(siteId);
      const runs = await listSandboxRuns(siteId, { limit: 20 });
      const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
      res.render("admin/crm/agent-builder", {
        definitions, runs, site, sites, siteId, isSuperadmin,
        saved: req.query.saved === "1",
        testResult: null,
        testError: null,
      });
    } catch (err) { next(err); }
  });

  router.post("/admin/agent-builder", requireAuth, authorize("forms", "update"), async (req, res, next) => {
    try {
      const isSuperadmin = req.user.role === "superadmin";
      const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
      if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

      const name = String(req.body.name || "").trim().slice(0, 255);
      if (name) {
        let config = {};
        try { config = JSON.parse(req.body.config_json || "{}"); } catch { config = {}; }
        const data = {
          name,
          description: req.body.description,
          config,
          sandbox: req.body.sandbox === "1" || req.body.sandbox === "on",
          active: req.body.active !== "0",
        };
        if (req.body.definition_id) {
          await updateDefinition(siteId, parseInt(req.body.definition_id, 10), data);
        } else {
          await createDefinition(siteId, data);
        }
      }
      res.redirect(`/admin/agent-builder?site_id=${siteId}&saved=1`);
    } catch (err) { next(err); }
  });

  router.post("/admin/agent-builder/:id/test", requireAuth, authorize("forms", "read"), async (req, res, next) => {
    try {
      const isSuperadmin = req.user.role === "superadmin";
      let siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
      if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });
      const defId = parseInt(req.params.id, 10);

      const definitions = await listDefinitions(siteId);
      const runs = await listSandboxRuns(siteId, { limit: 20 });
      const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
      const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];

      let testResult = null;
      let testError = null;
      try {
        testResult = await runSandboxTest({
          siteId,
          definitionId: defId,
          message: String(req.body.message || ""),
          contact_email: req.body.contact_email,
          channel: req.body.channel,
        });
      } catch (err) {
        testError = err.message || "Errore nel test sandbox";
      }

      res.render("admin/crm/agent-builder", {
        definitions, runs, site, sites, siteId, isSuperadmin,
        saved: false, testResult, testError,
      });
    } catch (err) { next(err); }
  });

  router.post("/admin/agent-builder/:id/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
    try {
      const isSuperadmin = req.user.role === "superadmin";
      const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
      if (siteId) await deleteDefinition(siteId, parseInt(req.params.id, 10));
      res.redirect(`/admin/agent-builder?site_id=${siteId}`);
    } catch (err) { next(err); }
  });
}
