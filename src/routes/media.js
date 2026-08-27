import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileTypeFromBuffer } from "file-type";

const execFileAsync = promisify(execFile);
import { fileURLToPath } from "url";
import { query } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveSite } from "../middleware/resolve-site.js";
import { formatBytes } from "../services/format.js";
import { safeFetch } from "../services/ssrf.js";
import { sanitizeSvgBuffer, sanitizeSvgFileIfNeeded } from "../services/svg-sanitize.js";
import { logger } from "../services/logger.js";
import config from "../config.js";

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_ROOT = path.resolve(__dirname, "../../media");

const ALLOWED_EXT = /\.(jpg|jpeg|png|gif|webp|svg|mp4|mp3|pdf|zip|woff|woff2|ttf|otf|eot|ico|mov)$/i;
const MAX_SIZE = 20 * 1024 * 1024;
const MB_PER_MINUTE = 60;

// jpg/jpeg sono lo stesso formato; .mov e .mp4 condividono lo stesso
// container ISO-BMFF, quindi file-type può riportare l'uno per l'altro.
const MAGIC_BYTES_ALIASES = { jpg: ["jpg", "jpeg"], jpeg: ["jpg", "jpeg"], mov: ["mov", "mp4", "m4v"] };
// SVG è testo (nessuna firma binaria): verificato a parte sotto. EOT è un
// formato font legacy non riconosciuto da file-type — resta protetto solo
// dalla whitelist di estensione.
const MAGIC_BYTES_SKIP = new Set(["eot"]);

// Verifica che il contenuto reale del file corrisponda all'estensione
// dichiarata (oltre al controllo, bypassabile, sul nome file) — impedisce
// di caricare un eseguibile/HTML rinominato con estensione innocua.
export async function verifyMagicBytes(buffer, declaredExt) {
  const ext = declaredExt.replace(/^\./, "").toLowerCase();
  if (ext === "svg") {
    const head = buffer.toString("utf8", 0, 500).replace(/^﻿/, "").trimStart();
    return /^(<\?xml|<svg)/i.test(head);
  }
  if (MAGIC_BYTES_SKIP.has(ext)) return true;
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected) return false;
  const accepted = MAGIC_BYTES_ALIASES[ext] || [ext];
  return accepted.includes(detected.ext);
}

const CACHE_TTL = 3600000;
const urlCache = new Map();
const hashCache = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of urlCache) {
    if (val._cachedAt && now - val._cachedAt > CACHE_TTL) urlCache.delete(key);
  }
  for (const [key, val] of hashCache) {
    if (val._cachedAt && now - val._cachedAt > CACHE_TTL) hashCache.delete(key);
  }
}, 60000);

