import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import { refreshSegments } from "../src/services/segments.js";
import { addContactTag } from "../src/services/contacts.js";
import { resetTickCounter } from "../src/services/tick.js";

// ONDA2 Phase 6: refresh periodico dei segmenti dinamici — a differenza di
// refreshSegmentsForContact (incrementale, per singolo contatto ad ogni
// evento) refreshSegments(siteId) rivaluta TUTTI i contatti conosciuti
// contro TUTTI i segmenti abilitati, aggiungendo nuovi match e rimuovendo
// membri che non soddisfano più le regole (drift senza un nuovo evento).
describe("crm: refresh periodico segmenti dinamici", () => {
  let site, user, token, server, baseUrl, segmentId;

  before(async () => {
    site = await createTestSite("CRM Segment Refresh Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "segrefresh", 30);
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

  test("(a) crea segmento dinamico (tag qualifica-refresh)", async () => {
    const res = await api(`/api/agent/sites/${site.id}/segments`, {
      method: "POST",
      body: { name: "Refresh candidati", rules: [{ field: "tag", op: "has", value: "qualifica-refresh" }], match_mode: "all" },
    });
    assert.equal(res.status, 200);
    const { segment } = await res.json();
    segmentId = segment.id;
  });

  test("(b) contatto con tag aggiunto direttamente in DB (senza evento) entra nel segmento dopo refreshSegments", async () => {
    const email = uniqueEmail("refresh-add");
    // Simula "drift": il tag viene aggiunto senza passare da addContactTag
    // (quindi senza refreshSegmentsForContact incrementale già applicato).
    await query(
      "INSERT INTO contacts (site_id, email, tags) VALUES ($1, $2, ARRAY['qualifica-refresh'])",
      [site.id, email]
    );

    const before = (await query(
      "SELECT COUNT(*)::int AS c FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
      [site.id, segmentId, email]
    )).rows[0].c;
    assert.equal(before, 0, "non ancora membro prima del refresh");

    const result = await refreshSegments(site.id);
    assert.ok(result.added >= 1, `almeno un membro aggiunto (${result.added})`);
    assert.equal(result.segments, 1);

    const after = (await query(
      "SELECT COUNT(*)::int AS c FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
      [site.id, segmentId, email]
    )).rows[0].c;
    assert.equal(after, 1, "membro dopo il refresh");
  });

  test("(c) rimozione tag → refreshSegments rimuove la membership", async () => {
    const email = uniqueEmail("refresh-remove");
    await addContactTag(site.id, email, "qualifica-refresh");
    await refreshSegments(site.id);
    let member = (await query(
      "SELECT 1 FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
      [site.id, segmentId, email]
    )).rows[0];
    assert.ok(member, "membro dopo l'ingresso");

    await query("UPDATE contacts SET tags = '{}' WHERE site_id = $1 AND email = $2", [site.id, email]);
    const result = await refreshSegments(site.id);
    assert.ok(result.removed >= 1, `almeno un membro rimosso (${result.removed})`);

    member = (await query(
      "SELECT 1 FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
      [site.id, segmentId, email]
    )).rows[0];
    assert.ok(!member, "non più membro dopo la rimozione del tag");
  });

  test("(d) segmento disabilitato viene ignorato dal refresh", async () => {
    const res = await api(`/api/agent/sites/${site.id}/segments`, {
      method: "POST",
      body: { name: "Disabilitato", rules: [{ field: "tag", op: "has", value: "mai-usato" }], match_mode: "all" },
    });
    const body = await res.json();
    const disabledId = body.segment.id;
    const disableRes = await api(`/api/agent/sites/${site.id}/segments/${disabledId}`, {
      method: "PUT",
      body: { enabled: false },
    });
    assert.equal(disableRes.status, 200);
    assert.equal((await disableRes.json()).segment.enabled, false);

    const result = await refreshSegments(site.id);
    assert.equal(result.segments, 1, "solo il segmento abilitato viene rivalutato");
    const members = (await query(
      "SELECT COUNT(*)::int AS c FROM segment_members WHERE segment_id = $1",
      [disabledId]
    )).rows[0].c;
    assert.equal(members, 0);
  });

  test("(e) endpoint /api/agent/tick con run_segments=true esegue il refresh", async () => {
    const email = uniqueEmail("refresh-via-tick");
    await query(
      "INSERT INTO contacts (site_id, email, tags) VALUES ($1, $2, ARRAY['qualifica-refresh'])",
      [site.id, email]
    );
    const res = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: false, run_segments: true } });
    assert.equal(res.status, 200);
    const { tick } = await res.json();
    assert.ok(tick.segment_refresh, "step segment_refresh eseguito");
    assert.ok(tick.segment_refresh.added >= 1);

    const member = (await query(
      "SELECT 1 FROM segment_members WHERE site_id = $1 AND segment_id = $2 AND email = $3",
      [site.id, segmentId, email]
    )).rows[0];
    assert.ok(member, "membro aggiunto tramite il tick endpoint");
  });

  test("(f) senza run_segments (default, contatore basso): step saltato", async () => {
    const res = await api("/api/agent/tick", { method: "POST", body: { site_id: site.id, run_decay: false } });
    assert.equal(res.status, 200);
    const { tick } = await res.json();
    assert.equal(tick.tick, 1, "primo tick dopo il reset del contatore");
    assert.equal(tick.segment_refresh, null, "1 % 5 != 0 → refresh segmenti non eseguito di default");
  });
});
