import { getBlogSetting } from "./blog-settings.js";
import { getVariantInfo, buildSrcset, isEligible } from "./image-variants.js";

const IMG_RE = /<img\b[^>]*>/gi;
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag); return m ? m[2] : null; };
const has = (tag, name) => new RegExp(`\\s${name}(\\s*=|\\s|/|>)`, "i").test(tag);
const escAttr = (s) => String(s).replace(/"/g, "&quot;");

export function rewriteImages(html, siteId, mode) {
  let index = 0;
  return html.replace(IMG_RE, (tag, offset) => {
    const isFirst = index === 0;
    index++;
    if (has(tag, "srcset")) return tag;
    const src = attr(tag, "src");
    const m = src && new RegExp(`^/media/${siteId}/([A-Za-z0-9][A-Za-z0-9._-]*)$`).exec(src);
    if (!m || !isEligible(m[1])) return tag;
    const file = m[1];
    const info = getVariantInfo(siteId, file);
    if (!info) return tag;
    const webp = buildSrcset(siteId, file, "webp");
    if (!webp) return tag;
    let extra = "";
    const sizes = attr(tag, "sizes") ?? "100vw";
    if (!has(tag, "sizes")) extra += ` sizes="${sizes}"`;
    if (!has(tag, "loading") && !isFirst) extra += ` loading="lazy" decoding="async"`;
    const withAttrs = tag.replace(/\s*\/?>$/, (end) => ` srcset="${escAttr(webp)}"${extra}${end}`);
    if (mode !== "picture") return withAttrs;
    const before = html.slice(Math.max(0, offset - 300), offset);
    if (before.lastIndexOf("<picture") > before.lastIndexOf("</picture>")) return withAttrs;
    const avif = buildSrcset(siteId, file, "avif");
    const sources = (avif ? `<source type="image/avif" srcset="${escAttr(avif)}" sizes="${sizes}">` : "") + `<source type="image/webp" srcset="${escAttr(webp)}" sizes="${sizes}">`;
    return `<picture>${sources}${withAttrs}</picture>`;
  });
}

export async function rewriteImagesForSite(siteId, html) {
  if (typeof html !== "string" || !html.includes("<img")) return html;
  const mode = await getBlogSetting(siteId, "images_srcset_mode");
  if (mode !== "srcset" && mode !== "picture") return html;
  return rewriteImages(html, siteId, mode);
}
