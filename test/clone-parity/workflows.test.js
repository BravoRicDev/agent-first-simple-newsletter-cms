import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Round 16: Workflows GHL — clone API in sola lettura su ghl_workflows
// (copia dei payload REALI sincronizzati dal mapper source-sync
// "ghl-workflows"). L'unico id è ghl_id (quello reale di GHL): la tabella
// non ha external_id/UUID proprio → niente doppio id, il payload viene
// servito integrale (parità byte-per-byte con la risposta sorgente).
describe("Clone API — Workflows GHL (round 16, sola lettura)", () => {
  let server;
  let site;
  let otherSite;
  let apiKey;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = res.ok ? await res.json() : null;
    return { status: res.status, data };
  };

  // Payload REAListici stile risposta GHL GET /workflows/
  const wf1 = {
    id: "WdR7fLdXl6WkVjJZ4d7e",
    name: "Welcome SMS flow",
    status: "ON",
    steps: [{ id: "step1", type: "sms", name: "Send SMS" }],
    triggers: [{ id: "tr1", type: "contact_created" }],
    dateAdded: "2026-08-01T10:00:00.000Z",
    dateUpdated: "2026-08-20T12:30:00.000Z",
  };
  const wf2 = {
    id: "Xk9mPqRsTuVwYz012345",
    name: "Lead nurture",
    status: "OFF",
    dateAdded: "2026-08-05T09:00:00.000Z",
    dateUpdated: "2026-08-25T14:00:00.000Z",
  };

  before(async () => {
    site = await createTestSite("Workflows Clone");
    otherSite = await createTestSite("Workflows Other");
    apiKey = await mkKey(site.id, "test key");

    await query(
      `INSERT INTO ghl_workflows (site_id, ghl_id, name, status, payload)
       VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $9), ($10, $11, $12, $13, $14)`,
      [
        site.id, wf1.id, wf1.name, wf1.status, JSON.stringify(wf1),
        wf2.id, wf2.name, wf2.status, JSON.stringify(wf2),
        otherSite.id, "OtherSiteWf0000000001", "Altro sito", "ON", JSON.stringify({ id: "OtherSiteWf0000000001", name: "Altro sito" }),
      ]
    );

    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  test("GET /workflows → lista con payload integrali e meta, solo il proprio sito", async () => {
    const res = await fetch("/workflows");
    assert.equal(res.status, 200);
    assert(Array.isArray(res.data.workflows));
    assert.equal(res.data.workflows.length, 2, "solo i workflow del sito corrente (altro sito escluso)");
    assert.equal(res.data.meta.total, 2);

    // Parità byte-per-byte: i payload serviti sono identici a quelli GHL
    // sincronizzati (nessuna trasformazione/rinomina).
    const served1 = res.data.workflows.find((w) => w.id === wf1.id);
    assert.ok(served1, "wf1 presente");
    assert.deepEqual(served1, wf1);
    const served2 = res.data.workflows.find((w) => w.id === wf2.id);
    assert.deepEqual(served2, wf2);

    // Campi originali GHL conservati (steps/triggers annidati inclusi)
    assert.equal(served1.steps[0].type, "sms");
    assert.equal(served1.triggers[0].type, "contact_created");
  });

  test("GET /workflows/:id → workflow singolo per ghl_id reale, payload integrale", async () => {
    const res = await fetch(`/workflows/${wf1.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.workflow, wf1);
  });

  test("GET /workflows con cursore: limit=1 → nextPage = ghl_id, pagina 2 coerente", async () => {
    const p1 = await fetch("/workflows?limit=1");
    assert.equal(p1.status, 200);
    assert.equal(p1.data.workflows.length, 1);
    assert.equal(p1.data.workflows[0].id, wf1.id);
    assert.equal(p1.data.meta.nextPage, wf1.id, "nextPage = ghl_id reale dell'ultimo restituito");

    const p2 = await fetch(`/workflows?limit=1&startAfterId=${wf1.id}`);
    assert.equal(p2.status, 200);
    assert.equal(p2.data.workflows.length, 1);
    assert.equal(p2.data.workflows[0].id, wf2.id, "il cursore ghl_id scorve davvero");
  });

  test("Errori: id inesistente → 404, id malformato (300 char) → 400, workflow di altro sito non visibile", async () => {
    const missing = await fetch("/workflows/ghlWORKFLOWinesistente1");
    assert.equal(missing.status, 404);

    const bad = await fetch(`/workflows/${"x".repeat(300)}`);
    assert.equal(bad.status, 400);

    // Il workflow dell'ALTRO sito non deve essere risolvibile dal nostro tenant
    const cross = await fetch("/workflows/OtherSiteWf0000000001");
    assert.equal(cross.status, 404, "scope per sito: workflow altrui invisibile");
  });

  test("Sola lettura: POST/PUT/DELETE /workflows → 404 (niente scrittura: engine GHL reale non replicabile qui)", async () => {
    const post = await fetch("/workflows", { method: "POST", body: JSON.stringify({ name: "x" }) });
    assert.equal(post.status, 404);
    const put = await fetch(`/workflows/${wf1.id}`, { method: "PUT", body: JSON.stringify({ name: "x" }) });
    assert.equal(put.status, 404);
    const del = await fetch(`/workflows/${wf1.id}`, { method: "DELETE" });
    assert.equal(del.status, 404);
  });
});