export async function compressVideo(filePath) {
  const isVideo = /\.mp4$/i.test(filePath);
  if (!isVideo) return;

  let duration = 0;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ], { timeout: 60000 });
    duration = parseFloat(stdout.trim()) || 0;
  } catch (err) {
    logger.error(`ffprobe failed, skipping compression: ${filePath}`, { error: err.message });
    return;
  }

  if (duration <= 0) return;

  const durationMinutes = duration / 60;
  const targetSizeBytes = durationMinutes * MB_PER_MINUTE * 1024 * 1024;
  const currentSize = fs.statSync(filePath).size;

  if (currentSize <= targetSizeBytes) return;

  const targetBitrateKbps = Math.floor((targetSizeBytes * 8) / duration / 1000);
  const audioBitrateKbps = 128;
  const videoBitrateKbps = Math.max(200, targetBitrateKbps - audioBitrateKbps);

  const tmpPath = filePath + ".tmp.mp4";
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-i", filePath,
      "-c:v", "libx264", "-preset", "fast", "-crf", "28",
      "-maxrate", `${videoBitrateKbps}k`,
      "-bufsize", `${videoBitrateKbps * 2}k`,
      "-c:a", "aac", "-b:a", `${audioBitrateKbps}k`,
      "-movflags", "+faststart",
      tmpPath,
    ], { timeout: 600000 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    logger.error(`Video compression failed: ${filePath}`, { error: err.message });
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

export function getSiteDir(siteId) {
  return path.join(MEDIA_ROOT, String(siteId));
}

export function ensureSiteDir(siteId) {
  const dir = getSiteDir(siteId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveBufferToMedia(siteId, buffer, ext) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const dir = getSiteDir(siteId);

  // Cache per-sito: la chiave include siteId, altrimenti due siti che
  // importano lo stesso contenuto condividono l'entry e il secondo riceve
  // l'URL del primo sito (/media/<site1>/...) — riferimento cross-site.
  const cached = hashCache.get(`${siteId}:${hash}`);
  if (cached) {
    const filePath = path.join(dir, cached.filename);
    if (fs.existsSync(filePath)) {
      return { ...cached, reused: true };
    }
  }

  // Estensione da whitelist di caratteri: se ext contenesse "/" o "..",
  // path.join uscirebbe dalla directory del sito (path traversal).
  const cleanExt = String(ext || "").replace(/^\./, "").replace(/[^a-zA-Z0-9+.-]/g, "");
  const filename = `${Date.now()}_${hash.slice(0, 8)}.${cleanExt || "bin"}`;
  ensureSiteDir(siteId);
  const toWrite = cleanExt.toLowerCase() === "svg" ? sanitizeSvgBuffer(buffer) : buffer;
  fs.writeFileSync(path.join(dir, filename), toWrite);

  const result = { filename, url: `/media/${siteId}/${filename}`, size: toWrite.length, size_formatted: formatBytes(toWrite.length), hash, reused: false, _cachedAt: Date.now() };
  hashCache.set(`${siteId}:${hash}`, result);
  return result;
}

export async function fetchUrlToMedia(siteId, remoteUrl, force = false) {
  // Normalizza URL Google Drive in URL di download diretto
  let fetchUrl = remoteUrl;
  let gdriveId = null;
  const gdriveMatch = remoteUrl.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (gdriveMatch) {
    gdriveId = gdriveMatch[1];
    fetchUrl = `https://drive.google.com/uc?export=download&id=${gdriveId}`;
  }

  const dir = getSiteDir(siteId);

  // Cache check (cache per-sito, vedi saveBufferToMedia)
  const urlCached = urlCache.get(`${siteId}:${remoteUrl}`);
  if (urlCached) {
    const filePath = path.join(dir, urlCached.filename);
    if (fs.existsSync(filePath)) {
      return { ...urlCached, reused: true, deduped: false };
    }
  }

  // Valida estensione
  const parsed = new URL(remoteUrl);
  const rawName = gdriveId ? `gdrive_${gdriveId}` : (path.basename(parsed.pathname) || "file");
  const safe = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
  const ext = path.extname(safe).toLowerCase();

  // Controllo rapido pre-fetch (best-effort, basato sull'URL); il controllo
  // definitivo avviene più sotto sul nome file reale prima di scriverlo su disco.
  if (ext && !ALLOWED_EXT.test(safe)) throw new Error("Tipo file non consentito: " + ext);

  let buffer;
  let gdriveRealName = null;
  let response = null;

  // Google Drive: usa gdown (gestisce conferma antivirus, cookie, etc.)
  if (gdriveId) {
    // Suffisso univoco: due richieste concorrenti per lo stesso gdriveId
    // condividerebbero la stessa tmp dir → files[0] non deterministico e
    // rmSync dell'una cancellerebbe i file dell'altra (ENOENT).
    const tmpDir = path.join(dir, `.gdrive_tmp_${gdriveId}_${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      await execFileAsync("gdown", [gdriveId, "-O", tmpDir], { timeout: 600000, cwd: tmpDir });
    } catch (gErr) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`Download Google Drive fallito: ${gErr.message}`);
    }
    const files = fs.readdirSync(tmpDir);
    if (files.length === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      throw new Error("Google Drive: nessun file scaricato");
    }
    const downloadedFile = files[0];
    const tmpPath = path.join(tmpDir, downloadedFile);
    buffer = fs.readFileSync(tmpPath);
    // Usa il nome originale del file da Google Drive con la sua estensione
    gdriveRealName = downloadedFile.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    // Fetch normale per URL non-Google-Drive: rivalida l'IP ad ogni hop di redirect
    response = await safeFetch(fetchUrl, {
      headers: { "User-Agent": "CMS/1.0" },
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} da ${remoteUrl}`);

    const ct = response.headers.get("content-length") || "0";
    if (!force && parseInt(ct) > MAX_SIZE) throw new Error("File troppo grande (max 20 MB)");
    // force=true toglie il limite di 20MB ("conferma esplicita"), ma serve
    // comunque un tetto duro: senza, un agente può far scaricare file di GB
    // in memoria/disco (DoS). 200MB è il tetto assoluto per ogni file.
    const ABSOLUTE_MAX = 200 * 1024 * 1024;
    if (parseInt(ct) > ABSOLUTE_MAX) throw new Error("File troppo grande (max 200 MB)");

    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
    if (!force && buffer.length > MAX_SIZE) throw new Error("File troppo grande (max 20 MB)");
    if (buffer.length > ABSOLUTE_MAX) throw new Error("File troppo grande (max 200 MB)");
  }

  // Hash dedup (cache per-sito, vedi saveBufferToMedia)
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const hashCached = hashCache.get(`${siteId}:${hash}`);
  if (hashCached) {
    const cachedPath = path.join(dir, hashCached.filename);
    if (fs.existsSync(cachedPath)) {
      urlCache.set(`${siteId}:${remoteUrl}`, hashCached);
      return { ...hashCached, reused: true, deduped: true };
    }
  }

  // Determina filename: per Google Drive usa il nome originale, per altri usa Content-Disposition
  const realName = gdriveRealName || (response ? (() => {
        const disp = response.headers.get("content-disposition") || "";
        const m = disp.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
        return m ? m[1].trim().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) : safe;
      })() : safe);
  const filename = Date.now() + "_" + (realName || `file_${hash.slice(0, 8)}`);

  // Controllo whitelist definitivo sul nome file reale (dopo Content-Disposition/nome
  // Google Drive): impedisce di salvare tipi non ammessi (es. .html/.js) anche quando
  // l'URL/percorso originale non lo lasciava intuire.
  if (!ALLOWED_EXT.test(filename)) {
    throw new Error("Tipo file non consentito: " + path.extname(filename));
  }

  // Verifica magic-bytes: il nome file (Content-Disposition, gdrive) è
  // scelto dal server remoto, non fidato quanto l'estensione da solo.
  const declaredExt = path.extname(filename).slice(1);
  if (!(await verifyMagicBytes(buffer, declaredExt))) {
    throw new Error("Il contenuto del file non corrisponde all'estensione dichiarata (" + declaredExt + ")");
  }

  // Salva (sanitizza SVG prima della scrittura: rimuove <script>/handler on*)
  ensureSiteDir(siteId);
  const destPath = path.join(dir, filename);
  const toWrite = path.extname(filename).toLowerCase() === ".svg" ? sanitizeSvgBuffer(buffer) : buffer;
  fs.writeFileSync(destPath, toWrite);

  // Compressione video in background (fire-and-forget)
  compressVideo(destPath).catch(() => {});

  // Cache e return
  const result = {
    filename,
    url: `/media/${siteId}/${filename}`,
    size: toWrite.length,
    size_formatted: formatBytes(toWrite.length),
    hash,
    reused: false,
    deduped: false,
    _cachedAt: Date.now(),
  };
  urlCache.set(`${siteId}:${remoteUrl}`, result);
  hashCache.set(`${siteId}:${hash}`, result);
  return result;
}

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const siteId = req.resolvedSiteId;
    if (!siteId) return cb(new Error("Sito non determinato"));
    cb(null, ensureSiteDir(siteId));
  },
  filename(_req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const unique = Date.now() + "_" + safe;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_EXT.test(file.originalname)) {
      return cb(new Error("Tipo file non consentito"));
    }
    cb(null, true);
  },
});

