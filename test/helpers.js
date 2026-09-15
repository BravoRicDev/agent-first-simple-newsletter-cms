import crypto from "crypto";
import { query } from "../src/db.js";
import pool from "../src/db.js";

// Ogni file di test usa domini/email univoci (invece di ripulire il DB tra
// un test e l'altro): più semplice, permette di far girare i test in
// parallelo o ripetutamente sullo stesso DB senza truncate condivisi che
// romperebbero l'isolamento tra file diversi.
export function uniqueDomain(prefix = "test") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}.example.test`;
}

export function uniqueEmail(prefix = "user") {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}@example.test`;
}

export async function createTestSite(name = "Test Site") {
  const domain = uniqueDomain();
  const result = await query(
    "INSERT INTO sites (name, domain) VALUES ($1, $2) RETURNING id",
    [name, domain]
  );
  return { id: result.rows[0].id, domain };
}

export async function createTestUser(siteId, role = "admin") {
  const email = uniqueEmail("staff");
  const result = await query(
    "INSERT INTO users (email, name, role, site_id, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
    [email, "Test User", role, siteId]
  );
  return { id: result.rows[0].id, email, role, site_id: siteId };
}

// Chiude il pool pg alla fine della suite — senza questo `node --test`
// resta appeso in attesa che le connessioni idle si chiudano da sole.
export async function closeDb() {
  await pool.end();
}
