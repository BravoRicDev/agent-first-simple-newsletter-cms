import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb, uniqueEmail } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerTrackedLinksRoutes } from "../src/routes/agent-tracked-links.js";
import { publicTrackedLinksRouter } from "../src/routes/public-tracked-links.js";

// Feature 39 — Link tracciati (QR / link corto) per sito, analogo ai magic
// conteggio visite (totali/unici/giorno), collegamento al
// funnel via channel/utm e identificazione opzionale del visitatore.
describe("feature 39: link tracciati (QR / link corto)", () => {
  let site, user, token, server, baseUrl;
  let goServer, goBaseUrl;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const json = (extra = {}) => ({ ...auth(), "Content-Type": "application/json", ...extra });
  const linksUrl = (extra = "") =>
    `${baseUrl}/api/agent/sites/${site.id}/tracked-links${extra}`;

  before(async () => {
    site = await createTestSite("Tracked Links Test");
    user = await createTestUser(site.id, "admin");
    token = (await createApiToken(user.id, "tracked links test", 30)).token;

    // ── Router agent (auth) ─────────────────────────────────────────────
    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerTrackedLinksRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });

    // ── Router pubblico /go (resolveSite via hostname) ──────────────────
    // resolveSite risolve il sito tramite JOIN su site_domains, quindi
    // inseriamo il dominio del sito di test come hostname noto.
    await query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [site.id, site.domain]);

    const app2 = express();
    app2.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app2.use((req, res, next) => { req.headers.host = site.domain; next(); });
    app2.use(publicTrackedLinksRouter);
    app2.use((err, req, res, next) => {
      res.status(500).end();
    });
    await new Promise((resolve) => {
      goServer = app2.listen(0, () => { goBaseUrl = `http://localhost:${goServer.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.(); server?.close();
    goServer?.closeAllConnections?.(); goServer?.close();
    await closeDb();
  });

  // ── (a) CRUD agent ────────────────────────────────────────────────────

  test("CRUD link tracciato (create/list/get/update/delete)", async () => {
    // create
    const created = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "Offerta estate", slug: "offerte-estate", target_url: "https://example.test/promo", channel: "offerte", utm_campaign: "estate-2026" }),
    });
    assert.equal(created.status, 200);
    const link = (await created.json()).tracked_link;
    assert.ok(link.id);
    assert.equal(link.slug, "offerte-estate");
    assert.equal(link.target_url, "https://example.test/promo");
    assert.equal(link.channel, "offerte");
    assert.equal(link.status, "active");

    // get
    const got = await fetch(linksUrl(`/${link.id}`), { headers: auth() });
    assert.equal(got.status, 200);
    const gotLink = (await got.json()).tracked_link;
    assert.equal(gotLink.slug, "offerte-estate");
    assert.equal(gotLink.visit_count, 0);

    // update
    const upd = await fetch(linksUrl(`/${link.id}`), {
      method: "PUT", headers: json(),
      body: JSON.stringify({ label: "Offerta estate 2", target_url: "https://example.test/promo2" }),
    });
    assert.equal(upd.status, 200);
    const updated = (await upd.json()).tracked_link;
    assert.equal(updated.label, "Offerta estate 2");
    assert.equal(updated.target_url, "https://example.test/promo2");

    // delete
    const del = await fetch(linksUrl(`/${link.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, true);
    const gone = await fetch(linksUrl(`/${link.id}`), { headers: auth() });
    assert.equal(gone.status, 404);
  });

  test("create rifiuta target_url non valido e label vuota", async () => {
    const badUrl = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "x", target_url: "javascript:alert(1)" }),
    });
    assert.equal(badUrl.status, 400);

    const noLabel = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "  ", target_url: "https://example.test/x" }),
    });
    assert.equal(noLabel.status, 400);
  });

  test("slug collisione generate un slug univoco (-2, -3...)", async () => {
    const a = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "A", slug: "stesso", target_url: "https://example.test/a" }),
    });
    const b = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "B", slug: "stesso", target_url: "https://example.test/b" }),
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const sa = (await a.json()).tracked_link.slug;
    const sb = (await b.json()).tracked_link.slug;
    assert.notEqual(sa, sb);
    assert.ok(sb.startsWith(sa));
  });

  // ── (b) Route pubblica /go ────────────────────────────────────────────

  test("/go/:slug fa 302 verso target e registra la visita", async () => {
    const created = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "Pubb", slug: "pubb-1", target_url: "https://example.test/dest" }),
    });
    const link = (await created.json()).tracked_link;

    const res = await fetch(`${goBaseUrl}/go/${link.slug}`, {
      headers: { Host: site.domain, "User-Agent": "test-bot/1.0" },
      redirect: "manual",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://example.test/dest");

    const events = await query("SELECT COUNT(*) AS c FROM tracked_link_events WHERE link_id = $1", [link.id]);
    assert.equal(parseInt(events.rows[0].c, 10), 1, "la visita va registrata");
  });

  test("/go/:slug inesistente → 404, nessun redirect", async () => {
    const res = await fetch(`${goBaseUrl}/go/non-esiste`, { headers: { Host: site.domain }, redirect: "manual" });
    assert.equal(res.status, 404);
  });

  test("/go/:slug con ?email registra il contatto nell'evento", async () => {
    const created = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "Email", slug: "con-email", target_url: "https://example.test/x", channel: "fb" }),
    });
    const link = (await created.json()).tracked_link;
    const email = uniqueEmail("visitor");

    await fetch(`${goBaseUrl}/go/${link.slug}?email=${encodeURIComponent(email)}`, {
      headers: { Host: site.domain }, redirect: "manual",
    });

    const events = await query("SELECT email FROM tracked_link_events WHERE link_id = $1", [link.id]);
    assert.equal(events.rows.length, 1);
    assert.equal(events.rows[0].email, email);
  });

  test("stats: totali, unici e per giorno", async () => {
    const created = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "Stats", slug: "stats-1", target_url: "https://example.test/s" }),
    });
    const link = (await created.json()).tracked_link;

    // 2 visite senza email (stesso IP → 1 unico), 1 visita con email diversa
    await fetch(`${goBaseUrl}/go/${link.slug}`, { headers: { Host: site.domain, "X-Forwarded-For": "1.2.3.4" }, redirect: "manual" });
    await fetch(`${goBaseUrl}/go/${link.slug}`, { headers: { Host: site.domain, "X-Forwarded-For": "1.2.3.4" }, redirect: "manual" });
    await fetch(`${goBaseUrl}/go/${link.slug}?email=${encodeURIComponent(uniqueEmail("s"))}`, { headers: { Host: site.domain }, redirect: "manual" });

    const res = await fetch(linksUrl(`/${link.id}/stats`), { headers: auth() });
    assert.equal(res.status, 200);
    const { stats } = await res.json();
    assert.equal(stats.total, 3);
    assert.equal(stats.unique, 2); // 1 IP + 1 email
    assert.ok(stats.daily.length >= 1);
    assert.equal(parseInt(stats.daily[0].hits, 10) >= 3, true);
  });

  // ── (c) QR code ───────────────────────────────────────────────────────

  test("/go/:slug.qr genera un PNG", async () => {
    const created = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "QR", slug: "qr-1", target_url: "https://example.test/q" }),
    });
    const link = (await created.json()).tracked_link;

    const res = await fetch(`${goBaseUrl}/go/${link.slug}.qr`, { headers: { Host: site.domain } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /image\/png/);
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG magic header
    assert.equal(buf[0], 0x89); assert.equal(buf[1], 0x50); assert.equal(buf[2], 0x4e); assert.equal(buf[3], 0x47);
  });

  test("/go/:slug.qr di link con qr_enabled=false → 404", async () => {
    const created = await fetch(linksUrl(), {
      method: "POST", headers: json(),
      body: JSON.stringify({ label: "NoQR", slug: "no-qr", target_url: "https://example.test/q", qr_enabled: false }),
    });
    const link = (await created.json()).tracked_link;
    const res = await fetch(`${goBaseUrl}/go/${link.slug}.qr`, { headers: { Host: site.domain } });
    assert.equal(res.status, 404);
  });
});