function resolveSiteId(req, res, next) {
  const isSuperadmin = req.user?.role === "superadmin";
  let siteId = isSuperadmin && req.query.site_id
    ? parseInt(req.query.site_id, 10)
    // Non-superadmin: SOLO il proprio site_id (mai Host header controllabile)
    : req.user?.site_id;
  if (!siteId && isSuperadmin) {
    return query("SELECT id FROM sites ORDER BY id LIMIT 1").then(rows => {
      siteId = rows.rows[0]?.id;
      if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
      req.resolvedSiteId = siteId;
      next();
    }).catch(next);
  }
  if (!siteId) return res.status(400).render("error", { message: res.locals.t("api.common.siteNotSpecified") });
  req.resolvedSiteId = siteId;
  next();
}

// Stessa logica già esposta all'agente AI (/api/agent/sites/:siteId/media/unused),
// prima irraggiungibile da un admin umano se non passando dall'agente: nessun
// pulsante equivalente esisteva nella UI web.
async function findUnusedMediaFiles(siteId) {
  const dir = getSiteDir(siteId);
  if (!fs.existsSync(dir)) return [];

  const mediaPattern = new RegExp(`/media/${siteId}/[^"'\\s>)]+`, "g");
  // Scansiona TUTTE le fonti che possono referenziare media: pagine, snippet,
  // variabili di sito, template, forms (html), contatti (avatar), e il subject/
  // html delle campagne newsletter. Prima scansionava solo pages.content:
  // media referenziati da snippet/variabili venivano proposti come "orfani" e
  // il cleanup all_unused=true li cancellava (data loss).
  const sources = (await query(`
    SELECT content FROM pages WHERE site_id = $1
    UNION ALL SELECT content FROM snippets WHERE site_id = $1
    UNION ALL SELECT value FROM site_variables WHERE site_id = $1
    UNION ALL SELECT layout_template FROM sites WHERE id = $1
    UNION ALL SELECT COALESCE(signature_html,'') FROM newsletter_settings WHERE site_id = $1
    UNION ALL SELECT COALESCE(html_content,'') FROM newsletter_campaigns WHERE site_id = $1
    UNION ALL SELECT COALESCE(html_content,'') FROM newsletter_sequence_steps st
      JOIN newsletter_sequences sq ON sq.id = st.sequence_id WHERE sq.site_id = $1
  `, [siteId])).rows;
  const usedUrls = new Set();
  for (const r of sources) {
    if (!r.content) continue;
    const urls = [...String(r.content).matchAll(mediaPattern)].map(m => path.basename(m[0]));
    for (const u of urls) usedUrls.add(u);
  }

  return fs.readdirSync(dir)
    .filter(name => !name.endsWith(".tmp.mp4") && !name.endsWith(".alt.txt"))
    .filter(name => !usedUrls.has(name))
    .map(name => {
      const stat = fs.statSync(path.join(dir, name));
      return { filename: name, size: stat.size, size_formatted: formatBytes(stat.size), mtime: stat.mtime };
    })
    .sort((a, b) => b.size - a.size);
}

