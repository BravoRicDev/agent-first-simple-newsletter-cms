import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { getKpis, listViews } from "../services/dashboard.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 40 — Dashboard realtime CRM: vista admin con KPI live (lead per
// canale, valore pipeline, SLA task, conversazioni) e viste salvabili.
// Pattern identico a admin-crm.js. NON montata qui: lo fa il padre
// (index.js) — export della funzione di registrazione + router default.
// ─────────────────────────────────────────────────────────────────────────

const RANGES = ["7d", "30d", "90d"];

export function registerAdminDashboardRoutes(router) {
  // NOTA: path dedicato /admin/dashboard-crm. La "Dashboard realtime CRM"
  // era registrata su /admin/dashboard, ma src/routes/serve.js ha la STESSA
  // route ed è montata PRIMA (index.js) → la vinceva sempre, rendendo questa
  // vista irraggiungibile (dead code). Path dedicato = nessuno shadowing.
  router.get("/admin/dashboard-crm", requireAuth, authorize("analytics", "read"), async (req, res, next) => {
    try {
      const isSuperadmin = req.user.role === "superadmin";
      const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
      let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
      if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
      if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

      const range = RANGES.includes(req.query.range) ? req.query.range : "30d";
      const kpis = await getKpis(siteId, { range });
      const views = await listViews(siteId);
      const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
      res.render("admin/crm/dashboard", { kpis, views, site, sites, siteId, isSuperadmin, range });
    } catch (err) { next(err); }
  });
}

// Router pronto all'uso (stesso pattern di admin-crm.js: default export).
const router = Router();
registerAdminDashboardRoutes(router);
export default router;
