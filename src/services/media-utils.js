import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { saveBufferToMedia } from "../routes/media.js";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Root assoluta della cartella protetta. path.resolve normalizza: la root
// non deve MAI essere calcolata da input utente (solo path assoluto fisso).
// Condivisa con src/routes/media-protected.js (che prima la definiva in
// locale): il serve dei file protetti passa SEMPRE da queste validazioni.
export const PROTECTED_ROOT = path.resolve(__dirname, "../../media-protected");

// Profondità massima consentita per i sottopercorsi. I file vivono al massimo
// in 4 segmenti (es. `5/calls/123.mp3` = 3 segmenti): un tetto basso limita
// la superficie di attacco e costringe a una gerarchia pensata.
const MAX_PATH_DEPTH = 4;

// Pattern di un singolo segmento di path. VOLUTAMENTE restrittivo:
//   - niente "/" (impossibile creare sottopercorsi arbitrari nel filename)
//   - il lookahead `(?!\.{1,2}$)` esclude i segmenti "." e ".." esatti
//     (anti path traversal a livello di segmento — difesa 1 di 3, sotto
//     ci sono anche il realpath check e la root di sendFile)
//   - solo caratteri sicuri in URL e filesystem (timestamp-hash.ext)
const SEGMENT_RE = /^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/;

// ── Validazione condivisa dei percorsi in media-protected ─────────────────
// La validazione anti path-traversal/anti-symlink del serve è UNICA e vive
// qui (PRIMA era inline in media-protected.js): sia la route admin
// (/media-protected/*) sia la rotta pubblica a token (/shared/:token) devono
// passare da questa funzione — mai riscrivere a mano il check da un'altra
// parte.
//
// Firma: (siteId, filename). Se siteId è un intero valido, il percorso è
// interpretato come relativo alla sottocartella del sito
// (media-protected/<siteId>/<filename>). Se siteId è null/vuoto, filename è
// il percorso completo relativo alla root (usato dalla route admin dove il
// siteId è già il primo segmento dell'URL).
export function resolveProtectedFilePath(siteId, filename) {
  const raw = siteId != null && siteId !== ""
    ? path.join(String(siteId), String(filename || ""))
    : String(filename || "");

  // Rifiuta percorsi assoluti e separatori Windows: anche se path.join più
  // sotto non esce mai dalla root, un media_path assoluto non deve esistere.
  if (raw.startsWith("/") || raw.startsWith("\\") || raw.includes("\\")) return null;

  const segments = raw.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.length > MAX_PATH_DEPTH ||
    !segments.every((s) => SEGMENT_RE.test(s))
  ) {
    return null;
  }

  const filePath = path.join(PROTECTED_ROOT, ...segments);

  // ── Anti-traversal E anti-symlink: il path reale deve restare ──────────
  // dentro la root. NOTA: path.join normalizza i ".." — se il percorso
  // richiesto conteneva "..", filePath può GIÀ puntare fuori dalla root
  // (es. /etc/passwd). Il confronto va fatto con PROTECTED_ROOT, NON con
  // filePath: `real === filePath` da solo non basta (un path già normalizzato
  // fuori dalla root uguaglia il proprio realpath). Il check è INCONDIZIONATO.
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch {
    return null;
  }
  if (!real.startsWith(PROTECTED_ROOT + path.sep)) {
    logger.warn(`Media protetto: accesso fuori root bloccato (${real})`);
    return null;
  }

  return { relPath: segments.join("/"), absolutePath: real };
}

// Controllo standalone "questo percorso relativo è accettabile in
// media-protected" (senza toccare il filesystem): usato dal servizio
// access-grants alla creazione per rifiutare subito media_path malformati.
export function isValidProtectedRelPath(relPath) {
  const raw = String(relPath || "");
  // Rifiuta percorsi assoluti, backslash e segmenti vuoti (a//b, /abs):
  // i segmenti accettati sono solo [a-zA-Z0-9._-] e mai "." / "..".
  if (raw.startsWith("/") || raw.startsWith("\\") || raw.includes("\\")) return false;
  const segments = raw.split("/");
  return (
    segments.length > 0 &&
    segments.length <= MAX_PATH_DEPTH &&
    segments.every((s) => s !== "" && SEGMENT_RE.test(s))
  );
}

// ── Scrittura file in media-protected (upload) ────────────────────────────
// Naming `timestamp-hash.ext` (stesso pattern documentato in
// src/routes/media-protected.js): niente collisioni, niente guess, niente
// caratteri pericolosi (il filename passa il SEGMENT_RE del serve). I file
// vanno scritti SOLO da codice, MAI da un utente con nome a piacere.
export function saveProtectedBuffer(siteId, buffer, ext) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  const cleanExt = String(ext || "").replace(/^\./, "").replace(/[^a-zA-Z0-9+.-]/g, "");
  const filename = `${Date.now()}-${hash.slice(0, 16)}.${cleanExt || "bin"}`;
  const dir = path.join(PROTECTED_ROOT, String(siteId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buffer);
  return { filename, media_path: filename, size: buffer.length };
}

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