router.get("/admin/media/unused", requireAuth, resolveSite, resolveSiteId, async (req, res, next) => {
  try {
    const siteId = req.resolvedSiteId;
    const isSuperadmin = req.user.role === "superadmin";
    const sites = isSuperadmin ? (await query("SELECT id, name FROM sites ORDER BY name")).rows : [];
    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];
    const unused = await findUnusedMediaFiles(siteId);
    res.render("admin/media/unused", { unused, site, sites, selectedSiteId: siteId });
  } catch (err) { next(err); }
});

router.post("/admin/media/cleanup", requireAuth, resolveSite, resolveSiteId, async (req, res, next) => {
  try {
    const siteId = req.resolvedSiteId;
    const dir = getSiteDir(siteId);
    let filesToDelete;
    if (req.body.all_unused === "true") {
      filesToDelete = (await findUnusedMediaFiles(siteId)).map(f => f.filename);
    } else {
      filesToDelete = [req.body.filename].filter(f => f && !f.includes("..") && !f.includes("/"));
    }
    for (const name of filesToDelete) {
      const fp = path.join(dir, name);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* continua con gli altri */ }
    }
    res.redirect(`/admin/media/unused?site_id=${siteId}`);
  } catch (err) { next(err); }
});

router.get("/admin/media", requireAuth, resolveSite, resolveSiteId, async (req, res, next) => {
  try {
    const siteId = req.resolvedSiteId;
    const isSuperadmin = req.user.role === "superadmin";

    const sites = isSuperadmin
      ? (await query("SELECT id, name FROM sites ORDER BY name")).rows
      : [];

    const site = (await query("SELECT id, name FROM sites WHERE id = $1", [siteId])).rows[0];

    const dir = getSiteDir(siteId);
    let files = [];
    if (fs.existsSync(dir)) {
      files = fs.readdirSync(dir)
        .filter(name => !name.endsWith(".tmp.mp4") && !name.endsWith(".alt.txt"))
        .map(name => {
          const stat = fs.statSync(path.join(dir, name));
          const altPath = path.join(dir, name + ".alt.txt");
          const altText = fs.existsSync(altPath) ? fs.readFileSync(altPath, "utf8").trim() : null;
          return {
            name,
            size: stat.size,
            size_formatted: formatBytes(stat.size),
            mtime: stat.mtime,
            url: `/media/${siteId}/${name}`,
            alt_text: altText,
          };
        }).sort((a, b) => b.mtime - a.mtime);
    }

    res.render("admin/media/index", { files, site, sites, selectedSiteId: siteId });
  } catch (err) { next(err); }
});

