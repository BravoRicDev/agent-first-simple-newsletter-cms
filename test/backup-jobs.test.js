import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerBackupJobsRoutes } from "../src/routes/agent-backup-jobs.js";
import { BACKUP_DIR } from "../src/services/backup-jobs.js";

// Feature 43 — Backup automatici con storico.
// Il job viene registrato in backup_jobs SEMPRE (anche failed: se pg_dump
// manca nel container il POST risponde comunque 200 con status 'failed').
// Niente import di agentRouter: il modulo route viene montato su un router
// locale con requireAuth + requireAgent, come prescritto per i moduli
// registrati dal router padre.
describe("crm: backup automatici con storico", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Backup Jobs Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm backup jobs", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerBackupJobsRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
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
  const jobsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/backup-jobs${extra}`;

  test("POST backup kind 'db' → job registrato (done o failed, mai running)", async () => {
    const res = await fetch(jobsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "db" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Number.isInteger(body.job_id), `job_id presente: ${JSON.stringify(body)}`);
    assert.ok(
      body.status === "done" || body.status === "failed",
      `status terminale (done|failed), ricevuto: ${body.status}`
    );
    assert.equal(body.job.id, body.job_id);
    assert.equal(body.job.kind, "db");
    assert.equal(body.job.created_by, "manual");
    assert.equal(body.job.site_id, site.id);

    // Riga persistita in DB con lo stesso status (il job NON può sparire).
    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM backup_jobs WHERE id = $1 AND site_id = $2",
      [body.job_id, site.id]
    )).rows[0];
    assert.equal(rows.c, 1, "job persistito in backup_jobs");
  });

  test("listJobs contiene il job appena creato", async () => {
    const create = await fetch(jobsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "db" }),
    });
    const { job_id } = await create.json();
    assert.ok(job_id, "secondo job creato");

    const list = await fetch(jobsUrl(), { headers: auth() });
    assert.equal(list.status, 200);
    const { jobs } = await list.json();
    assert.ok(Array.isArray(jobs), "jobs è un array");
    assert.ok(jobs.some(j => j.id === job_id), `job ${job_id} presente nello storico`);
    assert.ok(jobs.some(j => j.kind === "db"), "storico con kind db");
    // Ordinati dal più recente.
    const times = jobs.map(j => new Date(j.created_at).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i], "ordinati per created_at DESC");
  });

  test("getJob ritorna il dettaglio del job", async () => {
    const create = await fetch(jobsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "media" }),
    });
    const { job_id } = await create.json();
    assert.ok(job_id, "job media creato");

    const res = await fetch(jobsUrl(`/${job_id}`), { headers: auth() });
    assert.equal(res.status, 200);
    const { job } = await res.json();
    assert.equal(job.id, job_id);
    assert.equal(job.kind, "media");
    assert.equal(job.site_id, site.id);
    assert.ok(["done", "failed"].includes(job.status), `status terminale: ${job.status}`);
    assert.ok(job.completed_at, "completed_at valorizzato (job terminato)");
  });

  test("delete → rimuove il job (e il file se in backups/)", async () => {
    // Usiamo kind 'media': lo zip media-<site>-<ts>.zip è un artefatto creato
    // dal test e la delete lo rimuove davvero dal disco. Un job 'db' può
    // invece puntare ad auto-<oggi>.sql.gz già esistente (creato dallo
    // scheduler di produzione): NON va cancellato dai test.
    const create = await fetch(jobsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "media" }),
    });
    const { job_id, job } = await create.json();
    assert.ok(job_id, "job creato per la delete");
    if (job.file_path.startsWith("backups/")) {
      const fs = await import("fs");
      assert.ok(fs.existsSync(path.join(BACKUP_DIR, job.file_path.slice("backups/".length))), "file fisico presente prima della delete");
    }

    const del = await fetch(jobsUrl(`/${job_id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, job_id);

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM backup_jobs WHERE id = $1 AND site_id = $2",
      [job_id, site.id]
    )).rows[0];
    assert.equal(rows.c, 0, "riga eliminata");

    if (job.file_path.startsWith("backups/")) {
      const fs = await import("fs");
      assert.ok(!fs.existsSync(path.join(BACKUP_DIR, job.file_path.slice("backups/".length))), "file fisico rimosso dalla delete");
    }

    // Seconda delete → 404.
    const again = await fetch(jobsUrl(`/${job_id}`), { method: "DELETE", headers: auth() });
    assert.equal(again.status, 404);
  });

  test("getJob su job inesistente → 404", async () => {
    const res = await fetch(jobsUrl("/999999"), { headers: auth() });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "Backup non trovato");
  });

  test("accesso ad altro sito → 403", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/999999/backup-jobs`, { headers: auth() });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Accesso negato");

    const post = await fetch(`${baseUrl}/api/agent/sites/999999/backup-jobs`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "db" }),
    });
    assert.equal(post.status, 403);
  });
});
