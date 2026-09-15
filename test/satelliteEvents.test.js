import crypto from "crypto";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import agentRouter from "../src/routes/agent.js";
import satelliteEventsRouter from "../src/routes/satellite-events.js";
import { createSatellite } from "../src/services/satellites.js";
import { publishEvent, markDelivered } from "../src/services/satelliteEvents.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { query } from "../src/db.js";

// F2 — Eventi asincroni tra satelliti (polling-only): dedupe, perimetro
// inbox per-target (nome risalito da sso_satellites.user_id), ack
// idempotente, vista superadmin.
describe("satelliti F2: eventi (inbox/outbox)", () => {
  let site, superadminToken, tokenA, tokenB, unboundToken;
  let nameA, nameB;
  let server, baseUrl;
  const unique = () => crypto.randomBytes(4).toString("hex");
  const auth = (t) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  async function makeBoundSatellite(prefix, userId) {
    const name = `${prefix}-${unique()}`;
    const sat = await createSatellite({ name, origin: `https://${name}.example.test`, user_id: userId });
    assert.ok(sat);
    return name;
  }

  async function post(token, body) {
    return fetch(`${baseUrl}/api/agent/events`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify(body),
    });
  }

  before(async () => {
    site = await createTestSite("Satellite Events Test");
    const superadmin = await createTestUser(site.id, "superadmin");
    const userA = await createTestUser(site.id, "admin");
    const userB = await createTestUser(site.id, "admin");
    const unbound = await createTestUser(site.id, "admin");
    superadminToken = (await createApiToken(superadmin.id, "ev super", 30, ["read", "write"])).token;
    tokenA = (await createApiToken(userA.id, "ev A", 30, ["read", "write"])).token;
    tokenB = (await createApiToken(userB.id, "ev B", 30, ["read", "write"])).token;
    unboundToken = (await createApiToken(unbound.id, "ev unbound", 30, ["read", "write"])).token;

    nameA = await makeBoundSatellite("sata", userA.id);
    nameB = await makeBoundSatellite("satb", userB.id);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      res.locals.t = (k) => k;
      res.locals.lang = "it";
      res.locals.app = { name: "CMS" };
      next();
    });
    app.use(agentRouter);
    app.use(satelliteEventsRouter);
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.closeAllConnections?.(); server.close(); await closeDb(); });

  test("publish diretta al service: ritorna evento; target inesistente → EventError", async () => {
    const evt = await publishEvent({
      source: nameA, type: "opportunity_won", target: nameB,
      payload: { opportunityId: 7 }, dedupeKey: "svc-dedupe-1",
    });
    assert.ok(evt.id);
    assert.equal(evt.status, "pending");
    const dup = await publishEvent({
      source: nameA, type: "opportunity_won", target: nameB,
      payload: { opportunityId: 7 }, dedupeKey: "svc-dedupe-1",
    });
    assert.equal(dup, null); // duplicato: nessuna seconda riga
    const count = (await query(
      "SELECT COUNT(*)::int AS n FROM satellite_events WHERE source=$1 AND dedupe_key='svc-dedupe-1'",
      [nameA]
    )).rows[0].n;
    assert.equal(count, 1);
  });

  test("publish via API: source forzata al satellite chiamante; dedupe → duplicate:true", async () => {
    const key = "api-" + unique();
    const r1 = await post(tokenA, { type: "escalation.triggered", target: nameB, payload: { level: 2 }, dedupeKey: key });
    assert.equal(r1.status, 201);
    const e1 = (await r1.json()).event;
    assert.equal(e1.source, nameA);

    const r2 = await post(tokenA, { type: "escalation.triggered", target: nameB, payload: { level: 2 }, dedupeKey: key });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).duplicate, true);
  });

  test("target sconosciuto → 404; senza binding → 403 satellite_not_bound", async () => {
    const badTarget = await post(tokenA, { type: "x.y", target: "fantasma-" + unique(), payload: {} });
    assert.equal(badTarget.status, 404);
    assert.equal((await badTarget.json()).error, "satellite_not_found");

    // Un token di un utente senza riga sso_satellites collegata.
    const noBind = await fetch(`${baseUrl}/api/agent/events/inbox`, { headers: auth(unboundToken) });
    assert.equal(noBind.status, 403);
    assert.equal((await noBind.json()).error, "satellite_not_bound");
    const noBindPost = await post(unboundToken, { type: "x.y", payload: {} });
    assert.equal(noBindPost.status, 403);
  });

  test("inbox per-target: B vede i suoi + broadcast; A non vede quelli di B", async () => {
    await post(tokenB, { type: "b.private", target: nameB, payload: { k: 1 } });
    await post(tokenB, { type: "broadcast.all", payload: { k: 2 } }); // target default '*'
    await post(tokenA, { type: "a.private", target: nameA, payload: { k: 3 } });

    const inboxB = await (await fetch(`${baseUrl}/api/agent/events/inbox`, { headers: auth(tokenB) })).json();
    const typesB = inboxB.events.map((e) => e.type);
    assert.ok(typesB.includes("b.private"));
    assert.ok(typesB.includes("broadcast.all"));
    assert.ok(!typesB.includes("a.private"));

    const inboxA = await (await fetch(`${baseUrl}/api/agent/events/inbox`, { headers: auth(tokenA) })).json();
    const typesA = inboxA.events.map((e) => e.type);
    assert.ok(typesA.includes("a.private"));
    assert.ok(!typesA.includes("b.private"));
  });

  test("ack idempotente; ack solo del destinatario (altri → 404)", async () => {
    const created = await post(tokenB, { type: "to.ack", target: nameB, payload: {} });
    const evt = (await created.json()).event;

    const ack1 = await fetch(`${baseUrl}/api/agent/events/${evt.id}/ack`, { method: "POST", headers: auth(tokenB) });
    assert.equal(ack1.status, 200);
    assert.equal((await ack1.json()).event.status, "acked");

    const ack2 = await fetch(`${baseUrl}/api/agent/events/${evt.id}/ack`, { method: "POST", headers: auth(tokenB) });
    assert.equal(ack2.status, 200);
    assert.equal((await ack2.json()).already_acked, true);

    // Evento per B: A non è destinatario → 404.
    const forB = (await (await post(tokenA, { type: "for.b.only", target: nameB, payload: {} })).json()).event;
    const wrongAck = await fetch(`${baseUrl}/api/agent/events/${forB.id}/ack`, { method: "POST", headers: auth(tokenA) });
    assert.equal(wrongAck.status, 404);
    // B invece ci riesce.
    const rightAck = await fetch(`${baseUrl}/api/agent/events/${forB.id}/ack`, { method: "POST", headers: auth(tokenB) });
    assert.equal(rightAck.status, 200);
  });

  test("vista generale solo superadmin", async () => {
    const asSuper = await fetch(`${baseUrl}/api/agent/events?status=pending&limit=5`, { headers: auth(superadminToken) });
    assert.equal(asSuper.status, 200);
    assert.ok(Array.isArray((await asSuper.json()).events));

    const asAdmin = await fetch(`${baseUrl}/api/agent/events`, { headers: auth(tokenA) });
    assert.equal(asAdmin.status, 403);
  });

  test("markDelivered aggiorna attempts/status (stub per push futuro)", async () => {
    const evt = await publishEvent({ source: nameA, type: "push.me", target: nameB, payload: {}, dedupeKey: "mk-" + unique() });
    const delivered = await markDelivered(evt.id);
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attempts, 1);
    const failed = await markDelivered(evt.id, { error: "boom" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.last_error, "boom");
  });
});
