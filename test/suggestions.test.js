import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerSuggestionsRoutes } from "../src/routes/agent-suggestions.js";
import config from "../src/config.js";
import { addConversationMessage } from "../src/services/conversations.js";
import { createArticle } from "../src/services/kb.js";

// Feature 34 — Proposta di risposta all'operatore.
// L'agente genera una bozza di risposta per una conversazione usando la
// knowledge base del sito; l'operatore la approva con un clic (use),
// la scarta (dismiss) o la elimina. Niente import di agentRouter: il
// modulo route viene montato su un router locale con requireAuth +
// requireAgent, come prescritto per i moduli registrati dal router padre.
// LLM assente nei test (nessuna chiave in .env) → source 'template'/'kb'.
describe("crm: proposta di risposta all'operatore (reply suggestions)", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    config.llmApiKey = "";
    site = await createTestSite("CRM Reply Suggestions Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "reply suggestions", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerSuggestionsRoutes(r);

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
  const suggestionsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/reply-suggestions${extra}`;

  // Crea una conversazione con un messaggio IN (il lead scrive) e ritorna
  // l'id del thread.
  async function conversationWithIncoming(email, body) {
    const message = await addConversationMessage(site.id, email, "email", {
      direction: "in",
      subject: "Richiesta info",
      body,
    });
    return message.conversation_id;
  }

  test("(a) generate su conversazione con messaggio IN → bozza template pending", async () => {
    const conversationId = await conversationWithIncoming(
      "sugg.a@example.test",
      "Ciao, ho una domanda sul vostro servizio"
    );

    const res = await fetch(suggestionsUrl("/generate"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    assert.equal(res.status, 200);
    const { suggestion } = await res.json();
    assert.ok(suggestion.id);
    assert.equal(suggestion.conversation_id, conversationId);
    assert.equal(suggestion.contact_email, "sugg.a@example.test");
    assert.ok(suggestion.suggested_text.trim().length > 0, "suggested_text non vuoto");
    assert.equal(suggestion.source, "template", "LLM assente nei test → template");
    assert.deepEqual(suggestion.kb_article_ids, []);
    assert.equal(suggestion.status, "pending");
  });

  test("(b) generate su conversazione inesistente → 404", async () => {
    const res = await fetch(suggestionsUrl("/generate"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: 999999999 }),
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "Conversazione non trovata");
  });

  test("(b2) generate senza conversation_id → 400", async () => {
    const res = await fetch(suggestionsUrl("/generate"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test("(c) articolo KB pertinente → kb_article_ids popolato e testo col titolo", async () => {
    const article = await createArticle(site.id, {
      title: "Listino base",
      content: "Preventivo e prezzi del listino base: consulenza e sviluppo siti.",
      category: "listini",
      tags: ["prezzi"],
    });

    const conversationId = await conversationWithIncoming(
      "sugg.c@example.test",
      "listino base preventivo"
    );

    const res = await fetch(suggestionsUrl("/generate"), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    assert.equal(res.status, 200);
    const { suggestion } = await res.json();
    assert.deepEqual(suggestion.kb_article_ids, [article.id], "kb_article_ids contiene l'articolo");
    assert.ok(suggestion.suggested_text.includes("Listino base"), "il testo cita il titolo dell'articolo");
    assert.equal(suggestion.source, "kb", "template costruito su articoli KB → source 'kb'");
  });

  test("(d) list con filtro status e conversation_id", async () => {
    const listPending = await fetch(suggestionsUrl("?status=pending"), { headers: auth() });
    assert.equal(listPending.status, 200);
    const { suggestions: pending } = await listPending.json();
    assert.equal(pending.length, 2, "le due bozze generate prima sono ancora pending");

    const listUsed = await fetch(suggestionsUrl("?status=used"), { headers: auth() });
    assert.equal((await listUsed.json()).suggestions.length, 0);

    // Filtro per conversazione: solo la bozza di quella conversazione.
    const convA = (await query(
      "SELECT id FROM conversations WHERE site_id = $1 AND contact_email = $2",
      [site.id, "sugg.a@example.test"]
    )).rows[0];
    const listConv = await fetch(suggestionsUrl(`?conversation_id=${convA.id}`), { headers: auth() });
    const { suggestions: byConv } = await listConv.json();
    assert.equal(byConv.length, 1);
    assert.equal(byConv[0].contact_email, "sugg.a@example.test");
  });

  test("(e) use → status used; secondo use → 409", async () => {
    const rows = (await query(
      "SELECT id FROM reply_suggestions WHERE site_id = $1 AND contact_email = $2",
      [site.id, "sugg.a@example.test"]
    )).rows;
    assert.equal(rows.length, 1);
    const id = rows[0].id;

    const useRes = await fetch(suggestionsUrl(`/${id}/use`), {
      method: "POST",
      headers: auth(),
    });
    assert.equal(useRes.status, 200);
    assert.equal((await useRes.json()).suggestion.status, "used");

    // Doppio use: la UPDATE condizionale su status='pending' non tocca
    // nulla → 409 (niente doppia approvazione).
    const second = await fetch(suggestionsUrl(`/${id}/use`), {
      method: "POST",
      headers: auth(),
    });
    assert.equal(second.status, 409);

    const after = (await query(
      "SELECT status FROM reply_suggestions WHERE id = $1",
      [id]
    )).rows[0];
    assert.equal(after.status, "used");
  });

  test("(f) dismiss → status dismissed", async () => {
    const rows = (await query(
      "SELECT id FROM reply_suggestions WHERE site_id = $1 AND contact_email = $2",
      [site.id, "sugg.c@example.test"]
    )).rows;
    assert.equal(rows.length, 1);
    const id = rows[0].id;

    const res = await fetch(suggestionsUrl(`/${id}/dismiss`), {
      method: "POST",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).suggestion.status, "dismissed");

    const after = (await query(
      "SELECT status FROM reply_suggestions WHERE id = $1",
      [id]
    )).rows[0];
    assert.equal(after.status, "dismissed");
  });

  test("(g) delete → riga rimossa; delete ripetuto → 404", async () => {
    const rows = (await query(
      "SELECT id FROM reply_suggestions WHERE site_id = $1 AND contact_email = $2",
      [site.id, "sugg.a@example.test"]
    )).rows;
    assert.equal(rows.length, 1);
    const id = rows[0].id;

    const del = await fetch(suggestionsUrl(`/${id}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, id);

    const gone = (await query(
      "SELECT COUNT(*)::int AS c FROM reply_suggestions WHERE id = $1",
      [id]
    )).rows[0];
    assert.equal(gone.c, 0);

    const again = await fetch(suggestionsUrl(`/${id}`), {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(again.status, 404);
  });
});
