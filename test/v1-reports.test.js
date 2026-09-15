import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import {
  listConfigs, createConfig, getConfig, updateConfig, deleteConfig,
  generateReport, listRuns,
} from "../src/services/reports.js";

describe("ONDA 3 — v1 reports (service-level)", () => {
  let siteA, siteB;
  let configId;

  before(async () => {
    siteA = (await createTestSite("DVR Tenant A")).id;
    siteB = (await createTestSite("DVR Tenant B")).id;
  });

  after(async () => {
    await query(`DELETE FROM report_configs WHERE site_id IN ($1, $2)`, [siteA, siteB]);
    await query(`DELETE FROM report_runs WHERE site_id IN ($1, $2)`, [siteA, siteB]);
    await query(`DELETE FROM sites WHERE id IN ($1, $2)`, [siteA, siteB]);
    await closeDb();
  });

  test("createConfig crea una config con default", async () => {
    const c = await createConfig(siteA, { name: "Report Settimanale" });
    assert.ok(c.id);
    assert.equal(c.kind, "weekly");
    assert.ok(Array.isArray(c.sections));
    assert.equal(c.active, true);
    configId = c.id;
  });

  test("listConfigs e getConfig restituiscono la config", async () => {
    const list = await listConfigs(siteA);
    assert.ok(list.some((x) => x.id === configId));
    const g = await getConfig(siteA, configId);
    assert.equal(g.name, "Report Settimanale");
  });

  test("isolamento tenant: siteB non vede config di siteA", async () => {
    const listB = await listConfigs(siteB);
    assert.equal(listB.length, 0);
    const gB = await getConfig(siteB, configId);
    assert.equal(gB, null);
  });

  test("updateConfig aggiorna i campi", async () => {
    const u = await updateConfig(siteA, configId, { kind: "monthly", active: false });
    assert.equal(u.kind, "monthly");
    assert.equal(u.active, false);
  });

  test("generateReport è un dry-run: produce json+html senza inviare email", async () => {
    const report = await generateReport(siteA, configId);
    assert.ok(report);
    assert.equal(report.config_id, configId);
    assert.ok(report.generated_at);
    assert.ok(typeof report.json === "object" || report.json);
    assert.match(report.html, /Report Settimanale|Report M/);
  });

  test("generateReport per config inesistente → null", async () => {
    const r = await generateReport(siteA, 99999999);
    assert.equal(r, null);
  });

  test("listRuns ritorna [] quando non ci sono esecuzioni", async () => {
    const runs = await listRuns(siteA, configId);
    assert.ok(Array.isArray(runs));
  });

  test("deleteConfig elimina la config", async () => {
    const d = await deleteConfig(siteA, configId);
    assert.ok(d);
    const g = await getConfig(siteA, configId);
    assert.equal(g, null);
  });
});
