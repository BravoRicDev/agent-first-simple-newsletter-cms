import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessSite, requireAgent } from "./agent-helpers.js";
import {
  listServicesCatalog, createService, updateService, deleteService,
  markClient, listClients, getClient,
  listClientServices, setClientService,
  checkClientAccess, checkClientAccessByEmail,
} from "../services/client-services.js";

// ─────────────────────────────────────────────────────────────────────────
// Route agent "Clienti + Servizi" (area clienti GENERICA).
// Registrate su agentRouter: l'introspezione MCP (discoverTools) le vede
// automaticamente; TOOL_META in mcp-tools.js aggiunge le descrizioni.
//
// Uso previsto:
//   - admin/agente: catalogo servizi, marca clienti, attiva/disattiva
//   - servizio ESTERNO (area clienti dedicata): checkClientAccess /
//     access-by-email per sapere se un cliente può usare un servizio
// ─────────────────────────────────────────────────────────────────────────

export function registerClientServicesRoutes(router) {
  router.use("/api/agent", requireAuth, requireAgent);

  // ── Catalogo servizi ──────────────────────────────────────────────────

  router.get("/api/agent/sites/:siteId/services-catalog", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      res.json({ services: await listServicesCatalog() });
    } catch (err) { next(err); }
  });

  router.post("/api/agent/sites/:siteId/services-catalog", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const service = await createService(req.body || {});
      res.json({ service });
    } catch (err) { next(err); }
  });

  router.patch("/api/agent/sites/:siteId/services-catalog/:key", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const service = await updateService(req.params.key, req.body || {});
      res.json({ service });
    } catch (err) { next(err); }
  });

  router.delete("/api/agent/sites/:siteId/services-catalog/:key", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      res.json(await deleteService(req.params.key));
    } catch (err) { next(err); }
  });

  // ── Clienti ───────────────────────────────────────────────────────────

  // Variante per email: /clients/access-by-email?email=...&service=...
  // Route STATICA PRIMA delle parametriche :contactId (ordine express):
  // se stesse dopo, "access-by-email" verrebbe interpretato come contactId.
  router.get("/api/agent/sites/:siteId/clients/access-by-email", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const { email, service } = req.query;
      if (!email || !service) return res.status(400).json({ error: "email e service obbligatori" });
      res.json(await checkClientAccessByEmail(siteId, email, service));
    } catch (err) { next(err); }
  });

  // Lista clienti (status opzionale: active|suspended|inactive).
  router.get("/api/agent/sites/:siteId/clients", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const clients = await listClients(siteId, { status: req.query.status });
      res.json({ clients });
    } catch (err) { next(err); }
  });

  // Dettaglio cliente (con servizi attivi).
  router.get("/api/agent/sites/:siteId/clients/:contactId", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const client = await getClient(siteId, req.params.contactId);
      if (!client) return res.status(404).json({ error: "Cliente non trovato" });
      res.json({ client });
    } catch (err) { next(err); }
  });

  // Marca/smarca contatto come cliente.
  router.post("/api/agent/sites/:siteId/clients/:contactId/mark", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const client = await markClient(siteId, req.params.contactId, req.body || {});
      res.json({ client });
    } catch (err) { next(err); }
  });

  // ── Servizi del cliente ───────────────────────────────────────────────

  // Lista servizi del catalogo con stato per questo cliente.
  router.get("/api/agent/sites/:siteId/clients/:contactId/services", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const services = await listClientServices(siteId, req.params.contactId);
      res.json({ services });
    } catch (err) { next(err); }
  });

  // Attiva/disattiva un servizio per il cliente: body { active: bool, config?: object }.
  router.post("/api/agent/sites/:siteId/clients/:contactId/services/:serviceKey/set", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      const assignment = await setClientService(
        siteId,
        req.params.contactId,
        req.params.serviceKey,
        req.body?.active,
        req.body?.config ?? null
      );
      res.json({ assignment });
    } catch (err) { next(err); }
  });

  // ── Verifica accesso (per il servizio esterno) ────────────────────────

  // GET /clients/:contactId/access/:serviceKey → { has_access, reason, ... }
  router.get("/api/agent/sites/:siteId/clients/:contactId/access/:serviceKey", requireAgent, async (req, res, next) => {
    try {
      const siteId = parseInt(req.params.siteId, 10);
      if (!await canAccessSite(req.user, siteId)) return res.status(403).json({ error: "Accesso negato" });
      res.json(await checkClientAccess(siteId, req.params.contactId, req.params.serviceKey));
    } catch (err) { next(err); }
  });
}
