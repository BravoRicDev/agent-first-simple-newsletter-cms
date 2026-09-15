import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { query } from "../db.js";
import { runScheduledBackup } from "./backup.js";

// ─────────────────────────────────────────────────────────────────────────
// Feature 43 — Backup automatici con storico.
//
// Ogni backup viene registrato in backup_jobs PRIMA di eseguire il lavoro e
// aggiornato alla fine con status 'done' o 'failed': l'admin vede sempre i
// tentativi, anche quelli che falliscono (es. pg_dump assente nel container).
//
// Il dump vero e proprio resta in src/services/backup.js (runScheduledBackup,
// pg_dump + gzip, timeout 10 min, credenziali via env): qui lo riusiamo e
// compiliamo file_path/size_bytes cercando il file auto-*.sql.gz più recente
// in backups/. Per kind 'media' creiamo uno zip della cartella media/<siteId>
// con archiver (dipendenza già presente); se archiver manca degrada a un
// job 'done' con file_path 'media/' (nessun file da eliminare in delete).
// ─────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BACKUP_DIR = path.resolve(__dirname, "../../backups");
const MEDIA_ROOT = path.resolve(__dirname, "../../media");
const require = createRequire(import.meta.url);

export const BACKUP_KINDS = ["full", "db", "media"];

// pg_dump è un binario esterno (postgresql-client): se manca nel container
// il backup DB non può riuscire. Controllo esplicito PRIMA di chiamare
// runScheduledBackup (che inghiotte gli errori e logga soltanto): così il
// job viene marcato 'failed' con un messaggio chiaro.
export function hasPgDump() {
  try {
    const r = spawnSync("pg_dump", ["--version"], { timeout: 10000, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

// File auto-*.sql.gz più recente in backups/ (quelli gestiti dallo
// scheduler in backup.js — i pre-deploy-*.sql non vengono toccati).
function newestAutoBackup() {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR);
  } catch {
    return null;
  }
  const autos = files
    .filter((f) => f.startsWith("auto-") && f.endsWith(".sql.gz"))
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      try {
        const st = fs.statSync(full);
        return { name: f, full, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return autos[0] || null;
}

function fileSizeBytes(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// Backup della cartella media/<siteId> in backups/media-<siteId>-<ts>.zip.
// archiver v8 è ESM-only ed esporta classi (ZipArchive), NON la factory
// callable delle v6/v7 — gestiamo entrambe le forme. Se nessuna è
// utilizzabile degrada a file_path 'media/' con la dimensione totale dei
// file — il job resta 'done' e deleteJob non tocca nulla (il path non
// inizia con 'backups/').
async function zipMediaDir(siteId) {
  let archiver = null;
  try {
    archiver = require("archiver");
  } catch {
    archiver = null;
  }

  const mediaDir = path.join(MEDIA_ROOT, String(siteId));
  fs.mkdirSync(mediaDir, { recursive: true });

  let archive = null;
  if (typeof archiver === "function") {
    // v6/v7: archiver("zip", { zlib: { level } })
    archive = archiver("zip", { zlib: { level: 6 } });
  } else if (archiver && typeof archiver.ZipArchive === "function") {
    // v8: new ZipArchive({ zlib: { level } })
    archive = new archiver.ZipArchive({ zlib: { level: 6 } });
  }
  if (!archive) {
    const { bytes } = walkMediaDir(mediaDir);
    return { file_path: "media/", size_bytes: bytes };
  }

  // Timestamp con millisecondi: due backup media nello stesso secondo non
  // devono generare lo stesso filename (una delete colpirebbe entrambi).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipName = `media-${siteId}-${stamp}.zip`;
  const zipPath = path.join(BACKUP_DIR, zipName);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
    archive.pipe(output);
    archive.directory(mediaDir, false);
    archive.finalize();
  });

  const size = fileSizeBytes(zipPath);
  if (size === 0) {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      /* ignora */
    }
    throw new Error("backup media vuoto");
  }
  return { file_path: `backups/${zipName}`, size_bytes: size };
}

function walkMediaDir(dir) {
  let bytes = 0;
  let count = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        bytes += fileSizeBytes(full);
        count += 1;
      }
    }
  };
  walk(dir);
  return { bytes, count };
}

