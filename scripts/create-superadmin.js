#!/usr/bin/env node
// Bootstrap del primo superadmin (idempotente).
//
// Uso:
//   SUPERADMIN_EMAIL=admin@esempio.it node scripts/create-superadmin.js
//   node scripts/create-superadmin.js admin@esempio.it
//
// Se l'utente esiste già (per email), non lo tocca: stampa solo lo stato.
// Non serve autenticazione: è pensato per il primissimo accesso, quando la
// tabella users è vuota e non esiste ancora nessuno che possa creare utenti.
import { query } from "../src/db.js";

async function main() {
  const email = (process.env.SUPERADMIN_EMAIL || process.argv[2] || "")
    .trim().toLowerCase();
  if (!email) {
    console.error("ERRORE: specifica l'email del superadmin.");
    console.error('  SUPERADMIN_EMAIL=admin@esempio.it node scripts/create-superadmin.js');
    console.error('  oppure: node scripts/create-superadmin.js admin@esempio.it');
    process.exit(1);
  }

  const existing = await query("SELECT id, email, role, status FROM users WHERE email = $1", [email]);
  if (existing.rows.length > 0) {
    const u = existing.rows[0];
    console.log(`Utente già esistente (id=${u.id}, role=${u.role}, status=${u.status}): nessuna modifica.`);
    if (u.role !== "superadmin") {
      console.log(`Nota: ${email} NON è superadmin. Promuovilo da /admin/users (serve un altro superadmin) o esegui:`);
      console.log(`  UPDATE users SET role='superadmin' WHERE email='${email}';`);
    }
    return;
  }

  const inserted = await query(
    "INSERT INTO users (email, name, role, site_id, status) VALUES ($1, $2, 'superadmin', NULL, 'active') RETURNING id",
    [email, "Superadmin"]
  );
  console.log(`✅ Superadmin creato (id=${inserted.rows[0].id}): ${email}`);
  console.log("Ora accedi da /admin con il magic link (OTP via email).");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