router.post("/admin/media/upload", requireAuth, resolveSite, resolveSiteId, (req, res, next) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).render("error", { message: err.message });
    if (!req.file) return res.status(400).render("error", { message: res.locals.t("api.media.noFileReceived") });

    // Verifica magic-bytes oltre all'estensione (già filtrata da multer
    // fileFilter, ma bypassabile rinominando un file arbitrario).
    const declaredExt = path.extname(req.file.filename).slice(1);
    const uploadedBuffer = fs.readFileSync(req.file.path);
    if (!(await verifyMagicBytes(uploadedBuffer, declaredExt))) {
      fs.unlinkSync(req.file.path);
      return res.status(400).render("error", { message: res.locals.t("api.media.contentMismatch") });
    }

    sanitizeSvgFileIfNeeded(req.file.path);
    await compressVideo(req.file.path);
    generateAltTextForMedia(req.file.path, req.resolvedSiteId, req.file.filename).catch(() => {});
    res.redirect(`/admin/media?site_id=${req.resolvedSiteId}`);
  });
});

async function generateAltTextForMedia(filePath, siteId, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!/\.(jpg|jpeg|png|gif|webp)$/.test(ext)) return;
  const { generateAltText } = await import("../services/llm.js");
  const buffer = fs.readFileSync(filePath);
  // Soglia: un'immagine enorme mandata all'API vision come base64 (~27MB a
  // 20MB di upload) amplifica costo e latenza su ogni upload — sopra i 5MB
  // l'alt text automatico viene saltato (il file resta caricato).
  if (buffer.length > 5 * 1024 * 1024) {
    logger.info(`Alt text skipped (immagine > 5MB): ${filename}`);
    return;
  }
  const b64 = buffer.toString("base64");
  const mimeTypes = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
  const mime = mimeTypes[ext.replace(".", "")] || "image/jpeg";
  try {
    const altText = await generateAltText(b64, mime);
    fs.writeFileSync(filePath + ".alt.txt", altText);
  } catch (err) {
    logger.error(`Alt text generation failed: ${filename}`, { error: err.message });
  }
}