// Backup DB ('db' o 'full'): delega a runScheduledBackup (idempotente per
// giorno: se auto-<oggi>.sql.gz esiste già non rifà nulla) e registra il
// file più recente. Il controllo pg_dump + la presenza di un file fresco
// decidono done/failed — runScheduledBackup non lancia mai, logga soltanto.
async function runDbBackup() {
  if (!hasPgDump()) throw new Error("pg_dump non disponibile");
  const before = newestAutoBackup();
  await runScheduledBackup();
  const after = newestAutoBackup();
  const today = new Date().toISOString().slice(0, 10);
  const qualifies =
    !!after &&
    after.size > 0 &&
    (after.name === `auto-${today}.sql.gz` || !before || after.mtimeMs > before.mtimeMs);
  if (!qualifies) {
    throw new Error("nessun file di backup creato (pg_dump fallito o backup disabilitato)");
  }
  return { file_path: `backups/${after.name}`, size_bytes: after.size };
}

// ── API pubbliche del servizio ───────────────────────────────────────────

// Esegue un backup e registra SEMPRE il job: 'running' all'avvio, poi
// 'done' (con file_path/size_bytes) o 'failed' (con error). Non lancia mai:
// restituisce { job_id, status, job }.
export async function runBackup({ siteId = null, kind = "full", created_by = "manual" } = {}) {
  const k = BACKUP_KINDS.includes(kind) ? kind : "full";
  const by = created_by === "system" ? "system" : "manual";
  const ins = await query(
    `INSERT INTO backup_jobs (site_id, kind, status, created_by)
     VALUES ($1, $2, 'running', $3) RETURNING *`,
    [siteId, k, by]
  );
  const jobId = ins.rows[0].id;

  try {
    const result = k === "media" ? await zipMediaDir(siteId) : await runDbBackup();
    const row = (
      await query(
        `UPDATE backup_jobs SET status = 'done', file_path = $2, size_bytes = $3, completed_at = NOW()
         WHERE id = $1 RETURNING *`,
        [jobId, result.file_path, result.size_bytes]
      )
    ).rows[0];
    return { job_id: jobId, status: "done", job: row };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 2000);
    const row = (
      await query(
        `UPDATE backup_jobs SET status = 'failed', error = $2, completed_at = NOW()
         WHERE id = $1 RETURNING *`,
        [jobId, message]
      )
    ).rows[0];
    return { job_id: jobId, status: "failed", job: row };
  }
}

export async function listJobs(siteId, { limit = 50 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows =
    siteId == null
      ? (
          await query("SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT $1", [lim])
        ).rows
      : (
          await query(
            "SELECT * FROM backup_jobs WHERE site_id = $1 ORDER BY created_at DESC LIMIT $2",
            [siteId, lim]
          )
        ).rows;
  return rows;
}

export async function getJob(siteId, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n) || n < 1) return null;
  const rows =
    siteId == null
      ? (await query("SELECT * FROM backup_jobs WHERE id = $1", [n])).rows
      : (await query("SELECT * FROM backup_jobs WHERE id = $1 AND site_id = $2", [n, siteId])).rows;
  return rows[0] || null;
}

// Elimina il job (e il file fisico SOLO se file_path inizia con 'backups/':
// mai nulla fuori da quella cartella). Ritorna true se il job esisteva.
export async function deleteJob(siteId, id) {
  const job = await getJob(siteId, id);
  if (!job) return false;
  await query("DELETE FROM backup_jobs WHERE id = $1", [job.id]);
  if (typeof job.file_path === "string" && job.file_path.startsWith("backups/")) {
    const full = path.join(path.dirname(BACKUP_DIR), job.file_path);
    try {
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      /* file già rimosso o non eliminabile: il job resta eliminato */
    }
  }
  return true;
}
