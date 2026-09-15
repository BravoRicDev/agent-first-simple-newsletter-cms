import { safeFetch } from "./ssrf.js";

function extractTextFromHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractTitle(html) {
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
  if (ogTitle) return ogTitle[1].trim();
  const title = html.match(/<title>([^<]+)<\/title>/i);
  if (title) return title[1].trim();
  return "";
}

function extractImageUrls(html) {
  const imgs = [];
  const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
  if (ogImage) imgs.push(ogImage[1]);

  const re = /(?:src|href)\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif))["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    if (
      !imgs.includes(url) &&
      !url.includes("pixel") &&
      !url.includes("tracking") &&
      !url.includes("1x1") &&
      url.length < 500
    ) {
      imgs.push(url);
    }
  }
  return imgs.slice(0, 20);
}

function extractMediaUrls(html) {
  const media = [];
  const re = /["'](https?:\/\/[^"']+\.(?:mp4|mp3|mov|m4a|ogg|webm)(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!media.includes(m[1])) media.push(m[1]);
  }

  const yt = html.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (yt) media.push(`https://www.youtube.com/watch?v=${yt[1]}`);

  const igVideo = html.match(/"video_url"\s*:\s*"([^"]+)"/);
  if (igVideo) media.push(igVideo[1].replace(/\\u0026/g, "&"));

  return media;
}

export async function ingestUrl(sourceUrl) {
  // safeFetch rivalida l'IP ad ogni hop di redirect (SSRF-safe), a differenza di
  // fetch con redirect:"follow" che seguirebbe un 302 verso host interni/metadata.
  const response = await safeFetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CMS/1.0)",
      "Accept": "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} da ${sourceUrl}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (/video|audio|pdf/.test(contentType)) {
    return {
      type: contentType.includes("video") ? "video" : contentType.includes("audio") ? "audio" : "file",
      title: "",
      text: "",
      word_count: 0,
      image_urls: [],
      media_urls: [sourceUrl],
      source_url: sourceUrl,
    };
  }

  // Cap sul body: response.text() accumula TUTTO in memoria e l'URL è
  // controllato dall'utente/agente (ingest singolo + bulk-import ×50). Senza
  // limite, un host ostile che risponde con header 200 e invia dati
  // ininterrottamente esaurisce la RAM del processo (DoS). Timeout da solo
  // non basta: limita i secondi, non i byte.
  const MAX_HTML_BYTES = 5 * 1024 * 1024; // 5 MB
  const declaredLength = parseInt(response.headers.get("content-length") || "0", 10);
  if (declaredLength > MAX_HTML_BYTES) {
    throw new Error(`Pagina troppo grande (${declaredLength} bytes)`);
  }
  const chunks = [];
  let total = 0;
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_HTML_BYTES) {
        await response.body.cancel().catch(() => {});
        throw new Error(`Pagina troppo grande (>${MAX_HTML_BYTES} bytes)`);
      }
      chunks.push(chunk);
    }
  } else {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) throw new Error(`Pagina troppo grande (${buf.length} bytes)`);
    chunks.push(buf);
  }
  const html = Buffer.concat(chunks).toString("utf8");
  const title = extractTitle(html);
  const rawText = extractTextFromHtml(html);
  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  const imageUrls = extractImageUrls(html);
  const mediaUrls = extractMediaUrls(html);

  let type = "article";
  if (mediaUrls.some(u => /youtube|youtu\.be/.test(u))) type = "video";
  else if (mediaUrls.some(u => /\.mp4|\.mov|\.webm/.test(u))) type = "video";
  else if (mediaUrls.some(u => /\.mp3|\.m4a|\.ogg/.test(u))) type = "audio";

  return {
    type,
    title,
    text: rawText.slice(0, 50000),
    word_count: wordCount,
    image_urls: imageUrls,
    media_urls: mediaUrls,
    source_url: sourceUrl,
  };
}