router.post("/admin/media/fetch-url", requireAuth, resolveSite, resolveSiteId, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith("http")) {
      return res.status(400).render("error", { message: res.locals.t("api.common.invalidUrl") });
    }
    await fetchUrlToMedia(req.resolvedSiteId, url);
    res.redirect(`/admin/media?site_id=${req.resolvedSiteId}`);
  } catch (err) {
    // In produzione non esporre err.message (percorsi file, dettagli interni)
    const detail = config.nodeEnv === "production" ? "" : err.message;
    res.status(400).render("error", { message: res.locals.t("api.media.importFailed") + detail });
  }
});

router.post("/admin/media/:siteId/:filename/transcribe", requireAuth, async (req, res, next) => {
  try {
    // A differenza delle altre route di media.js, qui il sito è nel path
    // (:siteId), non risolto da resolveSiteId (che ignora req.params e usa solo
    // req.user.site_id/query) — un superadmin che selezionava un sito diverso
    // dal proprio otteneva sempre 400 perché resolveSiteId non vedeva il param.
    const siteId = parseInt(req.params.siteId, 10);
    if (req.user.role !== "superadmin" && siteId !== req.user.site_id) {
      return res.status(403).json({ error: res.locals.t("api.common.forbidden") });
    }
    const { filename } = req.params;
    if (filename.includes("..") || filename.includes("/"))
      return res.status(400).json({ error: res.locals.t("api.media.invalidFilename") });

    const mediaPath = path.join(getSiteDir(siteId), filename);
    if (!fs.existsSync(mediaPath))
      return res.status(404).json({ error: res.locals.t("api.media.fileNotFound") });

    const tmpWav = mediaPath + ".transcribe_tmp.wav";
    try {
      await execFileAsync("ffmpeg", ["-y","-i",mediaPath,"-ar","16000","-ac","1","-c:a","pcm_s16le",tmpWav], { timeout: 120000 });
    } catch (ffErr) {
      // In produzione niente dettagli ffmpeg interni
      const detail = config.nodeEnv === "production" ? "" : ffErr.message;
      return res.status(422).json({ error: res.locals.t("api.media.cannotExtractAudioShort") + detail });
    }

    const openaiKey = config.openaiApiKey;
    if (!openaiKey) {
      const wavFilename = path.basename(tmpWav);
      try { fs.renameSync(tmpWav, path.join(getSiteDir(siteId), wavFilename)); } catch {}
      return res.json({ text: null, error: res.locals.t("api.media.openaiNotConfiguredWav") });
    }

    const wavBuffer = fs.readFileSync(tmpWav);
    const formData = new FormData();
    formData.append("file", new Blob([wavBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("model", "whisper-1");
    formData.append("language", "it");

    const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { "Authorization": `Bearer ${openaiKey}` }, body: formData,
      signal: AbortSignal.timeout(120000),
    });
    if (!whisperRes.ok) throw new Error(`Whisper ${whisperRes.status}`);
    try { fs.unlinkSync(tmpWav); } catch {}
    const data = await whisperRes.json();
    res.json({ text: data.text });
  } catch (err) { next(err); }
});

router.post("/admin/media/delete", requireAuth, resolveSite, resolveSiteId, (req, res, next) => {
  try {
    const { filename } = req.body;
    if (!filename || filename.includes("..") || filename.includes("/")) {
      return res.status(400).render("error", { message: res.locals.t("api.media.invalidFilename") });
    }
    const filePath = path.join(getSiteDir(req.resolvedSiteId), filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.redirect(`/admin/media?site_id=${req.resolvedSiteId}`);
  } catch (err) { next(err); }
});

export default router;
