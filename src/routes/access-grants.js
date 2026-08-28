import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { PROTECTED_ROOT, saveProtectedBuffer } from "../services/media-utils.js";
import { createAccessGrant, listAccessGrants, revokeAccessGrant } from "../services/access-grants.js";
import { formatBytes } from "../services/format.js";

const router = Router();

const MAX_SIZE = 20 * 1024 * 1024;
const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|svg|mp4|mp3|pdf|zip|mov|m4v)$/i;

// Upload in memoria (il buffer va scritto in media-protected da
// saveProtectedBuffer con naming timestamp-hash.ext, mai con un nome utente).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_EXT.test(file.originalname)) {
      return cb(new Error("Tipo file non consentito"));
    }
    cb(null, true);
  },
});

// Stesso pattern di src/routes/media.js: non-superadmin → SOLO il proprio
// site_id (mai Host header); superadmin → ?site_id= (o il primo sito).
function resolveSiteId(req) {
  const isSuperadmin = req.user?.role === "superadmin";
  let siteId = isSuperadmin && req.query.site_id
    ? parseInt(req.query.site_id, 10)
    : req.user?.site_id;
  if (!siteId && isSuperadmin) {
    return query("SELECT id FROM sites ORDER BY id LIMIT 1").then(rows => rows.rows[0]?.id || null);
  }
  return Promise.resolve(siteId || null);
}

function listProtectedFiles(siteId) {
  const dir = path.join(PROTECTED_ROOT, String(siteId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => !name.endsWith(".tmp.mp4") && !name.endsWith(".alt.txt"))
    .map(name => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        name,
        media_path: name,
        size: stat.size,
        size_formatted: formatBytes(stat.size),
        mtime: stat.mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function parseExpiry(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

router.get("/admin/access-grants", requireAuth, resolveSite, async (req, res, next) => {
  try {
    const siteId = await resolveSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];

    const grants = await listAccessGrants(siteId, { email: req.query.email || null });
    const files = listProtectedFiles(siteId);
    res.render("admin/access-grants/index", { grants, files, site, sites, selectedSiteId: siteId });
  } catch (err) { next(err); }
});

router.post("/admin/access-grants", requireAuth, resolveSite, upload.single("file"), async (req, res, next) => {
  try {
    const siteId = await resolveSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });

    let mediaPath = String(req.body.media_path || "").trim();
    if (req.file) {
      // Upload diretto in media-protected: naming timestamp-hash.ext
      const ext = path.extname(req.file.originalname).replace(/^\./, "").toLowerCase();
      const saved = saveProtectedBuffer(siteId, req.file.buffer, ext);
      mediaPath = saved.media_path;
    }
    if (!mediaPath) {
      return res.status(400).render("error", { message: "Seleziona un file esistente o carica un nuovo file" });
    }

    const grant = await createAccessGrant(siteId, {
      email: req.body.email,
      mediaPath,
      expiresAt: parseExpiry(req.body.expires_at),
      maxUses: req.body.max_uses,
      source: "manual",
      createdBy: req.user.id,
    });
    if (!grant) return res.status(400).render("error", { message: "Percorso file non valido" });

    res.redirect(`/admin/access-grants?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.post("/admin/access-grants/:id/revoke", requireAuth, resolveSite, async (req, res, next) => {
  try {
    const siteId = await resolveSiteId(req);
    if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
    await revokeAccessGrant(siteId, req.params.id);
    res.redirect(`/admin/access-grants?site_id=${siteId}`);
  } catch (err) { next(err); }
});

export default router;