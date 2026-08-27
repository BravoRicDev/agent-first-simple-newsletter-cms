import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { isModuleEnabled, requireModule } from "../src/middleware/modules.js";

describe("moduli opzionali: gate per sito", () => {
  let site, server, baseUrl;

  before(async () => {
    site = await createTestSite("Modules Test");
    await query("INSERT INTO site_modules (site_id, module_key, enabled) VALUES ($1, 'sales_pipeline', true)", [site.id]);

    const app = express();
    app.use((req, res, next) => { res.locals.t = (k) => k; req.user = { role: "admin", site_id: site.id }; next(); });
    app.get("/api/pipeline", requireModule("sales_pipeline"), (req, res) => res.json({ ok: true }));
    app.get("/api/calls", requireModule("call_scheduling"), (req, res) => res.json({ ok: true }));

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.close(); await closeDb(); });

  test("isModuleEnabled riflette lo stato reale in site_modules", async () => {
    assert.equal(await isModuleEnabled(site.id, "sales_pipeline"), true);
    assert.equal(await isModuleEnabled(site.id, "call_scheduling"), false);
  });

  test("requireModule blocca l'accesso a un modulo disattivato (403) e passa quello attivo (200)", async () => {
    const rEnabled = await fetch(`${baseUrl}/api/pipeline`);
    assert.equal(rEnabled.status, 200);

    const rDisabled = await fetch(`${baseUrl}/api/calls`);
    assert.equal(rDisabled.status, 403);
  });

  test("attivare un modulo lo sblocca immediatamente", async () => {
    await query(
      `INSERT INTO site_modules (site_id, module_key, enabled) VALUES ($1, 'call_scheduling', true)
       ON CONFLICT (site_id, module_key) DO UPDATE SET enabled = true`,
      [site.id]
    );
    const r = await fetch(`${baseUrl}/api/calls`);
    assert.equal(r.status, 200);
  });
});
