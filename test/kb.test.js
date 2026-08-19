import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerKbRoutes } from "../src/routes/agent-kb.js";

// Knowledge base aziendale (F30): CRUD articoli + ricerca full-text italiana
// con ranking e filtro categoria. Il modulo route viene montato su un router
// locale (auth applicata qui, come farà agent.js in produzione).
describe("crm: knowledge base aziendale", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM KB Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "kb", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerKbRoutes(r);
    app.use(r);
    // Error handler 500 (stesso pattern degli altri test CRM).
    app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });

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

  async function createArticle(title, content, category = "", tags = []) {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, category, tags }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, `POST kb fallito: ${JSON.stringify(body)}`);
    return body.article;
  }

  test("(a) CRUD articolo", async () => {
    const created = await createArticle("Listino base", "Prezzi dei servizi base", "listini", ["prezzi"]);
    assert.ok(created.id);
    assert.equal(created.title, "Listino base");
    assert.equal(created.category, "listini");
    assert.deepEqual(created.tags, ["prezzi"]);

    // Elenco
    const listRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb`, { headers: auth() });
    assert.equal(listRes.status, 200);
    let body = await listRes.json();
    assert.equal(body.articles.length, 1);
    assert.equal(body.articles[0].title, "Listino base");

    // Dettaglio singolo
    const getRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/${created.id}`, { headers: auth() });
    assert.equal(getRes.status, 200);
    assert.equal((await getRes.json()).article.title, "Listino base");

    // Modifica parziale
    const updRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/${created.id}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Listino base 2026", tags: ["prezzi", "2026"] }),
    });
    assert.equal(updRes.status, 200);
    const updated = (await updRes.json()).article;
    assert.equal(updated.title, "Listino base 2026");
    assert.equal(updated.content, "Prezzi dei servizi base", "i campi non inviati restano invariati");
    assert.deepEqual(updated.tags, ["prezzi", "2026"]);

    // Eliminazione
    const delRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/${created.id}`, { method: "DELETE", headers: auth() });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);

    const afterRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb`, { headers: auth() });
    assert.equal((await afterRes.json()).articles.length, 0);
  });

  test("(b) search trova una parola nel titolo e una solo nel contenuto", async () => {
    await createArticle("Guida fatturazione", "Come si emette una fattura elettronica", "procedure", ["fattura"]);
    await createArticle("Procedura onboarding", "Come si attiva un nuovo cliente", "procedure", []);

    // Parola presente SOLO nel titolo del primo articolo.
    const byTitle = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/search?q=fatturazione`, { headers: auth() })).json();
    assert.ok(byTitle.results.some(r => r.title === "Guida fatturazione"), "deve trovare l'articolo per la parola nel titolo");

    // Parola presente SOLO nel contenuto del secondo articolo.
    const byContent = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/search?q=cliente`, { headers: auth() })).json();
    assert.ok(byContent.results.some(r => r.title === "Procedura onboarding"), "deve trovare l'articolo per la parola nel contenuto");
    assert.ok(byContent.results.some(r => typeof r.snippet === "string" && r.snippet.length > 0), "i risultati espongono lo snippet");
  });

  test("(c) search ranking: parola nel titolo davanti a parola solo nel contenuto", async () => {
    await createArticle("Listino hosting", "Offerte e prezzi dei piani hosting", "listini", ["hosting"]);
    await createArticle("Domande frequenti", "Quanto costa il listino hosting? Serve assistenza?", "faq", []);

    const res = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/search?q=hosting`, { headers: auth() })).json();
    assert.ok(res.results.length >= 2, "entrambi gli articoli devono matchare 'hosting'");
    assert.equal(res.results[0].title, "Listino hosting", "il match sul titolo deve avere rank più alto");
  });

  test("(d) filtro category sulla ricerca", async () => {
    const res = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/search?q=hosting&category=faq`, { headers: auth() })).json();
    assert.ok(res.results.length > 0, "l'articolo faq con 'hosting' nel contenuto deve essere trovato");
    assert.ok(res.results.every(r => r.category === "faq"), "solo articoli della categoria richiesta");

    const listRes = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb?category=listini`, { headers: auth() })).json();
    assert.ok(listRes.articles.every(a => a.category === "listini"));
  });

  test("(e) 404 su get/update/delete di un articolo inesistente", async () => {
    const missing = 99999999;
    const getRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/${missing}`, { headers: auth() });
    assert.equal(getRes.status, 404);

    const putRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/${missing}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Niente" }),
    });
    assert.equal(putRes.status, 404);

    const delRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/${missing}`, { method: "DELETE", headers: auth() });
    assert.equal(delRes.status, 404);
  });

  test("(f) search senza risultati → array vuoto", async () => {
    const res = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/search?q=xyzabc123`, { headers: auth() })).json();
    assert.deepEqual(res.results, []);

    const empty = await (await fetch(`${baseUrl}/api/agent/sites/${site.id}/kb/search?q=`, { headers: auth() })).json();
    assert.deepEqual(empty.results, []);
  });

  test("(g) accesso negato su sito di un altro utente (403)", async () => {
    const otherSite = await createTestSite("CRM KB Altro");
    const res = await fetch(`${baseUrl}/api/agent/sites/${otherSite.id}/kb`, { headers: auth() });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Accesso negato");
  });
});
