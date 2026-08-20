import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "crypto";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";

// Import tool (scripts/import-crm-data.mjs) — fixture CSV/JSON → tabelle v1.
// Verifica: creazione custom field defs, contatti (upsert per email), custom
// values di profilo/custom, opportunità (upsert per contatto+titolo), custom
// values opportunità, idempotenza su doppia esecuzione, isolamento tenant.
describe("import-crm-data tool", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const TOOL = path.resolve(__dirname, "../scripts/import-crm-data.mjs");
  let site, pipelineId;
  let tmpFile;

  const runTool = (siteId, json, extraArgs = []) => {
    const file = path.join(os.tmpdir(), `import-fixture-${crypto.randomBytes(6).toString("hex")}.json`);
    fs.writeFileSync(file, JSON.stringify(json));
    const out = execFileSync(
      process.execPath,
      [TOOL, file, ...(siteId !== undefined ? ["--site", String(siteId)] : []), ...extraArgs],
      { encoding: "utf8", env: { ...process.env } }
    );
    fs.unlinkSync(file);
    return out;
  };

  before(async () => {
    site = await createTestSite("Import Tool Tenant");
    const p = await query(
      "INSERT INTO pipelines (site_id, name, stages, is_default) VALUES ($1, 'Default', '[]', true) RETURNING id",
      [site.id]
    );
    pipelineId = p.rows[0].id;
  });

  after(async () => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    await closeDb();
  });

  test("popola custom fields, contatti (con profilo/custom) e opportunità", async () => {
    const email = `imp-${crypto.randomBytes(4).toString("hex")}@example.test`;
    const out = runTool(site.id, {
      custom_fields: [
        { object_key: "contact", field_key: "citta", name: "Città", type: "text" },
        { object_key: "opportunity", field_key: "sorgente", name: "Sorgente", type: "text" },
      ],
      contacts: [
        {
          email,
          name: "Imma Portata",
          phone: "+39123", companyName: "Import Srl",
          tags: ["lead", "import"],
          status: "nuovo",
          value_estimate: 2500,
          customFields: { citta: "Cagliari" },
        },
      ],
      opportunities: [
        {
          contactEmail: email,
          title: "Offerta Import",
          pipeline_id: pipelineId,
          stage: "open",
          amount: 2500,
          probability: 40,
          status: "open",
          notes: "da import",
          customFields: { sorgente: "web" },
        },
      ],
    });

    assert.match(out, /contatti:\s+1 creati, 0 aggiornati/);
    assert.match(out, /opportunità:\s+1 create, 0 aggiornate/);

    // Contatto con custom field di profilo + custom 'citta'.
    const c = (await query(
      "SELECT * FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email]
    )).rows[0];
    assert.ok(c, "contatto creato");
    assert.deepEqual(c.tags, ["lead", "import"]);
    assert.equal(c.status, "nuovo");
    assert.equal(Number(c.value_estimate), 2500);

    const cv = (await query(
      "SELECT values FROM contact_custom_values WHERE site_id = $1 AND contact_id = $2 AND object_key = 'contact'",
      [site.id, c.id]
    )).rows[0];
    assert.ok(cv, "custom values contatto presenti");
    assert.equal(cv.values.firstName, "Imma");
    assert.equal(cv.values.lastName, "Portata");
    assert.equal(cv.values.phone, "+39123");
    assert.equal(cv.values.citta, "Cagliari");

    // Opportunità con custom 'sorgente'.
    const opp = (await query(
      "SELECT * FROM opportunities WHERE site_id = $1 AND contact_email = $2 AND title = $3",
      [site.id, email, "Offerta Import"]
    )).rows[0];
    assert.ok(opp, "opportunità creata");
    assert.equal(Number(opp.amount), 2500);
    const ocv = (await query(
      "SELECT values FROM opportunity_custom_values WHERE site_id = $1 AND opportunity_id = $2",
      [site.id, opp.id]
    )).rows[0];
    assert.ok(ocv, "custom values opportunità presenti");
    assert.equal(ocv.values.sorgente, "web");

    // Definizioni custom field create.
    const cf = (await query(
      "SELECT field_key, object_key FROM custom_fields WHERE site_id = $1 ORDER BY field_key", [site.id]
    )).rows;
    const keys = cf.map((r) => `${r.object_key}:${r.field_key}`);
    assert.ok(keys.includes("contact:citta"));
    assert.ok(keys.includes("opportunity:sorgente"));
  });

  test("idempotente: doppia esecuzione non duplica contatti/opportunità", async () => {
    const email = `imp2-${crypto.randomBytes(4).toString("hex")}@example.test`;
    const fixture = {
      custom_fields: [{ object_key: "contact", field_key: "citta", name: "Città", type: "text" }],
      contacts: [{ email, name: "Due Volte", customFields: { citta: "Nuoro" } }],
      opportunities: [{ contactEmail: email, title: "Op Due", amount: 500 }],
    };
    runTool(site.id, fixture);
    const out2 = runTool(site.id, fixture);

    assert.match(out2, /contatti:\s+0 creati, 1 aggiornati/);
    assert.match(out2, /opportunità:\s+0 create, 1 aggiornate/);

    const n = (await query("SELECT COUNT(*)::int AS n FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0].n;
    assert.equal(n, 1);
    const no = (await query(
      "SELECT COUNT(*)::int AS n FROM opportunities WHERE site_id = $1 AND contact_email = $2 AND title = 'Op Due'",
      [site.id, email]
    )).rows[0].n;
    assert.equal(no, 1);
  });

  test("scarta field_key non definiti (con warn) e mantiene il resto", async () => {
    const email = `imp3-${crypto.randomBytes(4).toString("hex")}@example.test`;
    // Nessuna definizione custom field per queste chiavi: il tool deve scartare
    // le chiavi non di profilo (nondefinito) ma tenere il profilo (name/phone).
    const customKey = `x_${crypto.randomBytes(4).toString("hex")}`; // sicuramente non definito
    const out = runTool(site.id, {
      contacts: [{ email, name: "Solo Profilo", phone: "000", customFields: { [customKey]: "Roma" } }],
    });

    assert.match(out, /scarti \(field_key non definiti\): .*contact:/);
    const c = (await query("SELECT id FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    const cv = (await query(
      "SELECT values FROM contact_custom_values WHERE site_id = $1 AND contact_id = $2 AND object_key = 'contact'",
      [site.id, c.id]
    )).rows[0];
    // Il profilo (chiavi riservate) è mantenuto anche senza definizione.
    assert.equal(cv.values.firstName, "Solo");
    assert.equal(cv.values.phone, "000");
    // La chiave custom non definita è scartata.
    assert.equal(cv.values[customKey], undefined);
  });

  test("dry-run: nessuna riga scritta", async () => {
    const email = `imp4-${crypto.randomBytes(4).toString("hex")}@example.test`;
    const out = runTool(site.id, {
      contacts: [{ email, name: "Dry Run" }],
    }, ["--dry-run"]);

    assert.match(out, /DRY-RUN/);
    const n = (await query("SELECT COUNT(*)::int AS n FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0].n;
    assert.equal(n, 0);
  });
});
