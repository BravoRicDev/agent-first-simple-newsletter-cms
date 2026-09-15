import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerChannelLimitsRoutes } from "../src/routes/agent-limits.js";
import config from "../src/config.js";
import { resetTransporter } from "../src/services/email.js";

// Feature 44 — Quote/rate-limit per canale con avvisi.
// Niente import di agentRouter: il modulo route viene montato su un router
// locale con requireAuth + requireAgent, come prescritto per i moduli
// registrati dal router padre.
//
// SMTP nei test: forziamo config.smtpHost su 127.0.0.1 (nessun listener)
// così sendEmail fallisce SUBITO con ECONNREFUSED: nessuna email reale
// parte e il consume oltre il limite deve comunque rispondere 200
// (l'avviso è in try/catch) e alzare il flag notified.
//
// SCELTA DI DESIGN (vedi anche src/services/channel-limits.js): senza un
// limite attivo per (canale, periodo) consume() ritorna allowed:true con
// usage:0 e NON crea righe in channel_usage — il test (d) lo verifica.
describe("crm: quote/rate-limit per canale con avvisi", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    config.smtpHost = "127.0.0.1";
    config.smtpPort = 465;
    resetTransporter();

    site = await createTestSite("CRM Channel Limits Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm limits", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerChannelLimitsRoutes(r);

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
  const limitsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/channel-limits${extra}`;
  const usageUrl = (qs = "") => `${baseUrl}/api/agent/sites/${site.id}/channel-usage${qs}`;

  function postLimits(body, extra = "") {
    return fetch(limitsUrl(extra), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function check(body) {
    return postLimits(body, "/check");
  }

  function consume(body) {
    return postLimits(body, "/consume");
  }

  test("(a) CRUD limite: create → list → update → delete → 404, duplicato → 409", async () => {
    // Create.
    const created = await postLimits({ channel: "email", period: "day", max_count: 500 });
    assert.equal(created.status, 200);
    const { limit } = await created.json();
    assert.ok(limit.id, "limite creato con id");
    assert.equal(limit.site_id, site.id);
    assert.equal(limit.channel, "email");
    assert.equal(limit.period, "day");
    assert.equal(limit.max_count, 500);
    assert.equal(limit.notify_email, "");
    assert.equal(limit.active, true);

    // Duplicato (stesso canale+periodo) → 409.
    const dup = await postLimits({ channel: "email", period: "day", max_count: 10 });
    assert.equal(dup.status, 409);
    assert.match((await dup.json()).error, /già esistente/);

    // List.
    const listRes = await fetch(limitsUrl(), { headers: auth() });
    assert.equal(listRes.status, 200);
    const { limits } = await listRes.json();
    assert.ok(Array.isArray(limits));
    assert.ok(limits.some(l => l.id === limit.id), "limite presente nella lista");

    // Update parziale.
    const put = await fetch(limitsUrl(`/${limit.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ max_count: 800, notify_email: "ops@example.test", active: false }),
    });
    assert.equal(put.status, 200);
    const { limit: updated } = await put.json();
    assert.equal(updated.id, limit.id, "stessa riga");
    assert.equal(updated.max_count, 800);
    assert.equal(updated.notify_email, "ops@example.test");
    assert.equal(updated.active, false);
    assert.equal(updated.channel, "email", "channel invariato se non passato");

    // Delete → 200; seconda delete → 404.
    const del = await fetch(limitsUrl(`/${limit.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, limit.id);

    const again = await fetch(limitsUrl(`/${limit.id}`), { method: "DELETE", headers: auth() });
    assert.equal(again.status, 404);

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM channel_limits WHERE id = $1 AND site_id = $2",
      [limit.id, site.id]
    )).rows[0];
    assert.equal(rows.c, 0, "riga eliminata dal DB");
  });

  test("(b) check senza limite attivo → allowed true, limit null", async () => {
    const res = await check({ channel: "whatsapp", period: "hour" });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.allowed, true);
    assert.equal(result.limit, null);
    assert.equal(result.usage, 0);
    assert.equal(result.remaining, null);
  });

  test("(c) limite max 2/hour: check, consume ×2 allowed, terzo consume exceeded", async () => {
    const created = await postLimits({ channel: "whatsapp", period: "hour", max_count: 2 });
    assert.equal(created.status, 200);
    const { limit } = await created.json();
    assert.equal(limit.max_count, 2);

    // check: dentro il limite.
    const checkRes = await check({ channel: "whatsapp", period: "hour" });
    assert.equal(checkRes.status, 200);
    let result = await checkRes.json();
    assert.deepEqual(
      { allowed: result.allowed, usage: result.usage, limit: result.limit, remaining: result.remaining },
      { allowed: true, usage: 0, limit: 2, remaining: 2 }
    );
    assert.ok(result.period_start, "period_start valorizzato");

    // consume ×1 e ×2 → allowed (count=2 <= max=2).
    const c1 = await consume({ channel: "whatsapp", period: "hour" });
    assert.equal(c1.status, 200);
    assert.deepEqual((await c1.json()).usage, 1);

    const c2 = await consume({ channel: "whatsapp", period: "hour" });
    assert.equal(c2.status, 200);
    result = await c2.json();
    assert.equal(result.usage, 2);
    assert.equal(result.allowed, true, "count=2 <= max=2 → allowed");
    assert.equal(result.exceeded, false);

    // consume ×3 → superato.
    const c3 = await consume({ channel: "whatsapp", period: "hour" });
    assert.equal(c3.status, 200);
    result = await c3.json();
    assert.equal(result.usage, 3);
    assert.equal(result.allowed, false);
    assert.equal(result.exceeded, true);
  });

  test("(d) consume su canale senza limite → allowed true, usage 0, NESSUNA riga usage creata", async () => {
    // 'call' non ha limiti configurati in questa suite.
    const res = await consume({ channel: "call", period: "hour" });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.deepEqual(result, { allowed: true, usage: 0, limit: null, exceeded: false });

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM channel_usage WHERE site_id = $1 AND channel = 'call' AND period = 'hour'",
      [site.id]
    )).rows[0];
    assert.equal(rows.c, 0, "nessuna riga usage creata senza limite attivo (scelta di design)");
  });

  test("(e) getUsage: storico periodi recenti con count e notified", async () => {
    const created = await postLimits({ channel: "chat", period: "hour", max_count: 100 });
    assert.equal(created.status, 200);

    for (let i = 0; i < 5; i++) {
      const res = await consume({ channel: "chat", period: "hour" });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).allowed, true);
    }

    const res = await fetch(usageUrl("?channel=chat&period=hour"), { headers: auth() });
    assert.equal(res.status, 200);
    const { usage } = await res.json();
    assert.ok(Array.isArray(usage) && usage.length >= 1, "almeno un periodo nello storico");
    assert.equal(usage[0].count, 5, "primo periodo = riga corrente con count 5");
    assert.equal(usage[0].notified, false);
    assert.ok(usage[0].period_start, "period_start presente");
  });

  test("(f) resetUsage: azzera il contatore del periodo corrente", async () => {
    // Il canale 'chat' (test e) ha count 5 nel periodo corrente.
    const resetRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/channel-usage/reset`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "chat", period: "hour" }),
    });
    assert.equal(resetRes.status, 200);
    const reset = await resetRes.json();
    assert.ok(reset.reset >= 1, "righe eliminate");
    assert.ok(reset.period_start, "period_start presente");

    const checkRes = await check({ channel: "chat", period: "hour" });
    assert.equal(checkRes.status, 200);
    const result = await checkRes.json();
    assert.equal(result.usage, 0, "contatore azzerato");
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 100);
  });

  test("(g) notify_email: SMTP assente → consume oltre il limite non crasha e notified diventa true", async () => {
    const created = await postLimits({
      channel: "sms", period: "hour", max_count: 2,
      notify_email: "alert@example.test",
    });
    assert.equal(created.status, 200);

    // Due consumi dentro il limite: nessun tentativo di avviso.
    await consume({ channel: "sms", period: "hour" });
    await consume({ channel: "sms", period: "hour" });

    // Terzo consumo → superato. SMTP punta a 127.0.0.1:465 (nessun
    // listener): sendEmail fallisce con ECONNREFUSED ma l'errore è
    // catturato → risposta 200, exceeded true.
    const c3 = await consume({ channel: "sms", period: "hour" });
    assert.equal(c3.status, 200);
    const result = await c3.json();
    assert.equal(result.usage, 3);
    assert.equal(result.allowed, false);
    assert.equal(result.exceeded, true);

    // notified deve essere true sulla riga usage del periodo corrente.
    const rows = (await query(
      `SELECT notified FROM channel_usage
       WHERE site_id = $1 AND channel = 'sms' AND period = 'hour'
       ORDER BY period_start DESC LIMIT 1`,
      [site.id]
    )).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].notified, true, "flag notified alzato dopo il tentativo di avviso");

    // Audit log: l'evento di superamento è stato registrato.
    const audit = (await query(
      "SELECT COUNT(*)::int AS c FROM audit_log WHERE site_id = $1 AND entity_type = 'channel_limit' AND action = 'limit_exceeded'",
      [site.id]
    )).rows[0];
    assert.equal(audit.c, 1, "auditLog 'limit_exceeded' registrato");

    // Un ulteriore consume oltre il limite non deve crashare (200) e non
    // deve rispedire l'avviso (notified resta true).
    const c4 = await consume({ channel: "sms", period: "hour" });
    assert.equal(c4.status, 200);
    assert.equal((await c4.json()).usage, 4);
    const rows2 = (await query(
      "SELECT notified FROM channel_usage WHERE site_id = $1 AND channel = 'sms' AND period = 'hour' AND count = 4",
      [site.id]
    )).rows;
    assert.equal(rows2[0].notified, true, "nessun secondo avviso nello stesso periodo");
  });

  test("(h) canale non valido → 400 (check, consume, create, usage)", async () => {
    const badCheck = await check({ channel: "fax", period: "hour" });
    assert.equal(badCheck.status, 400);

    const badConsume = await consume({ channel: "fax", period: "hour" });
    assert.equal(badConsume.status, 400);

    const badCreate = await postLimits({ channel: "fax", period: "hour", max_count: 10 });
    assert.equal(badCreate.status, 400);

    const badUsage = await fetch(usageUrl("?channel=fax"), { headers: auth() });
    assert.equal(badUsage.status, 400);

    // Anche un periodo non valido → 400.
    const badPeriod = await check({ channel: "email", period: "week" });
    assert.equal(badPeriod.status, 400);
  });

  test("accesso negato su sito di un altro utente → 403", async () => {
    const otherSite = await createTestSite("Other Site");
    const res = await fetch(`${baseUrl}/api/agent/sites/${otherSite.id}/channel-limits`, { headers: auth() });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Accesso negato");
  });
});
