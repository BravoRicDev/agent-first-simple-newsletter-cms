import fs from "node:fs";
import path from "node:path";
import { originalPath, deleteTransforms, variantsDir, isEligible, MAX_INPUT_PIXELS, getSharp } from "./image-variants.js";
import { getFocalPoint } from "./media-focal.js";
export { originalPath, deleteTransforms };

export const ALLOWED_WIDTHS = [160, 240, 320, 480, 640, 800, 1024, 1280, 1600, 1920, 2560];
export const ALLOWED_RATIOS = [1, 4 / 3, 3 / 2, 16 / 9, 2 / 3, 3 / 4, 9 / 16];
export const MAX_TRANSFORMS_PER_SOURCE = 40;
export const MAX_FILES_PER_SITE = 20000;
const FORMATS = new Set(["webp", "avif", "jpeg", "png", "auto"]);
const QUALITY_MIN = 40, QUALITY_MAX = 90;

function bad(code) { const e = new Error(code); e.code = code; e.status = 400; return e; }

// Valida e normalizza i parametri. Ritorna { w, h|null, fmt, q } oppure lancia errore con .status/.code.
export function parseTransformParams(q, acceptHeader = "") {
  const w = parseInt(q.w, 10);
  if (!ALLOWED_WIDTHS.includes(w)) throw bad("invalid_width");
  let h = null;
  if (q.h !== undefined && q.h !== "") {
    h = parseInt(q.h, 10);
    if (!Number.isInteger(h) || h < 16 || h > 4096) throw bad("invalid_height");
    if (!ALLOWED_RATIOS.some((r) => Math.abs(w / h - r) <= 0.01)) throw bad("invalid_aspect");
  }
  let fmt = String(q.fmt || "auto").toLowerCase();
  if (fmt === "jpg") fmt = "jpeg";
  if (!FORMATS.has(fmt)) throw bad("invalid_format");
  if (fmt === "auto") fmt = /image\/avif/.test(acceptHeader) ? "avif" : /image\/webp/.test(acceptHeader) ? "webp" : "orig";
  let quality = q.q === undefined || q.q === "" ? 80 : parseInt(q.q, 10);
  if (!Number.isInteger(quality) || quality < QUALITY_MIN || quality > QUALITY_MAX) throw bad("invalid_quality");
  quality = Math.round(quality / 10) * 10;
  return { w, h, fmt, q: quality };
}

let active = 0;
const waiters = [];
async function acquire() {
  if (active < 2) { active++; return; }
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1); const e = new Error("busy"); e.status = 503; e.code = "busy"; reject(e); }, 5000);
    const entry = () => { clearTimeout(t); resolve(); };
    waiters.push(entry);
  });
}
function release() { const next = waiters.shift(); if (next) next(); else active--; }

// Ritorna { file, mime } (percorso assoluto in cache). Genera se manca.
export async function transformImage(siteId, filename, params) {
  if (!isEligible(filename)) throw bad("unsupported_type");
  const src = originalPath(siteId, filename);
  if (!fs.existsSync(src)) { const e = new Error("not_found"); e.status = 404; e.code = "not_found"; throw e; }
  const ext = path.extname(filename).slice(1).toLowerCase();
  const fmt = params.fmt === "orig" ? (ext === "jpg" || ext === "jpeg" ? "jpeg" : ext) : params.fmt;
  const focal = params.h ? await getFocalPoint(siteId, filename) : null;
  const ftag = focal ? `fx${Math.round(focal.x * 100)}y${Math.round(focal.y * 100)}` : "";
  const dir = variantsDir(siteId);
  fs.mkdirSync(dir, { recursive: true });
  const outName = `${filename}.t${params.w}x${params.h || 0}q${params.q}${ftag}.${fmt === "jpeg" ? "jpg" : fmt}`;
  const out = path.join(dir, outName);
  const mime = { webp: "image/webp", avif: "image/avif", jpeg: "image/jpeg", png: "image/png" }[fmt];
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return { file: out, mime };
  const names = fs.readdirSync(dir);
  const existing = names.filter((n) => n.startsWith(filename + ".t")).length;
  if (existing >= MAX_TRANSFORMS_PER_SOURCE || names.length >= MAX_FILES_PER_SITE) { const e = new Error("too_many_variants"); e.status = 429; e.code = "too_many_variants"; throw e; }
  await acquire();
  try {
    const sharp = await getSharp();
    const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" };
    const meta = await sharp(src, opts).metadata();
    const swap = meta.orientation && meta.orientation >= 5;
    const W = swap ? meta.height : meta.width;
    const H = swap ? meta.width : meta.height;
    let w = params.w, h = params.h;
    let pipe = sharp(src, opts).rotate();
    if (h) {
      const f = Math.min(1, W / w, H / h);
      w = Math.max(16, Math.floor(w * f)); h = Math.max(16, Math.floor(h * f));
      const scale = Math.max(w / W, h / H);
      const rw = Math.max(w, Math.ceil(W * scale)), rh = Math.max(h, Math.ceil(H * scale));
      const fx = focal ? focal.x : 0.5, fy = focal ? focal.y : 0.5;
      const left = Math.min(Math.max(Math.round(fx * rw - w / 2), 0), rw - w);
      const top = Math.min(Math.max(Math.round(fy * rh - h / 2), 0), rh - h);
      pipe = pipe.resize(rw, rh).extract({ left, top, width: w, height: h });
    } else {
      pipe = pipe.resize({ width: w, withoutEnlargement: true });
    }
    const tmp = out + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 6);
    await pipe.toFormat(fmt, fmt === "jpeg" ? { quality: params.q, mozjpeg: true } : fmt === "avif" ? { quality: params.q, effort: 2 } : { quality: params.q }).toFile(tmp);
    fs.renameSync(tmp, out);
    return { file: out, mime };
  } finally { release(); }
}
