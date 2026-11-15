import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";
import { getBlogSetting } from "./blog-settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MEDIA_ROOT = path.resolve(__dirname, "../../media");
export const VARIANTS_ROOT = path.join(MEDIA_ROOT, "_variants");
export const WIDTHS = [320, 480, 640, 800, 1024, 1280, 1600, 1920];
export const FORMATS = ["webp", "avif"];
export const MAX_INPUT_PIXELS = 60_000_000;
const QUALITY = { webp: 78, avif: 50 };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const ELIGIBLE_RE = /\.(jpe?g|png|webp)$/i;

// sharp caricato in modo pigro: un binario mancante/rotto non deve mai impedire l'import di page-renderer.
let sharpPromise = null;
export function getSharp() {
  if (!sharpPromise) {
    sharpPromise = import("sharp").then((m) => {
      const s = m.default;
      s.cache({ memory: 128, files: 20, items: 50 });
      s.concurrency(2);
      return s;
    });
  }
  return sharpPromise;
}

export function isEligible(filename) { return NAME_RE.test(String(filename || "")) && ELIGIBLE_RE.test(filename); }
function safeSite(siteId) { const n = Number(siteId); if (!Number.isInteger(n) || n < 1) throw new Error("invalid site"); return n; }
export function originalPath(siteId, filename) {
  if (!NAME_RE.test(filename)) throw new Error("invalid filename");
  return path.join(MEDIA_ROOT, String(safeSite(siteId)), filename);
}
export function variantsDir(siteId) { return path.join(VARIANTS_ROOT, String(safeSite(siteId))); }
export function variantName(filename, w, fmt) { return `${filename}.${w}w.${fmt}`; }
export function variantUrl(siteId, filename, w, fmt) { return `/media/_variants/${safeSite(siteId)}/${variantName(filename, w, fmt)}`; }
const metaFile = (siteId, filename) => path.join(variantsDir(siteId), `${filename}.json`);

export function getVariantInfo(siteId, filename) {
  try { return JSON.parse(fs.readFileSync(metaFile(siteId, filename), "utf8")); } catch { return null; }
}

// Fisici: ritorna { width, height, widths, formats, written } oppure { skipped }.
export async function generateVariants(siteId, filename, { widths = WIDTHS, formats = FORMATS } = {}) {
  if (!isEligible(filename)) return { skipped: "not_eligible" };
  const src = originalPath(siteId, filename);
  if (!fs.existsSync(src)) return { skipped: "missing" };
  const sharp = await getSharp();
  const meta = await sharp(src, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" }).metadata();
  if (!meta.width || !meta.height) return { skipped: "no_dimensions" };
  const swap = meta.orientation && meta.orientation >= 5;
  const W = swap ? meta.height : meta.width;
  const H = swap ? meta.width : meta.height;
  const set = new Set(widths.filter((w) => w < W));
  set.add(W);
  const list = [...set].sort((a, b) => a - b);
  const dir = variantsDir(siteId);
  fs.mkdirSync(dir, { recursive: true });
  const srcMtime = fs.statSync(src).mtimeMs;
  let written = 0;
  for (const w of list) {
    for (const fmt of formats) {
      const out = path.join(dir, variantName(filename, w, fmt));
      if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= srcMtime) continue;
      const tmp = out + ".tmp." + process.pid;
      await sharp(src, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
        .rotate().resize({ width: w, withoutEnlargement: true }).toFormat(fmt, fmt === "avif" ? { quality: QUALITY.avif, effort: 2 } : { quality: QUALITY.webp }).toFile(tmp);
      fs.renameSync(tmp, out);
      written++;
    }
  }
  const info = { width: W, height: H, widths: list, formats };
  fs.writeFileSync(metaFile(siteId, filename), JSON.stringify(info));
  return { ...info, written };
}

let chain = Promise.resolve();
let pending = 0;
// Accoda la generazione (fire-and-forget). Senza force rispetta images_srcset_mode del sito.
export function queueVariants(siteId, filename, { force = false } = {}) {
  if (!isEligible(filename) || pending >= 500) return;
  pending++;
  chain = chain.then(async () => {
    try {
      if (!force && (await getBlogSetting(siteId, "images_srcset_mode")) === "0") return;
      await generateVariants(siteId, filename);
    } catch (err) {
      logger.error(`image variants failed site=${siteId} file=${filename}: ${err.message}`);
    } finally { pending--; }
  });
  return chain;
}

// Rimuove varianti pre-generate + trasformazioni on-demand + meta di UN file originale.
export async function deleteVariants(siteId, filename) {
  if (!NAME_RE.test(String(filename || ""))) return 0;
  const dir = variantsDir(siteId);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(filename + ".")) { try { fs.unlinkSync(path.join(dir, name)); n++; } catch { /* ignore */ } }
  }
  return n;
}

// Rimuove le trasformazioni on-demand (<file>.t...) di UN file originale (usato anche da media-focal.js: vive qui per evitare import circolari).
export async function deleteTransforms(siteId, filename) {
  if (!NAME_RE.test(String(filename || ""))) return 0;
  const dir = variantsDir(siteId);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(filename + ".t")) { try { fs.unlinkSync(path.join(dir, name)); n++; } catch { /* ignore */ } }
  }
  return n;
}

export function buildSrcset(siteId, filename, fmt = "webp") {
  const info = getVariantInfo(siteId, filename);
  if (!info || !info.formats.includes(fmt)) return "";
  return info.widths.map((w) => `${variantUrl(siteId, filename, w, fmt)} ${w}w`).join(", ");
}
