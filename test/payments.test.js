import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerPaymentsRoutes } from "../src/routes/agent-payments.js";
import { publicPaymentsRouter } from "../src/routes/public-payments.js";

// Feature 38 — Link di pagamento Stripe: CRUD agent, token pubblico,
// pagina /pay/:token (Stripe o conferma simulata), mark-paid. Come
// prescritto NON si importa agentRouter: il modulo agent è montato su un
// router locale con requireAuth + requireAgent, quello pubblico su
// app.use() senza auth. In before si forza config.stripeSecretKey = "" per
// eseguire in modalità "senza Stripe" (stripe_url vuoto, conferma
// simulata) indipendentemente dall'ambiente.
describe("feature 38: link di pagamento stripe", () => {
  let site, user, token, server, baseUrl;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const linksUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/payment-links${extra}`;
  const payUrl = (tok, extra = "") => `${baseUrl}/pay/${tok}${extra}`;

  before(async () => {
    // Forza modalità senza Stripe: il link pubblico resta in "conferma simulata".
    config.stripeSecretKey = "";

    site = await createTestSite("CRM Payment Test");
    const createdUser = await createTestUser(site.id, "admin");
    const created = await createApiToken(createdUser.id, "payments test", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerPaymentsRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use(publicPaymentsRouter); // modulo pubblico SENZA auth
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });

    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server?.closeAllConnections?.();
    server?.close();
    await closeDb();
  });

  // ── (b)+(h) create: token generato, draft, stripe_url vuoto, amount Number ──

  test("GET payment-links?contact_email= filtra per contatto (anche combinato con status)", async () => {
    const email = "filter@example.test";
    const createRes = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Filtro contatto", amount: 10, contact_email: email }),
    });
    assert.equal(createRes.status, 200);
    const { payment_link } = await createRes.json();

    // solo filtro email
    const filtered = await fetch(linksUrl(`?contact_email=${encodeURIComponent(email)}`), { headers: auth() });
    assert.equal(filtered.status, 200);
    const { payment_links } = await filtered.json();
    assert.ok(payment_links.some((p) => p.id === payment_link.id), "il link del contatto c'è");
    assert.ok(payment_links.every((p) => p.contact_email === email), "tutti i link appartengono al contatto");

    // combinabile col filtro status
    const combined = await fetch(linksUrl(`?contact_email=${encodeURIComponent(email)}&status=draft`), { headers: auth() });
    assert.equal(combined.status, 200);
    const { payment_links: combinedLinks } = await combined.json();
    assert.ok(combinedLinks.some((p) => p.id === payment_link.id), "filtro email+status insieme");

    // email diversa → escluso
    const other = await fetch(linksUrl(`?contact_email=${encodeURIComponent("altra@example.test")}`), { headers: auth() });
    const { payment_links: otherLinks } = await other.json();
    assert.ok(!otherLinks.some((p) => p.id === payment_link.id), "link di altro contatto escluso");
  });

  test("create payment link: token generato, status draft, stripe_url vuoto, amount normalizzato", async () => {
    const res = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Consulenza strategica",
        amount: "100.50",
        contact_email: "cliente@example.test",
        description: "Sessione di 60 minuti",
        currency: "EUR",
      }),
    });
    assert.equal(res.status, 200);
    const { payment_link } = await res.json();
    assert.ok(payment_link.id);
    assert.ok(payment_link.token && payment_link.token.length === 48, "token 24 byte hex (48 char)");
    assert.equal(payment_link.status, "draft");
    assert.equal(payment_link.stripe_url, "");
    assert.equal(payment_link.amount, 100.5);
    assert.equal(payment_link.currency, "EUR");
    assert.equal(payment_link.contact_email, "cliente@example.test");
  });

  // ── (a) CRUD completo via route agent ───────────────────────────────────

  test("CRUD payment link via route agent", async () => {
    // create
    const createRes = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pacchetto base", amount: 250, description: "Setup + formazione" }),
    });
    assert.equal(createRes.status, 200);
    const { payment_link } = await createRes.json();
    assert.equal(typeof payment_link.amount, "number");

    // list (con filtro status)
    const listRes = await fetch(linksUrl("?status=draft"), { headers: auth() });
    assert.equal(listRes.status, 200);
    const { payment_links } = await listRes.json();
    assert.ok(payment_links.some((p) => p.id === payment_link.id));
    assert.ok(payment_links.every((p) => typeof p.amount === "number"));

    // get singolo
    const getRes = await fetch(linksUrl(`/${payment_link.id}`), { headers: auth() });
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).payment_link.id, payment_link.id);

    // update (title + status)
    const updRes = await fetch(linksUrl(`/${payment_link.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Pacchetto base v2", amount: "300", status: "active" }),
    });
    assert.equal(updRes.status, 200);
    const updated = (await updRes.json()).payment_link;
    assert.equal(updated.title, "Pacchetto base v2");
    assert.equal(updated.amount, 300);
    assert.equal(updated.status, "active");

    // delete
    const delRes = await fetch(linksUrl(`/${payment_link.id}`), { method: "DELETE", headers: auth() });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);
    const afterDelete = await fetch(linksUrl(`/${payment_link.id}`), { headers: auth() });
    assert.equal(afterDelete.status, 404);

    // validazione: titolo vuoto → 400
    const badRes = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   ", amount: 10 }),
    });
    assert.equal(badRes.status, 400);
  });

  // ── (c) GET /pay/:token → 200 e contiene l'importo ─────────────────────

  test("GET /pay/:token mostra importo e form di conferma (modalità simulata)", async () => {
    const createRes = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Corso online", amount: 49.9, description: "Accesso 12 mesi" }),
    });
    const { payment_link } = await createRes.json();

    const res = await fetch(payUrl(payment_link.token));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.match(html, /Corso online/);
    assert.match(html, /49,9|49.9/);
    assert.match(html, /Conferma pagamento/); // modalità simulata, niente Stripe
    assert.doesNotMatch(html, /Paga con Stripe/);
  });

  // ── (d)+(e) POST /pay/:token/confirm → paid + redirect → pagina completato ──

  test("POST /pay/:token/confirm marca paid e la pagina mostra completato", async () => {
    const createRes = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Deposito", amount: 100, contact_email: "pay@example.test" }),
    });
    const { payment_link } = await createRes.json();
    assert.equal(payment_link.status, "draft");

    // redirect (default fetch segue → pagina finale)
    const res = await fetch(payUrl(payment_link.token, "/confirm"), { method: "POST", redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location") || "", new RegExp(`/pay/${payment_link.token}$`));

    // stato nel DB: paid + paid_at valorizzato
    const row = (await query("SELECT status, paid_at FROM payment_links WHERE id = $1", [payment_link.id])).rows[0];
    assert.equal(row.status, "paid");
    assert.ok(row.paid_at, "paid_at valorizzato");

    // pagina pubblica → completato
    const page = await fetch(payUrl(payment_link.token));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /completato/i);
    assert.doesNotMatch(html, /Conferma pagamento/);

    // evento payment_paid registrato per il contatto
    const evt = (await query(
      "SELECT event_type FROM contact_events WHERE site_id = $1 AND email = $2 AND event_type = 'payment_paid'",
      [site.id, "pay@example.test"]
    )).rows;
    assert.ok(evt.length > 0, "evento payment_paid emesso");
  });

  // ── (f) mark-paid via route agent ──────────────────────────────────────

  test("mark-paid via route agent: status paid e paid_at", async () => {
    const createRes = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Rinnovo", amount: 19 }),
    });
    const { payment_link } = await createRes.json();

    const res = await fetch(linksUrl(`/${payment_link.id}/mark-paid`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ by: "admin@example.test" }),
    });
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.equal(result.already, false);
    assert.equal(result.link.status, "paid");
    assert.ok(result.link.paid_at);

    // idempotente: seconda chiamata → already:true
    const again = await fetch(linksUrl(`/${payment_link.id}/mark-paid`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal((await again.json()).already, true);

    // 404 su link inesistente
    const missing = await fetch(linksUrl("/999999/mark-paid"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 404);
  });

  // ── (g) token inesistente → 404 ────────────────────────────────────────

  test("GET /pay/:token con token sconosciuto → 404", async () => {
    const res = await fetch(payUrl("token-inesistente"));
    assert.equal(res.status, 404);
    const confirm = await fetch(payUrl("token-inesistente", "/confirm"), { method: "POST" });
    assert.equal(confirm.status, 404);
  });

  // ── (h) amount stringa '100.50' → Number 100.5 nel JSON (già in (b), qui esplicito) ──

  test("amount stringa '100.50' → Number 100.5 nel JSON dell'API", async () => {
    const res = await fetch(linksUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "String amount", amount: "100.50" }),
    });
    const { payment_link } = await res.json();
    assert.equal(typeof payment_link.amount, "number");
    assert.equal(payment_link.amount, 100.5);
    assert.notEqual(payment_link.amount, "100.50");
  });
});
