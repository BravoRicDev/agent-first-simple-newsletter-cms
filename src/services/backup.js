import fs from "fs";
import path from "path";
import zlib from "zlib";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";
import config from "../config.js";

const BACKUP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../backups");

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// Converte postgres://user:pass@host:port/db in variabili env per pg_dump:
// evita che le credenziali compaiano in `ps aux` (command line) e impedisce
// a pg_dump di chiedere la password su stdin (che bloccherebbe lo spawn).
export function pgEnvFromUrl(databaseUrl) {
  try {
    const u = new URL(databaseUrl);
    const env = { ...process.env };
    if (u.hostname) env.PGHOST = u.hostname;
    if (u.port) env.PGPORT = u.port;
    if (u.username) env.PGUSER = decodeURIComponent(u.username);
    if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
    env.PGDATABASE = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
    return env;
  } catch {
    // URL non parsabile: passa la stringa intera come --dbname (comportamento
    // precedente) ma senza credenziali esposte — meglio fallire che esporle.
    return process.env;
  }
}

const PG_DUMP_TIMEOUT_MS = 10 * 60 * 1000; // 10 minuti: se pg_dump si blocca
// (lock DB, rete), non deve fermare lo scheduler per sempre.

function dumpToFile(databaseUrl, tmpFile) {
  return new Promise((resolve, reject) => {
    // stdio: stdin "ignore" evita che pg_dump attenda la password da prompt
    // (se PGUSER/PGPASSWORD mancanti fallisce subito invece di bloccare).
    const dump = spawn("pg_dump", ["--no-owner", "--no-privileges", "--dbname=" + databaseUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      env: pgEnvFromUrl(databaseUrl),
    });
    const gzip = zlib.createGzip();
    const out = fs.createWriteStream(tmpFile);
    let stderr = "";
    let dumpCode;
    let outDone = false;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Pulizia vera: senza kill/destroy, su errore pg_dump continuava a
      // scrivere sul tmp e gli stream restavano aperti (file descriptor leak).
      try { dump.kill("SIGKILL"); } catch { /* già terminato */ }
      try { out.destroy(); } catch { /* già chiuso */ }
      try { gzip.destroy(); } catch { /* già chiuso */ }
      try { dump.stdout.destroy(); } catch { /* già chiuso */ }
      try { fs.unlinkSync(tmpFile); } catch { /* file non esistente */ }
      reject(err);
    };
    const maybeResolve = () => {
      if (settled) return;
      if (outDone && dumpCode === 0) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };

    // Timeout di sicurezza: uccide pg_dump se resta appeso (es. lock DB).
    const timer = setTimeout(() => {
      dump.kill("SIGKILL");
      fail(new Error(`pg_dump timeout dopo ${PG_DUMP_TIMEOUT_MS / 1000}s (lock DB o rete?): ${stderr.slice(0, 300)}`));
    }, PG_DUMP_TIMEOUT_MS);
    timer.unref?.();

    dump.stderr.on("data", (d) => { stderr += d; });
    dump.on("error", fail);
    dump.stdout.on("error", fail);
    dump.stdout.pipe(gzip).pipe(out);
    gzip.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => { outDone = true; maybeResolve(); });
    dump.on("close", (code) => {
      dumpCode = code;
      if (code !== 0) fail(new Error(`pg_dump exit ${code}: ${stderr.slice(0, 500)}`));
      else maybeResolve();
    });
  });
}

// Un backup al giorno (idempotente: se il file di oggi esiste già, non
// rifà nulla — safe da chiamare ad ogni tick dello scheduler). Non tocca
// i backup manuali pre-deploy-*.sql già presenti in backups/, solo i file
// prefissati "auto-" che gestisce lui.
//
// SANITY CHECK anti-reset: prima di dumpare verifica che il DB contenga
// (a) almeno un sito e (b) almeno una pagina pubblicata. Se il DB ha siti
// ma 0 pagine pubblicate, quasi certamente il volume è stato ricreato da
// zero (deploy con `docker compose down -v` che azzera pgdata: il backup
// nightly salverebbe altrimenti il DB vuoto come se nulla fosse). In quel
// caso il backup di oggi NON viene creato e viene loggato un errore ben
// visibile: il file mancante + l'errore nei log rendono il problema
// impossibile da ignorare.
export async function runScheduledBackup() {
  if (!config.backupEnabled) return;

  const file = path.join(BACKUP_DIR, `auto-${todayStr()}.sql.gz`);
  if (fs.existsSync(file)) return;

  try {
    const { query } = await import("../db.js");
    const siteCount = (await query("SELECT count(*)::int AS n FROM sites")).rows[0].n;
    const pubPages = (await query("SELECT count(*)::int AS n FROM pages WHERE published = true")).rows[0].n;
    if (siteCount === 0) {
      logger.error("BACKUP SOSPETTO: nessun sito nel DB (volume resettato?). Backup di oggi NON creato.");
      return;
    }
    if (pubPages === 0) {
      logger.error(`BACKUP SOSPETTO: ${siteCount} sito/i ma 0 pagine pubblicate — DB probabilmente resettato/seed incompleto. Backup di oggi NON creato.`);
      return;
    }
  } catch (err) {
    // Se il check fallisce (es. tabella pages mancante), meglio NON bloccare
    // il backup: logga e prosegui col dump (fallirà da solo se il DB è
    // davvero irraggiungibile).
    logger.warn(`Sanity check backup non eseguito: ${err.message}`);
  }

  // Tmp univoco per processo+istante: il tick dello scheduler e il run manuale
  // (backup-jobs.js) possono scrivere lo stesso giorno — con un tmp condiviso
  // due pg_dump concorrenti corrompevano il file ("last wins" su dump parziale).
  const tmpFile = path.join(BACKUP_DIR, `auto-${todayStr()}.sql.gz.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    await dumpToFile(config.databaseUrl, tmpFile);
    fs.renameSync(tmpFile, file);
    logger.info(`Backup automatico creato: ${path.basename(file)}`);
    cleanupOldBackups();
  } catch (err) {
    logger.error(`Backup automatico fallito: ${err.message}`);
    try { fs.unlinkSync(tmpFile); } catch { /* niente da pulire */ }
  }
}

function cleanupOldBackups() {
  const retentionMs = config.backupRetentionDays * 24 * 3600 * 1000;
  const now = Date.now();
  let files;
  try {
    files = fs.readdirSync(BACKUP_DIR);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.startsWith("auto-")) continue;
    const full = path.join(BACKUP_DIR, f);
    try {
      if (now - fs.statSync(full).mtimeMs > retentionMs) {
        fs.unlinkSync(full);
        logger.info(`Backup automatico rimosso (retention ${config.backupRetentionDays}gg): ${f}`);
      }
    } catch { /* file rimosso nel frattempo, ignora */ }
  }
}
