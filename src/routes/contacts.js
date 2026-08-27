import { Router } from "express";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorize } from "../middleware/authorize.js";
import { aggregateContacts, getContactTimeline, setContactFields, listTags } from "../services/contacts.js";
import { listContactNotes, listConversations } from "../services/conversations.js";
import { PIPELINE_STAGES } from "../constants/pipeline.js";
import { listCallsForContact } from "../services/calls.js";
import { exportContactData, eraseContactData } from "../services/privacy.js";
import { auditLog } from "../services/audit.js";

const router = Router();

function parseTags(raw) {
  return String(raw || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean)
    .filter((t, i, arr) => arr.indexOf(t) === i)
    .slice(0, 20);
}

function parseValueEstimate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Stesso permesso di "forms": i contatti sono una vista derivata dagli
// stessi dati (form_submissions), non una risorsa a parte da gestire in RBAC.
router.get("/admin/contacts", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    let siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId && isSuperadmin) siteId = sites[0]?.id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const tagFilter = (req.query.tag || "").trim() || null;
    const [contacts, tags] = await Promise.all([
      aggregateContacts(siteId, { tag: tagFilter }),
      listTags(siteId),
    ]);

    res.render("admin/contacts/index", { contacts, site, sites, siteId, tags, tagFilter, erased: req.query.erased === "1" });
  } catch (err) { next(err); }
});

router.get("/admin/contacts/:email", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const { timeline, contact } = await getContactTimeline(siteId, req.params.email);
    // Un contatto può esistere senza invii (aggiunto a mano dal modulo
    // pipeline): il 404 va deciso sulla riga contacts, non sulla timeline.
    const normalized = req.params.email.trim().toLowerCase();
    const exists = timeline.length > 0 || (await query(
      "SELECT 1 FROM contacts WHERE site_id = $1 AND email = $2", [siteId, normalized]
    )).rows.length > 0;
    if (!exists) return res.status(404).render("error", { message: "Contatto non trovato." });

    const calls = res.locals.enabledModules?.includes("call_scheduling")
      ? await listCallsForContact(siteId, req.params.email)
      : null;

    const [notes, conversations] = await Promise.all([
      listContactNotes(siteId, req.params.email),
      listConversations(siteId, { email: req.params.email }),
    ]);

    res.render("admin/contacts/detail", { email: req.params.email, timeline, contact, siteId, saved: req.query.saved === "1", pipelineStages: PIPELINE_STAGES, calls, notes, conversations });
  } catch (err) { next(err); }
});

// ── Note lead (dal dettaglio contatto) ───────────────────────────────────

router.post("/admin/contacts/:email/notes", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const body = String(req.body.body || "").trim();
    if (body) {
      const { addContactNote } = await import("../services/conversations.js");
      await addContactNote(siteId, req.params.email, {
        body,
        authorType: req.user.role === "agent" ? "agent" : "human",
        authorName: req.user.name || (req.user.role === "agent" ? "Agente AI" : ""),
      });
    }
    res.redirect(`/admin/contacts/${encodeURIComponent(req.params.email)}?site_id=${siteId}&saved=1#note`);
  } catch (err) { next(err); }
});

router.post("/admin/contacts/:email/notes/:noteId/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const { deleteContactNote } = await import("../services/conversations.js");
    await deleteContactNote(siteId, req.params.noteId);
    res.redirect(`/admin/contacts/${encodeURIComponent(req.params.email)}?site_id=${siteId}&saved=1#note`);
  } catch (err) { next(err); }
});

router.post("/admin/contacts/:email", requireAuth, authorize("forms", "update"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const tags = parseTags(req.body.tags);
    const status = String(req.body.status || "").trim().slice(0, 100);
    const notes = String(req.body.notes || "").trim().slice(0, 5000);
    const value_estimate = parseValueEstimate(req.body.value_estimate);

    await setContactFields(siteId, req.params.email, { tags, status, notes, value_estimate });
    res.redirect(`/admin/contacts/${encodeURIComponent(req.params.email)}?site_id=${siteId}&saved=1`);
  } catch (err) { next(err); }
});

// ── Diritti GDPR (accesso/portabilità, cancellazione) ──────────────────────

router.get("/admin/contacts/:email/export", requireAuth, authorize("forms", "read"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.query.site_id ? parseInt(req.query.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const data = await exportContactData(siteId, req.params.email);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.email)}.json"`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { next(err); }
});

router.post("/admin/contacts/:email/delete", requireAuth, authorize("forms", "delete"), async (req, res, next) => {
  try {
    const isSuperadmin = req.user.role === "superadmin";
    const siteId = isSuperadmin && req.body.site_id ? parseInt(req.body.site_id, 10) : req.user.site_id;
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const normalized = req.params.email.trim().toLowerCase();
    const deleted = await eraseContactData(siteId, normalized);

    await auditLog({
      userId: req.user.sub, siteId,
      entityType: "contact", action: "gdpr_erase",
      oldData: { email: normalized, deleted },
      ipAddress: req.ip,
    });

    res.redirect(`/admin/contacts?site_id=${siteId}&erased=1`);
  } catch (err) { next(err); }
});

export default router;
