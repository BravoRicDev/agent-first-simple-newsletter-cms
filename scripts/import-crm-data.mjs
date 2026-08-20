#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Import dati v1 — "API compatibili con CRM diffusi" (CLI, Node + pg).
//
// Tool PROGETTATO in docs/IMPORT_READINESS.md e ora IMPLEMENTATO. Carica un
// file JSON con la struttura documentata e popola le tabelle v1 (F0 + ONDA 1)
// in modo IDEMPOTENTE (ON CONFLICT / upsert): può essere rieseguito senza
// duplicare dati.
//
// NON esegue migrazione di dati di produzione con sorgenti reali per conto
// proprio: è uno strumento CLI che l'operatore lancia esplicitamente quando
// esiste una sorgente dati esterna da importare. Con un DB vuoto non tocca
// nulla di preesistente.
//
// Struttura del file JSON (vedi docs/IMPORT_READINESS.md):
//   {
//     "site_id": 1,
//     "custom_fields": [                       // opzionale: definizioni da creare
//       { "object_key": "contact", "field_key": "citta", "name": "Città", "type": "text" },
//       ...
//     ],
//     "contacts": [                            // upsert per (site_id, email)
//       {
//         "email": "...", "name": "...", "firstName": "...", "lastName": "...",
//         "phone": "...", "companyName": "...", "website": "...",
//         "tags": [], "status": "", "notes": "", "value_estimate": 0,
//         "customFields": { "citta": "Roma" }
//       }, ...
//     ],
//     "opportunities": [                       // upsert per (contact_email + title)
//       {
//         "contactEmail": "...", "title": "...", "pipeline_id": 1, "stage": "open",
//         "amount": 1000, "probability": 50, "status": "open",
//         "expected_close_at": "2026-12-31", "notes": "",
//         "customFields": { "sorgente": "web" }
//       }, ...
//     ]
//   }
//
// Uso:
//   node scripts/import-crm-data.mjs <file.json> [--site <id>] [--dry-run]
//
// Flag:
//   --site <id>   sovrascrive site_id (se assente nel file)
//   --dry-run     valida e stampa il piano senza scrivere nulla
//   --quiet       sopprime i log di avanzamento (solo riepilogo/scarti)
// ─────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_OBJECTS = new Set(["contact", "opportunity"]);
const ALLOWED_TYPES = new Set(["text", "number", "date", "checkbox", "select", "textarea"]);
// Chiavi riservate del PROFILO contatto: vivono in contact_custom_values con
// object_key='contact' e NON richiedono una definizione in custom_fields.
const PROFILE_KEYS = new Set(["name", "firstName", "lastName", "phone", "companyName", "website"]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--site") args.site = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--quiet") args.quiet = true;
    else args._.push(a);
  }
  return args;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function slugify(value) {
  // Chiave stabile — coerente con src/services/custom-fields.js.
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

function normalizeCustomField(d) {
  const type = String(d.type || "text");
  const objectKey = String(d.object_key || "contact");
  return {
    object_key: ALLOWED_OBJECTS.has(objectKey) ? objectKey : null,
    field_key: slugify(d.field_key),
    name: String(d.name || "").slice(0, 255),
    type: ALLOWED_TYPES.has(type) ? type : null,
    options: Array.isArray(d.options) ? d.options : [],
    is_public: d.is_public === true || d.is_public === "true",
    active: d.active === undefined ? true : d.active === true || d.active === "true",
    position: Number.isFinite(Number(d.position)) ? Math.max(0, Number(d.position)) : 0,
  };
}

class Importer {
  constructor(pool, { siteId, dryRun = false, quiet = false }) {
    this.pool = pool;
    this.siteId = siteId;
    this.dryRun = dryRun;
    this.quiet = quiet;
    this.stats = {
      customFields: 0,
      contactsCreated: 0,
      contactsUpdated: 0,
      opportunitiesCreated: 0,
      opportunitiesUpdated: 0,
      discardedKeys: [],
    };
  }

  log(msg) {
    if (!this.quiet) console.log(msg);
  }

  async ensureSite() {
    if (!this.siteId) throw new Error("site_id obbligatorio (nel file o via --site)");
    const r = await this.pool.query("SELECT id FROM sites WHERE id = $1", [this.siteId]);
    if (r.rowCount === 0) throw new Error(`site_id ${this.siteId} inesistente in 'sites'`);
  }

  async loadDefinedKeys() {
    const r = await this.pool.query(
      "SELECT field_key, object_key FROM custom_fields WHERE site_id = $1 AND active = true",
      [this.siteId]
    );
    const keys = { contact: new Set(PROFILE_KEYS), opportunity: new Set() };
    for (const row of r.rows) {
      const ok = row.object_key;
      if (ALLOWED_OBJECTS.has(ok)) keys[ok].add(row.field_key);
    }
    return keys;
  }

  // Upsert definizioni custom field. Idempotente (ON CONFLICT DO UPDATE).
  async importCustomFields(definitions) {
    if (!Array.isArray(definitions) || definitions.length === 0) return;
    for (const raw of definitions) {
      const d = normalizeCustomField(raw);
      if (!d.object_key || !d.field_key || !d.type) {
        console.warn(`import: definizione custom field non valida ignorata: ${JSON.stringify(raw)}`);
        continue;
      }
      if (this.dryRun) { this.stats.customFields++; continue; }
      await this.pool.query(
        `INSERT INTO custom_fields (site_id, object_key, field_key, name, type, options, is_public, active, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (site_id, object_key, field_key) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type, options = EXCLUDED.options,
           is_public = EXCLUDED.is_public, active = EXCLUDED.active,
           position = EXCLUDED.position, updated_at = NOW()`,
        [this.siteId, d.object_key, d.field_key, d.name, d.type,
         JSON.stringify(d.options), d.is_public, d.active, d.position]
      );
      this.stats.customFields++;
    }
  }

  // Filtra { field_key: value } tenendo solo le chiavi definite (o di profilo),
  // loggando gli scarti — coerente con custom-values.js.
  filterCustom(values, definedKeys, objectKey) {
    const clean = {};
    for (const [k, v] of Object.entries(values || {})) {
      if (!definedKeys.has(k)) {
        this.stats.discardedKeys.push(`${objectKey}:${k}`);
        console.warn(`import: field_key '${k}' non definito per '${objectKey}' (site=${this.siteId}) — scartato`);
        continue;
      }
      if (v !== undefined && v !== null && v !== "") clean[k] = v;
    }
    return clean;
  }

  async importContacts(contacts, definedKeys) {
    if (!Array.isArray(contacts) || contacts.length === 0) return;
    for (const c of contacts) {
      const email = normalizeEmail(c.email);
      if (!EMAIL_RE.test(email)) {
        console.warn(`import: email contatto non valida ignorata: ${JSON.stringify(c.email)}`);
        continue;
      }
      const tags = Array.isArray(c.tags) ? c.tags : [];
      const status = String(c.status || "").slice(0, 100);
      const notes = String(c.notes || "").slice(0, 5000);
      let valueEstimate = null;
      if (c.value_estimate !== undefined && c.value_estimate !== null && c.value_estimate !== "") {
        const n = Number(c.value_estimate);
        if (Number.isFinite(n)) valueEstimate = n;
      }

      // Profilo: name + firstName/lastName derivati se non espliciti.
      const parts = String(c.name || "").trim().split(/\s+/).filter(Boolean);
      const firstName = c.firstName ?? (parts[0] || "");
      const lastName = c.lastName ?? (parts.slice(1).join(" ") || "");
      const profile = {
        name: c.name,
        firstName,
        lastName,
        phone: c.phone,
        companyName: c.companyName,
        website: c.website,
      };
      const custom = this.filterCustom({ ...profile, ...(c.customFields || {}) }, definedKeys.contact, "contact");
      // Rimuovi chiavi vuote dopo il filtro profilo.
      const cleanProfile = {};
      for (const [k, v] of Object.entries(custom)) if (v !== undefined && v !== null && v !== "") cleanProfile[k] = v;

      if (this.dryRun) { this.stats.contactsCreated++; continue; }

      await this.pool.query("BEGIN");
      try {
        const cur = await this.pool.query(
          `INSERT INTO contacts (site_id, email, tags, status, notes, value_estimate)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (site_id, email) DO UPDATE SET
             tags = EXCLUDED.tags,
             status = CASE WHEN EXCLUDED.status <> '' THEN EXCLUDED.status ELSE contacts.status END,
             notes = CASE WHEN EXCLUDED.notes <> '' THEN EXCLUDED.notes ELSE contacts.notes END,
             value_estimate = EXCLUDED.value_estimate,
             updated_at = NOW()
           RETURNING id, (xmax = 0) AS inserted`,
          [this.siteId, email, tags, status, notes, valueEstimate]
        );
        const row = cur.rows[0];
        if (row.inserted) this.stats.contactsCreated++;
        else this.stats.contactsUpdated++;

        // Profilo + custom field (object_key='contact').
        if (Object.keys(cleanProfile).length > 0) {
          await this.pool.query(
            `INSERT INTO contact_custom_values (site_id, contact_id, object_key, values)
             VALUES ($1, $2, 'contact', $3)
             ON CONFLICT (site_id, contact_id, object_key)
             DO UPDATE SET values = EXCLUDED.values, updated_at = NOW()`,
            [this.siteId, row.id, JSON.stringify(cleanProfile)]
          );
        }
        await this.pool.query("COMMIT");
      } catch (err) {
        await this.pool.query("ROLLBACK");
        throw err;
      }
    }
  }

  // Pipeline stage: risolve `stage` (key della pipeline predefinita del sito).
  // Se `pipeline_id` non è indicato, usa la prima pipeline del tenant.
  async resolvePipelineStage(c) {
    let pipelineId = c.pipeline_id;
    if (!pipelineId) {
      const r = await this.pool.query(
        "SELECT id FROM pipelines WHERE site_id = $1 ORDER BY id LIMIT 1",
        [this.siteId]
      );
      pipelineId = r.rows[0]?.id ?? null;
    }
    return { pipelineId, stage: String(c.stage || "").slice(0, 100) };
  }

  async importOpportunities(opportunities, definedKeys) {
    if (!Array.isArray(opportunities) || opportunities.length === 0) return;
    for (const o of opportunities) {
      const email = normalizeEmail(o.contactEmail || o.contact_email);
      const title = String(o.title || "").trim();
      if (!email || !title) {
        console.warn(`import: opportunità senza contactEmail/title valide ignorata: ${JSON.stringify(o)}`);
        continue;
      }
      // Il contatto deve esistere già (import contatti prima delle opportunità).
      const contact = await this.pool.query(
        "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = $2",
        [this.siteId, email]
      );
      if (contact.rowCount === 0) {
        console.warn(`import: opportunità per contatto inesistente '${email}' — scartata`);
        continue;
      }
      const { pipelineId, stage } = await this.resolvePipelineStage(o);
      const amount = Number.isFinite(Number(o.amount)) ? Number(o.amount) : 0;
      let probability = Number.isFinite(Number(o.probability)) ? Math.round(Number(o.probability)) : 0;
      probability = Math.max(0, Math.min(100, probability));
      const status = ["open", "won", "lost"].includes(String(o.status)) ? String(o.status) : "open";
      const expectedCloseAt = o.expected_close_at || o.expectedCloseDate || null;
      const notes = String(o.notes || "").slice(0, 5000);

      const custom = this.filterCustom(o.customFields || {}, definedKeys.opportunity, "opportunity");

      if (this.dryRun) { this.stats.opportunitiesCreated++; continue; }

      await this.pool.query("BEGIN");
      try {
        // Upsert per (contatto + titolo): se esiste già, aggiorna i campi.
        const existing = await this.pool.query(
          "SELECT id FROM opportunities WHERE site_id = $1 AND contact_email = $2 AND title = $3",
          [this.siteId, email, title]
        );
        let oppId;
        if (existing.rowCount > 0) {
          oppId = existing.rows[0].id;
          await this.pool.query(
            `UPDATE opportunities SET pipeline_id = $1, stage = $2, amount = $3,
               probability = $4, status = $5, expected_close_at = $6, notes = $7,
               updated_at = NOW()
             WHERE id = $8 AND site_id = $9`,
            [pipelineId, stage, amount, probability, status, expectedCloseAt, notes, oppId, this.siteId]
          );
          this.stats.opportunitiesUpdated++;
        } else {
          const ins = await this.pool.query(
            `INSERT INTO opportunities (site_id, contact_email, pipeline_id, stage, title,
               amount, probability, status, expected_close_at, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
            [this.siteId, email, pipelineId, stage, title, amount, probability, status, expectedCloseAt, notes]
          );
          oppId = ins.rows[0].id;
          this.stats.opportunitiesCreated++;
        }

        if (Object.keys(custom).length > 0) {
          await this.pool.query(
            `INSERT INTO opportunity_custom_values (site_id, opportunity_id, values)
             VALUES ($1, $2, $3)
             ON CONFLICT (site_id, opportunity_id)
             DO UPDATE SET values = EXCLUDED.values, updated_at = NOW()`,
            [this.siteId, oppId, JSON.stringify(custom)]
          );
        }
        await this.pool.query("COMMIT");
      } catch (err) {
        await this.pool.query("ROLLBACK");
        throw err;
      }
    }
  }

  async run(data) {
    if (this.siteId === undefined && data.site_id !== undefined) this.siteId = data.site_id;
    await this.ensureSite();
    const definedKeys = await this.loadDefinedKeys();

    this.log(`Import su site_id=${this.siteId}${this.dryRun ? " (DRY-RUN)" : ""}`);
    await this.importCustomFields(data.custom_fields);
    // Ricarica le chiavi definite dopo aver creato le definizioni.
    const reloaded = await this.loadDefinedKeys();
    definedKeys.contact = reloaded.contact;
    definedKeys.opportunity = reloaded.opportunity;
    await this.importContacts(data.contacts, definedKeys);
    await this.importOpportunities(data.opportunities, definedKeys);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!fs.existsSync(file)) {
    console.error(`File non trovato: ${file}`);
    console.error('Uso: node scripts/import-crm-data.mjs <file.json> [--site <id>] [--dry-run] [--quiet]');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`JSON non valido: ${err.message}`);
    process.exit(1);
  }

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error("DATABASE_URL non configurata (esportala prima di lanciare il tool)");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const importer = new Importer(pool, {
    siteId: args.site,
    dryRun: !!args.dryRun,
    quiet: !!args.quiet,
  });

  try {
    await importer.run(data);
  } catch (err) {
    console.error(`Errore import: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }

  const s = importer.stats;
  const discarded = s.discardedKeys.length
    ? `\n  scarti (field_key non definiti): ${[...new Set(s.discardedKeys)].join(", ")}`
    : "";
  console.log("Riepilogo import:");
  console.log(`  custom_fields: ${s.customFields}`);
  console.log(`  contatti:      ${s.contactsCreated} creati, ${s.contactsUpdated} aggiornati`);
  console.log(`  opportunità:   ${s.opportunitiesCreated} create, ${s.opportunitiesUpdated} aggiornate`);
  console.log(discarded);
  if (importer.dryRun) console.log("(dry-run: nessuna scrittura effettuata)");
}

main();
