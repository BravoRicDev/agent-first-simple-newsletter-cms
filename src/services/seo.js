import { query } from "../db.js";

export async function getPublishedPagesForSitemap(siteId) {
  // Le pagine noindex restano fuori dalla sitemap: indicizzazione e
  // sitemap sono due segnali diversi, ma pubblicare in sitemap una pagina
  // che poi dichiara noindex è solo rumore per i crawler (e in alcuni casi
  // un segnale contrastante che Google Search Console segnala come errore).
  return (await query(
    `SELECT p.url_path, p.updated_at, s.og_image
     FROM pages p
     LEFT JOIN page_seo s ON s.page_id = p.id
     WHERE p.site_id = $1 AND p.published = true AND s.noindex IS NOT TRUE
     ORDER BY p.url_path`,
    [siteId]
  )).rows;
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

// OG/Twitter/canonical/sitemap richiedono URL assoluti: un valore relativo
// inserito a mano in admin (es. "/media/2/cover.jpg") li rende invalidi per
// crawler e scraper social, che non risolvono URL relativi rispetto alla
// pagina come farebbe un browser.
export function toAbsoluteUrl(baseUrl, maybeUrl) {
  if (!maybeUrl) return "";
  if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;
  const base = baseUrl.replace(/\/$/, "");
  return maybeUrl.startsWith("/") ? base + maybeUrl : `${base}/${maybeUrl}`;
}

export function buildCanonicalUrl(baseUrl, urlPath, override) {
  if (override) return toAbsoluteUrl(baseUrl, override);
  return baseUrl.replace(/\/$/, "") + urlPath;
}

export function buildSitemapXml(baseUrl, pages) {
  const base = baseUrl.replace(/\/$/, "");
  const urls = pages.map((p) => {
    const loc = escapeXml(base + p.url_path);
    const lastmod = new Date(p.updated_at).toISOString().slice(0, 10);
    const image = p.og_image
      ? `\n    <image:image>\n      <image:loc>${escapeXml(toAbsoluteUrl(base, p.og_image))}</image:loc>\n    </image:image>`
      : "";
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>${image}\n  </url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls}\n</urlset>\n`;
}

// Direttive valide in un robots.txt: solo queste (più i commenti "#") sono
// ammesse nel campo libero "regole extra" impostabile in admin. Include
// "User-agent" apposta (non solo Disallow/Allow/Crawl-delay) per permettere
// il caso d'uso più richiesto in pratica: bloccare crawler AI specifici
// (es. "User-agent: GPTBot" + "Disallow: /") lasciando Googlebot invariato.
// Un valore libero non conforme corromperebbe il file o verrebbe ignorato
// dai crawler in modo silenzioso e imprevedibile: si scarta a monte, riga
// per riga, invece di fidarsi del testo intero.
const ROBOTS_DIRECTIVE_RE = /^(User-agent|Disallow|Allow|Crawl-delay|Sitemap):\s*\S*$/i;

function sanitizeRobotsExtra(extra) {
  if (!extra) return [];
  return String(extra)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && (line.startsWith("#") || ROBOTS_DIRECTIVE_RE.test(line)));
}

export function buildRobotsTxt(baseUrl, extra) {
  const base = baseUrl.replace(/\/$/, "");
  const extraLines = sanitizeRobotsExtra(extra);
  const parts = ["User-agent: *", "Allow: /"];
  if (extraLines.length > 0) {
    parts.push("", ...extraLines);
  }
  parts.push("", `Sitemap: ${base}/sitemap.xml`);
  return parts.join("\n") + "\n";
}

// JSON-LD sitewide (WebSite/Organization): rappresenta il sito nel suo
// complesso, non la singola pagina — va emesso una sola volta (homepage),
// non ripetuto identico su ogni risposta.
export function buildWebsiteJsonLd({ name, url }) {
  return { "@context": "https://schema.org", "@type": "WebSite", name, url };
}

// JSON-LD per pagina: tipo generico WebPage, scelta deliberata per una CMS
// multi-tenant che ospita sia siti aziendali che editoriali — differenziare
// per Article/LocalBusiness/BreadcrumbList richiede sapere cosa rappresenta
// davvero ogni pagina, cosa nota solo per singolo sito (fuori scope qui).
export function buildWebPageJsonLd({ name, description, url, image }) {
  const jsonld = { "@context": "https://schema.org", "@type": "WebPage", name, url };
  if (description) jsonld.description = description;
  if (image) jsonld.image = image;
  return jsonld;
}

// Article: usato per i siti editoriali (blog/testate) dove sappiamo che una
// pagina rappresenta davvero un articolo — a differenza di buildWebPageJsonLd,
// qui il chiamante ha già quel contesto (retrofit per-sito), quindi non è la
// scelta generica di default della piattaforma ma un tipo esplicito.
export function buildArticleJsonLd({ headline, description, url, image, datePublished, dateModified, authorName, publisherName }) {
  const jsonld = { "@context": "https://schema.org", "@type": "Article", headline, url };
  if (description) jsonld.description = description;
  if (image) jsonld.image = image;
  if (datePublished) jsonld.datePublished = datePublished;
  if (dateModified) jsonld.dateModified = dateModified;
  if (authorName) jsonld.author = { "@type": "Organization", name: authorName };
  if (publisherName) jsonld.publisher = { "@type": "Organization", name: publisherName };
  return jsonld;
}

// JSON.stringify() non basta per iniettare dati arbitrari (titoli/descrizioni
// scritti da un utente) dentro un <script>: un valore contenente "</script>"
// chiuderebbe il tag e uscirebbe dal JSON-LD nell'HTML circostante. "<"
// non è mai valido dentro una stringa JSON con questo significato, quindi
// escaparlo a < è sicuro e non altera il valore decodificato.
export function serializeJsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

const ATTR_ESCAPE_RE = /[&<>"']/g;
const ATTR_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeAttrValue(v) {
  return String(v).replace(ATTR_ESCAPE_RE, (c) => ATTR_ESCAPE_MAP[c]);
}

function escapeHtmlText(v) {
  return String(v).replace(/[&<>]/g, (c) => ATTR_ESCAPE_MAP[c]);
}

function metaNameRe(name) {
  return new RegExp(`<meta[^>]*name=["']${name}["'][^>]*>`, "i");
}

function metaPropRe(prop) {
  return new RegExp(`<meta[^>]*property=["']${prop}["'][^>]*>`, "i");
}

// Iniezione SEO per le pagine "standalone" (HTML completo già pronto nel
// campo content): non passano dal layout EJS, quindi gli unici meta che
// raggiungevano il browser erano quelli scritti a mano nel template, e i
// campi di page_seo (gestibili via API agente /admin) venivano ignorati.
// Questa funzione li cuce nel <head> del markup salvato.
//
// Semantica "semi-wrapped" — override NON distruttivo: ogni campo valorizzato
// sostituisce il tag corrispondente già presente nell'HTML (es. un <title>
// scritto a mano nel template) oppure lo inserisce prima di </head>; un campo
// vuoto lascia l'HTML intatto (il valore scritto a mano resta la fonte di
// default). Se </head> manca (markup anomalo) non inietta nulla, esattamente
// come il vecchio injectNoindexMeta che questa funzione sostituisce.
export function injectSeoIntoStandalone(html, seoLocals = {}) {
  if (typeof html !== "string" || !html) return html;
  if (!/<\/head>/i.test(html)) return html;

  const inserted = []; // tag nuovi da aggiungere prima di </head>

  // Sostituisce il tag esistente se presente, altrimenti lo accoda a quelli
  // da inserire. La sostituzione avviene SUBITO (l'html cambia), l'inserimento
  // solo alla fine in un unico replace di </head> (evita di inserire tag
  // dentro i tag appena inseriti).
  function upsert(re, replacement) {
    if (re.test(html)) {
      html = html.replace(re, () => replacement);
    } else {
      inserted.push(replacement);
    }
  }

  // Og/Twitter/JSON-LD sono emessi solo quando c'è almeno un campo
  // "contenutistico": una pagina senza alcuna configurazione SEO resta
  // byte-identica (promessa non-distruttiva), e noindex da solo (es. la
  // pagina 404) non deve aggiungere tag social a una pagina d'errore.
  const hasContentSeo = !!(seoLocals.meta_title || seoLocals.meta_description || seoLocals.meta_keywords || seoLocals.canonicalUrl || seoLocals.ogImage || seoLocals.brandName || seoLocals.twitterHandle);
  if (!hasContentSeo && !seoLocals.noindex) return html;

  if (seoLocals.meta_title) {
    upsert(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtmlText(seoLocals.meta_title)}</title>`);
  }
  if (seoLocals.meta_description) {
    upsert(metaNameRe("description"), `<meta name="description" content="${escapeAttrValue(seoLocals.meta_description)}">`);
  }
  if (seoLocals.meta_keywords) {
    upsert(metaNameRe("keywords"), `<meta name="keywords" content="${escapeAttrValue(seoLocals.meta_keywords)}">`);
  }
  if (seoLocals.canonicalUrl) {
    upsert(/<link[^>]*rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${escapeAttrValue(seoLocals.canonicalUrl)}">`);
  }
  if (seoLocals.noindex) {
    upsert(metaNameRe("robots"), `<meta name="robots" content="noindex,follow">`);
  }

  if (hasContentSeo) {
    // Open Graph / Twitter (stesso set di views/partials/seo-meta.ejs, così
    // wrapped e standalone emettono gli stessi tag).
    upsert(metaPropRe("og:type"), `<meta property="og:type" content="website">`);
    if (seoLocals.meta_title) {
      upsert(metaPropRe("og:title"), `<meta property="og:title" content="${escapeAttrValue(seoLocals.meta_title)}">`);
    }
    if (seoLocals.meta_description) {
      upsert(metaPropRe("og:description"), `<meta property="og:description" content="${escapeAttrValue(seoLocals.meta_description)}">`);
    }
    if (seoLocals.canonicalUrl) {
      upsert(metaPropRe("og:url"), `<meta property="og:url" content="${escapeAttrValue(seoLocals.canonicalUrl)}">`);
    }
    if (seoLocals.brandName) {
      upsert(metaPropRe("og:site_name"), `<meta property="og:site_name" content="${escapeAttrValue(seoLocals.brandName)}">`);
    }
    if (seoLocals.ogImage) {
      upsert(metaPropRe("og:image"), `<meta property="og:image" content="${escapeAttrValue(seoLocals.ogImage)}">`);
    }
    upsert(metaNameRe("twitter:card"), `<meta name="twitter:card" content="${seoLocals.ogImage ? "summary_large_image" : "summary"}">`);
    if (seoLocals.meta_title) {
      upsert(metaNameRe("twitter:title"), `<meta name="twitter:title" content="${escapeAttrValue(seoLocals.meta_title)}">`);
    }
    if (seoLocals.meta_description) {
      upsert(metaNameRe("twitter:description"), `<meta name="twitter:description" content="${escapeAttrValue(seoLocals.meta_description)}">`);
    }
    if (seoLocals.ogImage) {
      upsert(metaNameRe("twitter:image"), `<meta name="twitter:image" content="${escapeAttrValue(seoLocals.ogImage)}">`);
    }
    if (seoLocals.twitterHandle) {
      const h = seoLocals.twitterHandle.startsWith("@") ? seoLocals.twitterHandle : "@" + seoLocals.twitterHandle;
      upsert(metaNameRe("twitter:site"), `<meta name="twitter:site" content="${escapeAttrValue(h)}">`);
    }

    // JSON-LD: iniettato solo se l'HTML non ne ha già uno. Gli schema scritti
    // a mano (es. Article in un articolo editoriale) hanno priorità: due script
    // concorrenti per la stessa pagina confondono i crawler.
    const jsonLdTags = [];
    if (seoLocals.websiteJsonLd) jsonLdTags.push(`<script type="application/ld+json">${seoLocals.websiteJsonLd}</script>`);
    if (seoLocals.webpageJsonLd) jsonLdTags.push(`<script type="application/ld+json">${seoLocals.webpageJsonLd}</script>`);
    if (jsonLdTags.length > 0 && !/<script[^>]+type=["']application\/ld\+json["']/i.test(html)) {
      inserted.push(...jsonLdTags);
    }
  }

  if (inserted.length === 0) return html;
  return html.replace(/<\/head>/i, () => `${inserted.join("\n")}\n</head>`);
}
