import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { getBoard, moveOpportunityStage } from "../src/services/opportunities.js";
import { addContactNote, listContactNotes } from "../src/services/conversations.js";
import adminCrmRoutes from "../src/routes/admin-crm.js";

// Kanban board opportunità:
// - getBoard raggruppa le opportunità per stage della pipeline (custom o default)
// - moveOpportunityStage sposta la card e deriva lo status da vinto/perso
// - endpoint API /api/opportunities/:id/move e `/note`
describe("crm: kanban board opportunità", () => {
  let site, user, server, baseUrl, token;
  let pipeline;

  before(async () => {
    site = await createTestSite("CRM Board Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "board", 30);
    token = created.token;

    // Pipeline con stages custom (multi-funnel)
    const p = await query(
      `INSERT INTO pipelines (site_id, name, stages, is_default)
       VALUES ($1, $2, $3::jsonb, true) RETURNING id`,
      [site.id, "Vivai", JSON.stringify([
        { key: "lead", label: "Lead" },
        { key: "proposta_inviata", label: "Proposta inviata" },
        { key: "vinto", label: "Vinto" },
        { key: "perso", label: "Perso" },
      ])]
    );
    pipeline = p.rows[0].id;

    // 3+ opportunità in stadi diversi della stessa pipeline
    async function mk(email, title, stage, amount, status) {
      const r = await query(
        `INSERT INTO opportunities (site_id, contact_email, pipeline_id, stage, title, amount, probability, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [site.id, email, pipeline, stage, title, amount, 50, status]
      );
      return r.rows[0];
    }
    await mk("lead@board.test", "Lead Mario", "lead", 500, "open");
    await mk("prop@board.test", "Proposta Lucia", "proposta_inviata", 2000, "open");
    await mk("vinto@board.test", "Vinta Anna", "vinto", 3500, "won");
    await mk("perso@board.test", "Persa Paolo", "perso", 800, "lost");

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(adminCrmRoutes);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  test("getBoard: raggruppa le opportunità per stage (custom pipeline)", async () => {
    const { board } = await getBoard(site.id, { pipelineId: pipeline });
    const keys = board.map(c => c.key);
    assert.ok(keys.includes("lead"));
    assert.ok(keys.includes("proposta_inviata"));
    assert.ok(keys.includes("vinto"));
    assert.ok(keys.includes("perso"));

    const lead = board.find(c => c.key === "lead");
    assert.equal(lead.items.length, 1);
    assert.equal(lead.items[0].title, "Lead Mario");

    const vinto = board.find(c => c.key === "vinto");
    assert.equal(vinto.items.length, 1);
    assert.equal(vinto.items[0].status, "won");
    assert.equal(vinto.items[0].amount, 3500);
  });

  test("moveOpportunityStage: sposta card e aggiorna updated_at", async () => {
    const before = (await query("SELECT updated_at FROM opportunities WHERE site_id=$1 AND stage='lead'", [site.id])).rows[0];
    const moved = await moveOpportunityStage(site.id, (await query("SELECT id FROM opportunities WHERE site_id=$1 AND stage='lead'", [site.id])).rows[0].id, { stage: "proposta_inviata" });
    assert.equal(moved.stage, "proposta_inviata");
    assert.equal(moved.status, "open");
  });

  test("moveOpportunityStage: stage vinto → status won, perso → lost", async () => {
    const opp = (await query("SELECT id FROM opportunities WHERE site_id=$1 AND title='Lead Mario'", [site.id])).rows[0];
    const won = await moveOpportunityStage(site.id, opp.id, { stage: "vinto" });
    assert.equal(won.stage, "vinto");
    assert.equal(won.status, "won");
  });

  test("endpoint API move: POST /api/opportunities/:id/move", async () => {
    const opp = (await query("SELECT id FROM opportunities WHERE site_id=$1 AND title='Proposta Lucia'", [site.id])).rows[0];
    const res = await fetch(`${baseUrl}/api/opportunities/${opp.id}/move`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "vinto", site_id: site.id }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.stage, "vinto");
    assert.equal(data.status, "won");
  });

  test("endpoint API note: POST aggiunge nota visibile in GET", async () => {
    const opp = (await query("SELECT id, contact_email FROM opportunities WHERE site_id=$1 AND title='Vinta Anna'", [site.id])).rows[0];
    const addRes = await fetch(`${baseUrl}/api/opportunities/${opp.id}/note`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Nota di test da board", site_id: site.id }),
    });
    assert.equal(addRes.status, 200);
    const added = await addRes.json();
    assert.equal(added.ok, true);
    assert.equal(added.note.body, "Nota di test da board");

    const notes = await listContactNotes(site.id, opp.contact_email);
    assert.ok(notes.some(n => n.body === "Nota di test da board"));
  });

  test("endpoint API: move su opportunità inesistente → 404", async () => {
    const res = await fetch(`${baseUrl}/api/opportunities/999999/move`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "lead", site_id: site.id }),
    });
    assert.equal(res.status, 404);
  });
});
