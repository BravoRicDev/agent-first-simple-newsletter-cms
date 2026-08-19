import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import {
  listServicesCatalog, createService, updateService, deleteService,
  markClient, listClients, listClientServices, setClientService,
} from "../services/client-services.js";

const router = Router();

// ── Admin Clienti + Servizi (area clienti generica) ──────────────────────
// Pagina essenziale: lista clienti con stato, toggle servizi, catalogo.
// Il grosso dell'uso resta via API agent/MCP; qui l'accesso rapido umano.

router.get("/admin/clients", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin && sites.length > 0) siteId = sites[0].id;
    if (!siteId) return res.status(400).render("error", { message: "Sito non specificato" });

    const [clients, catalog] = await Promise.all([
      listClients(siteId),
      listServicesCatalog(),
    ]);
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    res.render("admin/crm/clients", { clients, catalog, site, sites, siteId, isSuperadmin, saved: req.query.saved === "1" });
  } catch (err) { next(err); }
});

// Marca/smarca cliente e imposta status.
router.post("/admin/clients/:contactId/mark", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    await markClient(siteId, req.params.contactId, {
      is_client: req.body.is_client === "1",
      client_status: req.body.client_status || "active",
    });
    res.redirect(`/admin/clients?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

// Attiva/disattiva un servizio per un cliente.
router.post("/admin/clients/:contactId/services/:serviceKey/set", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    await setClientService(siteId, req.params.contactId, req.params.serviceKey, req.body.active === "1");
    res.redirect(`/admin/clients?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

// Crea servizio nel catalogo.
router.post("/admin/clients/services-catalog", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    await createService(req.body || {});
    res.redirect(`/admin/clients?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

// Elimina servizio dal catalogo.
router.post("/admin/clients/services-catalog/:key/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    await deleteService(req.params.key);
    res.redirect(`/admin/clients?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

export default router;
