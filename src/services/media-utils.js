import { saveBufferToMedia } from "../routes/media.js";
import { logger } from "./logger.js";

const B64_RE = /data:(image|font)\/([a-zA-Z0-9+.-]+)(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=]{20,})/g;

// Soglia di sicurezza: un data URI base64 da decine di MB finiva in un
// buffer in memoria + file su disco senza alcun limite (l'estrazione da
// agent.js è "sempre, senza soglia"). Sopra ~8MB decodificati, si salta
// e si logga — un contenuto così grande è quasi certamente un errore.
const MAX_B64_DECODED_BYTES = 8 * 1024 * 1024;

const EXT_MAP = {
  jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp',
  svg: 'svg', woff: 'woff', woff2: 'woff2', ttf: 'ttf', otf: 'otf', eot: 'eot',
};

export function extractAndReplaceBase64(siteId, content) {
  const matches = [...content.matchAll(B64_RE)];
  if (matches.length === 0) return { content, converted: 0, total_size_kb: 0 };

  let html = content;
  let converted = 0;
  let totalSizeBytes = 0;

  for (const m of matches) {
    const [fullMatch, category, format, b64] = m;
    if (!html.includes(fullMatch)) continue;
    const normalizedFormat = format.toLowerCase().split('+')[0];
    const ext = EXT_MAP[normalizedFormat] || normalizedFormat;
    try {
      const buffer = Buffer.from(b64, 'base64');
      if (buffer.length > MAX_B64_DECODED_BYTES) {
        logger.warn(`Media: data URI ${buffer.length} bytes > soglia, saltato (site=${siteId})`);
        continue;
      }
      totalSizeBytes += buffer.length;
      const result = saveBufferToMedia(siteId, buffer, ext);
      html = html.split(fullMatch).join(result.url);
      converted++;
    } catch (err) {
      // Prima `catch (_) {}` ingoiava tutto: se saveBufferToMedia fallisce,
      // il data URI resta nel contenuto senza alcun log — nessun segnale.
      logger.error(`Media: conversione data URI fallita (site=${siteId}): ${err.message}`);
    }
  }

  return { content: html, converted, total_size_kb: Math.round(totalSizeBytes / 1024) };
}
