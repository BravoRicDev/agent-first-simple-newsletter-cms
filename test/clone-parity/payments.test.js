import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Round 20: Payment links — clone API GET /payments + /payments/:id.
// payment_links è l'unica delle quattro risorse "mirror" di fine piano ad
// avere SIA external_id proprio (uuid DEFAULT gen_random_uuid()) SIA ghl_id
// proprio, oltre a site_id (verificato su information_schema) → qui vale il
// pattern "doppio id" classico (findByAnyId/publicId), non il mirror
// pattern dei round 16-19.
// NOTA: sul nostro account GHL il sorgente GET /payments/ è bloccato da IAM
// (401, documentato 2026-09-08) → la tabella è vuota in produzione; il test
// semina dati rappresentativi e valida la superficie del clone.
describe("Clone API — Payment links (round 20, doppio id)", () => {
  let server;
  let site;
  let otherSite;
  let apiKey;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = res.ok ? await res.json() : null;
    return { status: res.status, data };
  };

  let p1Uuid, p2Uuid;
  const p1GhlId = "payGhl" + crypto.randomBytes(7).toString("hex"); // stile id reale sorgente

  before(async () => {
    site = await createTestSite("Payments Clone");
    otherSite = await createTestSite("Payments Other");
    apiKey = await mkKey(site.id, "test key");

    // p1: sincronizzato da GHL (ghl_id reale) — external_id dal default
    const r1 = await query(
      `INSERT INTO payment_links (site_id, ghl_id, title, amount, currency, contact_email, status, stripe_url)
       VALUES ($1, $2, 'Link corso base', 97, 'EUR', 'allievo@test.local', 'active', 'https://pay.example/link1')
       RETURNING external_id::text AS ext`,
      [site.id, p1GhlId]
    );
    p1Uuid = r1.rows[0].ext;

    // p2: creato localmente (solo UUID, ghl_id vuoto)
    const r2 = await query(
      `INSERT INTO payment_links (site_id, title, amount, currency, status, description)
       VALUES ($1, 'Link locale', 19, 'EUR', 'draft', 'senza sync')
       RETURNING external_id::text AS ext`,
      [site.id]
    );
    p2Uuid = r2.rows[0].ext;

    // p3: payment link di ALTRO sito (scope)
    await query(
      "INSERT INTO payment_links (site_id, ghl_id, title, amount) VALUES ($1, $2, 'Altrui', 5)",
      [otherSite.id, "payAltroSito0000000001"]
    );

    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  test("GET /payments → lista: riga sincronizzata espone ghl_id reale, riga locale espone UUID", async () => {
    const res = await fetch("/payments");
    assert.equal(res.status, 200);
    assert(Array.isArray(res.data.payments));
    assert.equal(res.data.payments.length, 2, "solo il proprio sito");
    assert.equal(res.data.meta.total, 2);

    const s1 = res.data.payments.find((p) => p.id === p1GhlId);
    assert.ok(s1, "riga sincronizzata: id = ghl_id REALE (publicId preferisce ghl_id)");
    assert.equal(s1.title, "Link corso base");
    assert.equal(s1.amount, 97);
    assert.equal(s1.currency, "EUR");
    assert.equal(s1.contactEmail, "allievo@test.local");
    assert.equal(s1.status, "active");
    assert.equal(s1.url, "https://pay.example/link1");

    const s2 = res.data.payments.find((p) => p.id === p2Uuid);
    assert.ok(s2, "riga locale senza ghl_id: id = UUID interno (fallback)");
    assert.equal(s2.description, "senza sync");
  });

  test("GET /payments/:id → risolve SIA ghl_id reale SIA UUID interno (stesso record)", async () => {
    const byGhl = await fetch(`/payments/${p1GhlId}`);
    assert.equal(byGhl.status, 200);
    assert.equal(byGhl.data.payment.id, p1GhlId);

    const byUuid = await fetch(`/payments/${p1Uuid}`);
    assert.equal(byUuid.status, 200);
    assert.equal(byUuid.data.payment.id, p1GhlId, "UUID risolve, ma id esposto resta il ghl_id");
    assert.equal(byUuid.data.payment.title, "Link corso base");
  });

  test("GET /payments con cursore: nextPage = publicId, accetta ghl_id e UUID come startAfterId", async () => {
    const p = await fetch("/payments?limit=1");
    assert.equal(p.status, 200);
    assert.equal(p.data.payments.length, 1);
    assert.equal(p.data.meta.nextPage, p1GhlId, "nextPage = id esposto dell'ultima riga");

    const nextByGhl = await fetch(`/payments?limit=5&startAfterId=${p1GhlId}`);
    assert.equal(nextByGhl.status, 200);
    assert.deepEqual(nextByGhl.data.payments.map((x) => x.id), [p2Uuid]);

    // stesso cursore dato come UUID interno → identico risultato
    const nextByUuid = await fetch(`/payments?limit=5&startAfterId=${p1Uuid}`);
    assert.deepEqual(nextByUuid.data.payments.map((x) => x.id), [p2Uuid]);
  });

  test("Errori: inesistente → 404, 300 char → 400, payment di altro sito non visibile", async () => {
    const missing = await fetch("/payments/ghlPAYMENTinesistente");
    assert.equal(missing.status, 404);

    const bad = await fetch(`/payments/${"x".repeat(300)}`);
    assert.equal(bad.status, 400);

    const cross = await fetch("/payments/payAltroSito0000000001");
    assert.equal(cross.status, 404, "scope per sito");
  });

  test("Sola lettura: POST/PUT/DELETE /payments → 404 (link reale emesso solo dal processor sorgente)", async () => {
    const post = await fetch("/payments", { method: "POST", body: JSON.stringify({ title: "x" }) });
    assert.equal(post.status, 404);
    const put = await fetch(`/payments/${p1GhlId}`, { method: "PUT", body: JSON.stringify({ title: "x" }) });
    assert.equal(put.status, 404);
    const del = await fetch(`/payments/${p1GhlId}`, { method: "DELETE" });
    assert.equal(del.status, 404);
  });
});
