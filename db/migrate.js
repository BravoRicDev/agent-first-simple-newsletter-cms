import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL non configurata");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// Multi-nodo: più istanze del CMS possono partire in parallelo sullo stesso
// cluster PostgreSQL (replica streaming/Patroni). Serializziamo le migrazioni
// con un advisory lock transazionale di processo: il nodo che per primo
// acquisisce il lock esegue tutte le migration pendenti, gli altri attendono
// (finestra 10 minuti) e poi vedono schema_migrations già aggiornato (vuoto
// da fare). Se la finestra scade (es. partizione di rete), procediamo
// comunque: i file .sql sono idempotenti (IF NOT EXISTS / ON CONFLICT) e lo
// INSERT in schema_migrations usa ON CONFLICT DO NOTHING — il rischio residuo
// è solo una breve contesa DDL, non una corruzione.
const MIGRATION_LOCK_KEY = 74231017;
const MIGRATION_LOCK_MAX_WAIT_MS = 10 * 60 * 1000; // 10 minuti

async function withMigrationLock(fn) {
  const lockPool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    const client = await lockPool.connect();
    let locked = false;
    try {
      const deadline = Date.now() + MIGRATION_LOCK_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        const res = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_LOCK_KEY]);
        if (res.rows[0].locked) { locked = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!locked) {
        console.warn("Migrazioni: lock multi-nodo non acquisito entro 10min — procedo comunque (file idempotenti).");
      }
      await fn();
      if (locked) {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  } finally {
    await lockPool.end();
  }
}

async function migrate() {
  await withMigrationLock(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = new Set(
      (await pool.query("SELECT filename FROM schema_migrations")).rows.map(r => r.filename)
    );

    const files = fs.readdirSync(__dirname)
      .filter(f => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = fs.readFileSync(path.join(__dirname, file), "utf8");
      try {
        // Ogni file .sql deve restare idempotente (IF NOT EXISTS / ON CONFLICT):
        // al primo avvio dopo l'introduzione di questo tracking, schema_migrations
        // è vuota e tutti i file esistenti vengono rieseguiti una volta in più
        // prima di essere registrati — per questo devono poter girare a vuoto.
        await pool.query(sql);
        await pool.query("INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
        console.log(`Migrato: ${file}`);
      } catch (err) {
        console.error(`Errore in ${file}:`, err.message);
        process.exit(1);
      }
    }
  });

  await pool.end();
  console.log("Migrazioni completate.");
}

migrate();
