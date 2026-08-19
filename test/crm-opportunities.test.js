import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";
import quotesRoutes from "../src/routes/quotes.js";

// Opportunities (deals with stages, amounts, probability) + PDF quotes
// with status tracking (sent/viewed/signed).
describe("crm: opportunità + preventivi PDF", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Opportunities Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm opp", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use(quotesRoutes);
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
  const email = "affare@example.test";

  async function waitForEvent(eventType, predicate = () => true, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = (await query(
        "SELECT event_type, payload FROM contact_events WHERE site_id = $1 AND email = $2 AND event_type = $3 ORDER BY id DESC LIMIT 5",
        [site.id, email, eventType]
      )).rows;
      if (rows.some(predicate)) return rows[0];
      await new Promise(r => setTimeout(r, 25));
    }
    return null;
  }

  test("opportunità: crea + lista con filtri", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ email, title: "Sito vetrina", stage: "proposta_inviata", amount: 1500, probability: 70, notes: "contattato via quiz" }),
    });
    assert.equal(res.status, 200);
    const { opportunity } = await res.json();
    assert.ok(opportunity.id);
    assert.equal(opportunity.amount, 1500);
    assert.equal(opportunity.probability, 70);
    assert.equal(opportunity.status, "open");

    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities?status=open`, { headers: auth() });
    const { opportunities } = await list.json();
    assert.ok(opportunities.some(o => o.id === opportunity.id));

    const ev = await waitForEvent("opportunity_stage_changed", e => e.payload?.to_stage === "proposta_inviata");
    assert.ok(ev, "evento opportunity_stage_changed alla creazione");
  });

  test("opportunità: probabilità fuori range → clamp 0-100", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "clamp@example.test", title: "Clamp", probability: 150 }),
    });
    const { opportunity } = await res.json();
    assert.equal(opportunity.probability, 100);
  });

  test("opportunità: update stadio/status genera eventi", async () => {
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities?email=${email}`, { headers: auth() });
    const { opportunities } = await list.json();
    const opp = opportunities[0];

    const upRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities/${opp.id}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "vinto", status: "won" }),
    });
    assert.equal(upRes.status, 200);
    const { opportunity } = await upRes.json();
    assert.equal(opportunity.stage, "vinto");
    assert.equal(opportunity.status, "won");

    assert.ok(await waitForEvent("opportunity_stage_changed", e => e.payload?.to_stage === "vinto"), "evento stage");
    assert.ok(await waitForEvent("opportunity_status_changed", e => e.payload?.to_status === "won"), "evento status");
  });

  test("preventivo: crea con token, numero progressivo e totale", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quotes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        title: "Preventivo sito vetrina",
        items: [
          { description: "Sito 5 pagine", qty: 1, price: 1500 },
          { description: "SEO base", qty: 1, price: 300 },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const { quote } = await res.json();
    assert.ok(quote.token, "token generato");
    assert.match(quote.quote_number, /^Q-\d{6}$/);
    assert.equal(quote.total, 1800, "totale calcolato");
    assert.equal(quote.status, "draft");

    const detail = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quotes/${quote.id}`, { headers: auth() });
    const { public_url } = await detail.json();
    assert.equal(public_url, `/quote/${quote.token}`);
    return quote;
  });

  test("preventivo: cambio stato sent → evento quote_sent", async () => {
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quotes?email=${email}`, { headers: auth() });
    const { quotes } = await list.json();
    const q = quotes[0];

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quotes/${q.id}/status`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "sent" }),
    });
    assert.equal(res.status, 200);
    const { quote } = await res.json();
    assert.equal(quote.status, "sent");
    assert.ok(quote.sent_at, "sent_at valorizzato");

    const ev = await waitForEvent("quote_sent", e => e.payload?.quote_id === q.id);
    assert.ok(ev, "evento quote_sent");
  });

  test("pagina pubblica: apre → viewed, PDF generato, firma → signed", async () => {
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quotes?email=${email}`, { headers: auth() });
    const { quotes } = await list.json();
    const q = quotes[0];

    // Pagina pubblica → viewed
    const pageRes = await fetch(`${baseUrl}/quote/${q.token}`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.match(html, /Preventivo/);
    assert.match(html, /1\.?800/, "totale in EUR (il container senza full-ICU omette il separatore migliaia)");
    const dbQuote = (await query("SELECT status, viewed_at FROM quotes WHERE id = $1", [q.id])).rows[0];
    assert.equal(dbQuote.status, "viewed", "primo accesso → viewed");
    assert.ok(dbQuote.viewed_at);
    assert.ok(await waitForEvent("quote_viewed", e => e.payload?.quote_id === q.id), "evento quote_viewed");

    // PDF
    const pdfRes = await fetch(`${baseUrl}/quote/${q.token}/pdf`);
    assert.equal(pdfRes.status, 200);
    assert.match(pdfRes.headers.get("content-type"), /application\/pdf/);
    const pdf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-", "header PDF valido");
    assert.ok(pdf.length > 500, "PDF non vuoto");

    // Firma
    const signRes = await fetch(`${baseUrl}/quote/${q.token}/sign`, { method: "POST" });
    assert.equal(signRes.status, 200);
    const signed = (await query("SELECT status, signed_at FROM quotes WHERE id = $1", [q.id])).rows[0];
    assert.equal(signed.status, "signed");
    assert.ok(signed.signed_at);
    assert.ok(await waitForEvent("quote_signed", e => e.payload?.quote_id === q.id), "evento quote_signed");

    // Seconda firma: nessun nuovo evento (idempotente)
    await fetch(`${baseUrl}/quote/${q.token}/sign`, { method: "POST" });
    const events = (await query(
      "SELECT COUNT(*)::int AS c FROM contact_events WHERE site_id = $1 AND email = $2 AND event_type = 'quote_signed'",
      [site.id, email]
    )).rows[0].c;
    assert.equal(events, 1, "nessun secondo evento quote_signed");
  });

  test("token non valido → 404", async () => {
    const res = await fetch(`${baseUrl}/quote/nonexistent`);
    assert.equal(res.status, 404);
  });

  test("escape XSS nella pagina pubblica: title/numero maliziosi non eseguiti", async () => {
    const evil = "<script>alert(1)</script>";
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quotes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "xss@example.test",
        title: evil,
        items: [{ description: evil, qty: 1, price: 10 }],
      }),
    });
    const { quote } = await res.json();

    const page = await fetch(`${baseUrl}/quote/${quote.token}`);
    const html = await page.text();
    assert.ok(!html.includes(`<script>alert(1)</script>`), "nessun tag script grezzo nella pagina");
    assert.ok(html.includes("&lt;script&gt;"), "title escapato (entità &lt;script&gt;)");
    assert.ok(!html.includes("><script>"), "nessuna chiusura di tag da input malizioso");
  });

  test("GDPR: erase elimina opportunità e preventivi", async () => {
    const { eraseContactData } = await import("../src/services/privacy.js");
    const result = await eraseContactData(site.id, email);
    assert.ok(result.opportunities >= 1);
    assert.ok(result.quotes >= 1);
    const opps = (await query("SELECT COUNT(*)::int AS c FROM opportunities WHERE site_id = $1 AND contact_email = $2", [site.id, email])).rows[0].c;
    const qts = (await query("SELECT COUNT(*)::int AS c FROM quotes WHERE site_id = $1 AND contact_email = $2", [site.id, email])).rows[0].c;
    assert.equal(opps, 0);
    assert.equal(qts, 0);
  });

  test("opportunità: delete", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ email: "del-opp@example.test", title: "Da eliminare" }),
    });
    const { opportunity } = await res.json();
    const del = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities/${opportunity.id}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(del.status, 200);
    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/opportunities?email=del-opp@example.test`, { headers: auth() });
    assert.equal((await list.json()).opportunities.length, 0);
  });

  // ULTIMO: il rate limiter è per-IP e condiviso tra i test dello stesso
  // server → questo test va in fondo per non far scattare 429 sui precedenti.
  test("rate limit sulle route pubbliche /quote (martellamento → 429)", async () => {
    const statuses = [];
    for (let i = 0; i < 25; i++) {
      const r = await fetch(`${baseUrl}/quote/nonexistent-${i}`);
      statuses.push(r.status);
    }
    assert.ok(statuses.includes(429), `almeno una risposta 429 (visti: ${[...new Set(statuses)].join(",")})`);
  });
});
