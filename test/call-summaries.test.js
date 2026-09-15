import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerCallSummariesRoutes } from "../src/routes/agent-callsummaries.js";
import config from "../src/config.js";

// Feature 33 — Riepilogo IA delle chiamate.
// La chiamata → riassunto, azioni da intraprendere e prossimo passo, generati
// dall'IA (qui senza LLM_API_KEY: il servizio degrada al template, source
// 'template') e correggibili a mano dall'operatore. Niente import di
// agentRouter: il modulo route viene montato su un router locale con
// requireAuth + requireAgent, come prescritto per i moduli registrati dal
// router padre.
describe("crm: riepilogo IA delle chiamate", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    // Determininismo: l'env del container può avere LLM_API_KEY/OPENAI_API_KEY
    // di produzione → forziamo il percorso template nei test.
    config.llmApiKey = "";
    site = await createTestSite("CRM Call Summaries Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm call summaries", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerCallSummariesRoutes(r);

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
  const summariesUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/call-summaries${extra}`;

  // Crea una chiamata direttamente in calls (colonne reali da 029_calls.sql:
  // site_id, email, name, scheduled_at, duration_minutes, status, outcome_notes).
  async function createCall({ email, notes = "", status = "completata", name = "Mario Rossi" }) {
    const result = await query(
      `INSERT INTO calls (site_id, email, name, scheduled_at, duration_minutes, status, outcome_notes)
       VALUES ($1, $2, $3, NOW(), 30, $4, $5) RETURNING id`,
      [site.id, email, name, status, notes]
    );
    return result.rows[0].id;
  }

  test("generate su chiamata esistente → riepilogo da template con email/note", async () => {
    const callId = await createCall({ email: "gen.alpha@example.test", notes: "Interessato al pacchetto pro" });

    const res = await fetch(summariesUrl(`/${callId}/generate`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const { summary } = await res.json();
    assert.ok(summary.id, "riga creata con id");
    assert.equal(summary.call_id, callId);
    assert.equal(summary.source, "template", "senza LLM configurato source=template");
    assert.equal(summary.status, "pending");
    assert.ok(Array.isArray(summary.action_items), "action_items è un array");
    assert.ok(
      summary.summary.includes("gen.alpha@example.test") || summary.summary.includes("pacchetto pro"),
      `summary contiene l'email o le note: ${summary.summary}`
    );

    // Riga presente anche in DB con l'UNIQUE (site_id, call_id) rispettato.
    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM call_summaries WHERE site_id = $1 AND call_id = $2",
      [site.id, callId]
    )).rows[0];
    assert.equal(rows.c, 1);
  });

  test("generate ripetuto senza force → 409; con force → rigenera", async () => {
    const callId = await createCall({ email: "force.beta@example.test", notes: "Prima versione delle note" });
    const first = await fetch(summariesUrl(`/${callId}/generate`), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(first.status, 200);
    const firstId = (await first.json()).summary.id;

    // Senza force: 409 e nessuna modifica.
    const dup = await fetch(summariesUrl(`/${callId}/generate`), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error, "Riepilogo già esistente");

    // Con force: rigenera sullo stesso id (upsert, non doppione).
    await query("UPDATE calls SET outcome_notes = 'Note aggiornate dopo il follow-up' WHERE id = $1", [callId]);
    const forced = await fetch(summariesUrl(`/${callId}/generate`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(forced.status, 200);
    const { summary } = await forced.json();
    assert.equal(summary.id, firstId, "stessa riga, upsert");
    assert.ok(summary.summary.includes("Note aggiornate dopo il follow-up"), "summary rigenerato con le nuove note");

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM call_summaries WHERE site_id = $1 AND call_id = $2",
      [site.id, callId]
    )).rows[0];
    assert.equal(rows.c, 1, "nessun doppione grazie all'UNIQUE");
  });

  test("generate su chiamata inesistente → 404", async () => {
    const res = await fetch(summariesUrl("/999999/generate"), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "Chiamata non trovata");
  });

  test("list con filtro status", async () => {
    const callA = await createCall({ email: "list.a@example.test", notes: "Chiamata A" });
    const callB = await createCall({ email: "list.b@example.test", notes: "Chiamata B" });
    const gen = (id) => fetch(summariesUrl(`/${id}/generate`), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal((await gen(callA)).status, 200);
    assert.equal((await gen(callB)).status, 200);

    // Tutte e due presenti tra i pending (il sito può avere altri riepiloghi
    // pending generati dai test precedenti: conto per call_id, non totali).
    const allPending = await fetch(summariesUrl("?status=pending"), { headers: auth() });
    const pendingRows = (await allPending.json()).summaries;
    assert.ok(pendingRows.some(s => s.call_id === callA), "callA in pending");
    assert.ok(pendingRows.some(s => s.call_id === callB), "callB in pending");

    // Marco A come done → il filtro separa le due.
    const allRows = await (await fetch(summariesUrl(), { headers: auth() })).json();
    const aRow = allRows.summaries.find(s => s.call_id === callA);
    const mark = await fetch(summariesUrl(`/${aRow.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(mark.status, 200);

    const doneRows = (await (await fetch(summariesUrl("?status=done"), { headers: auth() })).json()).summaries;
    assert.ok(doneRows.some(s => s.call_id === callA), "callA in done");
    const stillPending = (await (await fetch(summariesUrl("?status=pending"), { headers: auth() })).json()).summaries;
    assert.ok(!stillPending.some(s => s.call_id === callA), "callA non più pending");
    assert.ok(stillPending.some(s => s.call_id === callB), "callB ancora pending");

    // Filtro per call_id.
    const byCall = await fetch(summariesUrl(`?call_id=${callB}`), { headers: auth() });
    const { summaries: byCallRows } = await byCall.json();
    assert.equal(byCallRows.length, 1);
    assert.equal(byCallRows[0].call_id, callB);
  });

  test("update manuale: summary editato, status done, source resta", async () => {
    const callId = await createCall({ email: "edit.gamma@example.test", notes: "Note originali" });
    const gen = await fetch(summariesUrl(`/${callId}/generate`), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    const { summary: generated } = await gen.json();
    assert.equal(generated.source, "template");

    const put = await fetch(summariesUrl(`/${generated.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Riepilogo corretto a mano dall'operatore",
        action_items: ["Inviare preventivo", "Richiamare giovedì"],
        next_step: "Chiamata di follow-up tra 7 giorni",
        status: "done",
      }),
    });
    assert.equal(put.status, 200);
    const { summary } = await put.json();
    assert.equal(summary.summary, "Riepilogo corretto a mano dall'operatore");
    assert.deepEqual(summary.action_items, ["Inviare preventivo", "Richiamare giovedì"]);
    assert.equal(summary.next_step, "Chiamata di follow-up tra 7 giorni");
    assert.equal(summary.status, "done");
    assert.equal(summary.source, "template", "la correzione umana non cambia la source");
    assert.equal(summary.id, generated.id);
  });

  test("update su riepilogo inesistente → 404", async () => {
    const res = await fetch(summariesUrl("/999999"), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ summary: "x" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "Riepilogo non trovato");
  });

  test("delete → rimuove la riga", async () => {
    const callId = await createCall({ email: "del.delta@example.test", notes: "Da eliminare" });
    const gen = await fetch(summariesUrl(`/${callId}/generate`), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    const { summary } = await gen.json();

    const del = await fetch(summariesUrl(`/${summary.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, summary.id);

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM call_summaries WHERE id = $1 AND site_id = $2",
      [summary.id, site.id]
    )).rows[0];
    assert.equal(rows.c, 0);

    // Seconda delete → 404.
    const again = await fetch(summariesUrl(`/${summary.id}`), { method: "DELETE", headers: auth() });
    assert.equal(again.status, 404);
  });

  test("accesso ad altro sito → 403", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/999999/call-summaries`, { headers: auth() });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Accesso negato");
  });
});
