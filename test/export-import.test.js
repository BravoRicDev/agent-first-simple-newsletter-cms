import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerExportRoutes } from "../src/routes/agent-export.js";
import { setContactFields } from "../src/services/contacts.js";

// Feature 39 — Export/import completo del CRM: export JSON/CSV dei dati,
// import contatti (upsert per email) e task con log persistente in
// import_jobs. Il modulo route viene montato su un router LOCALE (niente
// agentRouter): stessa protezione requireAuth+requireAgent di produzione.
describe("crm: export/import completo", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Export Import Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm export import", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerExportRoutes(r);
    app.use(r);

    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const exportEmail = "export-one@example.test";
  const csvEmail = "export-csv@example.test";

  test("export JSON: contiene il contatto creato via setContactFields", async () => {
    await setContactFields(site.id, exportEmail, {
      tags: ["lead", "web"],
      status: "nuovo",
      notes: "arrivato dal quiz",
      value_estimate: 1200,
    });

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-export?tables=contacts`, { headers: auth() });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.site_id, site.id);
    assert.ok(data.exported_at);
    assert.ok(Array.isArray(data.tables.contacts));
    const row = data.tables.contacts.find(c => c.email === exportEmail);
    assert.ok(row, "contatto presente nell'export");
    assert.deepEqual(row.tags, ["lead", "web"]);
    assert.equal(row.status, "nuovo");
    assert.equal(Number(row.value_estimate), 1200);
  });

  test("export CSV: header fisso + riga con email", async () => {
    await setContactFields(site.id, csvEmail, { tags: ["csv"], status: "contattato", notes: "" });

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-export?format=csv`, { headers: auth() });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    const csv = await res.text();
    const header = "email,name,tags,status,notes,value_estimate,score,utm_source,utm_medium,utm_campaign,created_at";
    assert.ok(csv.startsWith(header), "header CSV esatto");
    const lines = csv.split("\r\n");
    assert.ok(lines.some(l => l.startsWith(`${csvEmail},`)), "riga contatto nel CSV");
  });

  test("import contacts: 2 valide + 1 senza email → imported 2, skipped 1, job done", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-import`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "contacts",
        created_by: user.email,
        rows: [
          { email: "imp-a@example.test", name: "A", tags: "a,b", status: "nuovo" },
          { email: "imp-b@example.test", name: "B", tags: ["b"], notes: "nota b" },
          { name: "Senza Email" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.imported, 2);
    assert.equal(body.skipped, 1);
    assert.ok(body.job_id);
    assert.deepEqual(body.errors, [{ row: 2, error: "email mancante o non valida" }]);

    const jobRow = (await query("SELECT * FROM import_jobs WHERE id = $1", [body.job_id])).rows[0];
    assert.ok(jobRow);
    assert.equal(jobRow.kind, "contacts");
    assert.equal(jobRow.status, "done");
    assert.equal(jobRow.created_by, user.email);
    assert.equal(jobRow.stats.imported, 2);
    assert.equal(jobRow.stats.skipped, 1);

    const stored = (await query(
      "SELECT email, tags, status, notes FROM contacts WHERE site_id = $1 AND email = ANY($2) ORDER BY email",
      [site.id, ["imp-a@example.test", "imp-b@example.test"]]
    )).rows;
    assert.equal(stored.length, 2);
    const a = stored.find(c => c.email === "imp-a@example.test");
    assert.deepEqual(a.tags, ["a", "b"]);
    const b = stored.find(c => c.email === "imp-b@example.test");
    assert.equal(b.notes, "nota b");
  });

  test("import upsert: stessa email → aggiorna senza duplicare", async () => {
    const first = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-import`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "contacts",
        rows: [{ email: "upsert@example.test", tags: "primo", status: "nuovo", value_estimate: 500 }],
      }),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-import`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "contacts",
        rows: [{ email: "upsert@example.test", tags: "secondo", status: "vinto", value_estimate: 900 }],
      }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.imported, 1);

    const rows = (await query(
      "SELECT email, tags, status, value_estimate FROM contacts WHERE site_id = $1 AND email = $2",
      [site.id, "upsert@example.test"]
    )).rows;
    assert.equal(rows.length, 1, "nessun duplicato dopo l'upsert");
    assert.deepEqual(rows[0].tags, ["secondo"]);
    assert.equal(rows[0].status, "vinto");
    assert.equal(Number(rows[0].value_estimate), 900);
  });

  test("import crm: contatti + task in un unico job", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-import`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "crm",
        created_by: user.email,
        contacts: [{ email: "crm-c@example.test", tags: "crm" }],
        tasks: [
          { title: "Chiamare crm-c", email: "crm-c@example.test", due_at: "2026-09-01T10:00:00Z", notes: "follow-up" },
          { notes: "task senza titolo" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.imported, 1);
    assert.equal(body.tasks_imported, 1);
    assert.equal(body.tasks_skipped, 1);
    assert.ok(body.job_id);

    const jobRow = (await query("SELECT * FROM import_jobs WHERE id = $1", [body.job_id])).rows[0];
    assert.equal(jobRow.kind, "crm");
    assert.equal(jobRow.status, "done");
    assert.equal(jobRow.stats.tasks_imported, 1);

    const tasks = (await query(
      "SELECT title, email, notes, due_at FROM tasks WHERE site_id = $1 AND email = $2",
      [site.id, "crm-c@example.test"]
    )).rows;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, "Chiamare crm-c");
    assert.equal(tasks[0].notes, "follow-up");
    assert.ok(tasks[0].due_at);
  });

  test("listImportJobs: lista i job del sito (più recenti prima)", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/import-jobs?limit=10`, { headers: auth() });
    assert.equal(res.status, 200);
    const { jobs } = await res.json();
    assert.ok(Array.isArray(jobs));
    assert.ok(jobs.length >= 4, "almeno i 4 job creati nei test precedenti");
    assert.ok(jobs.every(j => j.site_id === site.id));
    // Ordinati dal più recente
    for (let i = 1; i < jobs.length; i++) {
      assert.ok(new Date(jobs[i - 1].created_at) >= new Date(jobs[i].created_at));
    }
  });

  test("export con tabella inesistente → 400", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/data-export?tables=contatcs`, { headers: auth() });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /contatcs/);
  });

  test("accesso cross-site → 403 Accesso negato", async () => {
    const otherSite = await createTestSite("Altro Sito");
    const res = await fetch(`${baseUrl}/api/agent/sites/${otherSite.id}/data-export`, { headers: auth() });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, "Accesso negato");
  });
});
