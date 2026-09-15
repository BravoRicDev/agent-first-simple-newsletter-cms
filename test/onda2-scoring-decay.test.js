import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import { applyScoreDecay, sanitizeScoringThreshold } from "../src/services/scoring.js";
import { resetTickCounter } from "../src/services/tick.js";

// ONDA2 Phase 6: decadimento scoring configurabile per sito
// (scoring_decay_rate/scoring_decay_days via settings) + azioni scattate
// quando il punteggio scende sotto una soglia 'below'.
describe("crm: scoring decay configurabile + soglie below", () => {
  let site, user, token, server, baseUrl;

  before(async () => {
    site = await createTestSite("CRM Decay Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "decay", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  beforeEach(() => resetTickCounter());

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const api = (path, opts = {}) => fetch(`${baseUrl}${path}`, {
    ...opts,
    headers: { ...auth(), ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });

  test("(a) default: rate 0.95 / periodo 1 giorno (nessuna config di sito)", async () => {
    const email = uniqueEmail("decay-default");
    await query(
      `INSERT INTO contacts (site_id, email, score, score_updated_at)
       VALUES ($1, $2, 100, NOW() - INTERVAL '3 days')`,
      [site.id, email]
    );
    const { decayed } = await applyScoreDecay(site.id);
    assert.ok(decayed >= 1);
    const contact = (await query("SELECT score FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.equal(contact.score, Math.round(100 * Math.pow(0.95, 3)));
  });

  test("(b) config per sito: rate/giorni custom via settings", async () => {
    await query(
      `INSERT INTO settings (site_id, key, value) VALUES ($1, 'scoring_decay_rate', '0.5')
       ON CONFLICT (site_id, key) DO UPDATE SET value = '0.5'`,
      [site.id]
    );
    await query(
      `INSERT INTO settings (site_id, key, value) VALUES ($1, 'scoring_decay_days', '2')
       ON CONFLICT (site_id, key) DO UPDATE SET value = '2'`,
      [site.id]
    );

    const email = uniqueEmail("decay-custom");
    await query(
      `INSERT INTO contacts (site_id, email, score, score_updated_at)
       VALUES ($1, $2, 80, NOW() - INTERVAL '5 days')`,
      [site.id, email]
    );
    const { decayed } = await applyScoreDecay(site.id);
    assert.ok(decayed >= 1);
    const contact = (await query("SELECT score FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    // 5 giorni / periodo 2gg = 2 periodi interi
    assert.equal(contact.score, Math.round(80 * Math.pow(0.5, 2)));

    await query("DELETE FROM settings WHERE site_id = $1 AND key IN ('scoring_decay_rate','scoring_decay_days')", [site.id]);
  });

  test("(c) contatto aggiornato di recente non decade", async () => {
    const email = uniqueEmail("decay-fresh");
    await query(
      `INSERT INTO contacts (site_id, email, score, score_updated_at) VALUES ($1, $2, 50, NOW())`,
      [site.id, email]
    );
    await applyScoreDecay(site.id);
    const contact = (await query("SELECT score FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.equal(contact.score, 50);
  });

  test("(d) soglia trigger_on='below': scendere sotto min_score esegue l'azione", async () => {
    const thRes = await api(`/api/agent/sites/${site.id}/scoring-thresholds`, {
      method: "POST",
      body: { min_score: 30, action_type: "add_tag", action_config: { tag: "lead-freddo" }, trigger_on: "below" },
    });
    assert.equal(thRes.status, 200);
    const { threshold } = await thRes.json();
    assert.equal(threshold.trigger_on, "below");

    const email = uniqueEmail("decay-threshold");
    await query(
      `INSERT INTO contacts (site_id, email, score, score_updated_at)
       VALUES ($1, $2, 40, NOW() - INTERVAL '10 days')`,
      [site.id, email]
    );
    // 40 * 0.95^10 ≈ 24 → attraversa min_score=30 verso il basso
    await applyScoreDecay(site.id);

    const contact = (await query("SELECT score, tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(contact.score < 30, `punteggio sceso sotto soglia (${contact.score})`);
    assert.ok(contact.tags.includes("lead-freddo"), "azione below-threshold applicata");
  });

  test("(e) soglia 'above' esistente non riscatta su decay", async () => {
    const thRes = await api(`/api/agent/sites/${site.id}/scoring-thresholds`, {
      method: "POST",
      body: { min_score: 5, action_type: "add_tag", action_config: { tag: "non-deve-comparire" } },
    });
    const { threshold } = await thRes.json();
    assert.equal(threshold.trigger_on, "above", "default resta 'above' se non specificato");

    const email = uniqueEmail("decay-above-noop");
    await query(
      `INSERT INTO contacts (site_id, email, score, score_updated_at)
       VALUES ($1, $2, 20, NOW() - INTERVAL '2 days')`,
      [site.id, email]
    );
    await applyScoreDecay(site.id);
    const contact = (await query("SELECT tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(!(contact.tags || []).includes("non-deve-comparire"), "soglia 'above' non scatta sul decadimento");
  });

  test("(f) endpoint /api/agent/tick con run_decay=true applica il decay", async () => {
    const email = uniqueEmail("decay-via-tick");
    await query(
      `INSERT INTO contacts (site_id, email, score, score_updated_at)
       VALUES ($1, $2, 60, NOW() - INTERVAL '4 days')`,
      [site.id, email]
    );
    const res = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: true, run_segments: false } });
    assert.equal(res.status, 200);
    const { tick } = await res.json();
    assert.ok(tick.scoring_decay, "step scoring_decay eseguito");
    assert.ok(tick.scoring_decay.decayed >= 1);

    const contact = (await query("SELECT score FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email])).rows[0];
    assert.ok(contact.score < 60);
  });
});
