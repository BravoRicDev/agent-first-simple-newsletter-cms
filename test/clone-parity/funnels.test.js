import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Round 17: Funnels GHL — clone API sola lettura su ghl_funnels (copia del
// sorgente GET /funnels/funnel/list sincronizzata dal mapper "funnels").
// Verificato sullo schema reale: ghl_funnels NON ha external_id proprio →
// l'unico id pubblico è ghl_id (quello reale di GHL, 20 char alfanumerici):
// niente doppio id, pattern "mirror" come ghl_workflows (round 16).
describe("Clone API — Funnels GHL (round 17, sola lettura)", () => {
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

  // id reali stile GHL (20 char alfanumerici, NON uuid-valid)
  const fn1 = {
    ghlId: "1g9OWTij9iU9yzKXOyWb",
    name: "Funnel Prenotazione Calcolatore",
    steps: [
      { id: "s1", name: "Landing", type: "page", url: "/landing" },
      { id: "s2", name: "Grazie", type: "page", url: "/grazie" },
    ],
  };
  const fn2 = {
    ghlId: "jzrgvZrlen7XwmvvNaKF",
    name: "Funnel Ads Margine",
    steps: [{ id: "s3", name: "Opt-in", type: "form" }],
  };

  before(async () => {
    site = await createTestSite("Funnels Clone");
    otherSite = await createTestSite("Funnels Other");
    apiKey = await mkKey(site.id, "test key");

    await query(
      `INSERT INTO ghl_funnels (site_id, ghl_id, name, steps)
       VALUES ($1, $2, $3, $4), ($1, $5, $6, $7), ($8, $9, $10, $11)`,
      [
        site.id, fn1.ghlId, fn1.name, JSON.stringify(fn1.steps),
        fn2.ghlId, fn2.name, JSON.stringify(fn2.steps),
        otherSite.id, "OtherSiteFunnel000001", "Funnel altro sito", JSON.stringify([]),
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

  test("GET /funnels → lista con id = ghl_id reale e steps integrali, solo il proprio sito", async () => {
    const res = await fetch("/funnels");
    assert.equal(res.status, 200);
    assert(Array.isArray(res.data.funnels));
    assert.equal(res.data.funnels.length, 2, "solo i funnel del sito corrente");
    assert.equal(res.data.meta.total, 2);

    const served1 = res.data.funnels.find((f) => f.id === fn1.ghlId);
    assert.ok(served1, "fn1 presente con il suo ghl_id REALE come id");
    assert.equal(served1.name, fn1.name);
    // steps serviti integrali (nessuna trasformazione): confronto profondo
    assert.deepEqual(served1.steps, fn1.steps);
    assert.ok(served1.dateAdded, "dateAdded presente");
  });

  test("GET /funnels/:id → singolo funnel per ghl_id reale", async () => {
    const res = await fetch(`/funnels/${fn2.ghlId}`);
    assert.equal(res.status, 200);
    assert.equal(res.data.funnel.id, fn2.ghlId);
    assert.deepEqual(res.data.funnel.steps, fn2.steps);
  });

  test("GET /funnels con cursore: nextPage = ghl_id, pagina 2 coerente", async () => {
    const p1 = await fetch("/funnels?limit=1");
    assert.equal(p1.status, 200);
    assert.equal(p1.data.funnels.length, 1);
    assert.equal(p1.data.funnels[0].id, fn1.ghlId);
    assert.equal(p1.data.meta.nextPage, fn1.ghlId, "nextPage = ghl_id dell'ultimo restituito");

    const p2 = await fetch(`/funnels?limit=1&startAfterId=${fn1.ghlId}`);
    assert.equal(p2.status, 200);
    assert.equal(p2.data.funnels.length, 1);
    assert.equal(p2.data.funnels[0].id, fn2.ghlId, "il cursore ghl_id scorre davvero");
  });

  test("Errori: id inesistente → 404, id malformato (300 char) → 400, funnel di altro sito non visibile", async () => {
    const missing = await fetch("/funnels/ghlFUNNELinesistente001");
    assert.equal(missing.status, 404);

    const bad = await fetch(`/funnels/${"x".repeat(300)}`);
    assert.equal(bad.status, 400);

    const cross = await fetch("/funnels/OtherSiteFunnel000001");
    assert.equal(cross.status, 404, "scope per sito: funnel altrui invisibile");
  });

  test("Sola lettura: POST/PUT/DELETE /funnels → 404 (funnel = pubblicazione editor GHL, non replicabile qui)", async () => {
    const post = await fetch("/funnels", { method: "POST", body: JSON.stringify({ name: "x" }) });
    assert.equal(post.status, 404);
    const put = await fetch(`/funnels/${fn1.ghlId}`, { method: "PUT", body: JSON.stringify({ name: "x" }) });
    assert.equal(put.status, 404);
    const del = await fetch(`/funnels/${fn1.ghlId}`, { method: "DELETE" });
    assert.equal(del.status, 404);
  });
});
