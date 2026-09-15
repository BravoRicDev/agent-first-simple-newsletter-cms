import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Feature: rilevamento snippet — usa una pagina come riferimento per trovare
// blocchi HTML identici (byte-per-byte, tramite offset nel sorgente) già
// presenti in altre pagine dello stesso sito, e su approvazione crea lo
// snippet sostituendo il blocco ovunque trovato.
describe("agent: snippet-candidates (rilevamento + apply)", () => {
  let site, otherSite, user, otherSiteUser, server, baseUrl, token, otherToken;

  // Deve superare la soglia minima di dimensione del rilevatore (80 byte):
  // un footer reale (multi-riga, con link) non un frammento minimale.
  // Parametrizzato per marker: l'endpoint /apply opera su TUTTO il sito, e
  // il sito è condiviso fra i test di questo file — un footer letteralmente
  // identico fra due test diversi farebbe "contare" pagine di altri test.
  function footerFor(marker) {
    return `<footer class="site-footer">
  <p>© 2026 Acme Srl [${marker}] - Via Roma 1, 20100 Milano</p>
  <p><a href="/privacy">Privacy</a> · <a href="/termini">Termini</a></p>
</footer>`;
  }

  before(async () => {
    site = await createTestSite("Snippet Detector Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "snippet detector test", 30, ["read", "write"]);
    token = created.token;

    otherSite = await createTestSite("Snippet Detector Other Site");
    otherSiteUser = await createTestUser(otherSite.id, "admin");
    const createdOther = await createApiToken(otherSiteUser.id, "snippet detector other", 30, ["read", "write"]);
    otherToken = createdOther.token;

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  async function insertPage(siteId, urlPath, title, content) {
    const result = await query(
      "INSERT INTO pages (site_id, url_path, title, content, published) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, urlPath, title, content]
    );
    return result.rows[0].id;
  }

  test("trova un blocco (footer) ripetuto identico su altre 2 pagine", async () => {
    const FOOTER = footerFor("t1");
    const homeId = await insertPage(site.id, "/", "Home", `<html><body><header><h1>Home</h1></header><main><p>Contenuto home</p></main>${FOOTER}</body></html>`);
    await insertPage(site.id, "/chi-siamo", "Chi siamo", `<html><body><header><h1>Chi siamo</h1></header><main><p>Contenuto chi siamo</p></main>${FOOTER}</body></html>`);
    await insertPage(site.id, "/contatti", "Contatti", `<html><body><header><h1>Contatti</h1></header><main><p>Contenuto contatti</p></main>${FOOTER}</body></html>`);
    // Pagina senza il footer condiviso: non deve inquinare/alterare il conteggio verso l'alto
    await insertPage(site.id, "/altro", "Altro", `<html><body><main><p>Pagina isolata</p></main></body></html>`);

    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();

    const footerCandidate = body.candidates.find((c) => c.tag === "footer");
    assert.ok(footerCandidate, "deve trovare il footer come candidato");
    assert.equal(footerCandidate.occurrence_count, 3);
    assert.equal(footerCandidate.occurrences.length, 3);
    assert.ok(footerCandidate.preview.includes("Acme Srl"));
    assert.match(footerCandidate.hash, /^[a-f0-9]{64}$/);
  });

  test("non propone blocchi presenti su una sola pagina", async () => {
    const uniqueId = await insertPage(site.id, "/pagina-unica", "Unica", `<html><body><section class="solo-qui"><p>${"x".repeat(200)}</p></section></body></html>`);
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${uniqueId}/snippet-candidates`, { headers: auth() });
    const body = await res.json();
    const found = body.candidates.find((c) => c.tag === "section" && c.preview.includes("solo-qui"));
    assert.equal(found, undefined);
  });

  test("apply: crea lo snippet, lo applica a tutte le pagine che contengono il blocco, versiona ogni pagina", async () => {
    const FOOTER = footerFor("t3");
    const homeContent = `<html><body><header><h1>Home v2</h1></header><main><p>v2</p></main>${FOOTER}</body></html>`;
    const homeId = await insertPage(site.id, "/apply-home", "Apply Home", homeContent);
    const aboutContent = `<html><body><header><h1>About v2</h1></header><main><p>about v2</p></main>${FOOTER}</body></html>`;
    await insertPage(site.id, "/apply-about", "Apply About", aboutContent);

    const findRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates`, { headers: auth() });
    const findBody = await findRes.json();
    const footerCandidate = findBody.candidates.find((c) => c.tag === "footer");
    assert.ok(footerCandidate);

    const applyRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates/apply`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ hash: footerCandidate.hash, name: `footer-apply-${homeId}`, description: "footer condiviso" }),
    });
    assert.equal(applyRes.status, 201);
    const applyBody = await applyRes.json();

    assert.equal(applyBody.snippet.name, `footer-apply-${homeId}`);
    assert.ok(applyBody.snippet.content.includes("Acme Srl"));
    assert.equal(applyBody.pages_updated.length, 2);

    const pagesAfter = (await query("SELECT id, content FROM pages WHERE id = ANY($1)", [applyBody.pages_updated.map((p) => p.id)])).rows;
    for (const p of pagesAfter) {
      assert.ok(p.content.includes(`{{snippet:footer-apply-${homeId}}}`), "il tag deve sostituire il blocco letterale");
      assert.ok(!p.content.includes("</footer>"), "il markup letterale del footer non deve più essere presente");
    }

    const versions = (await query(
      "SELECT page_id, content FROM page_versions WHERE page_id = ANY($1) ORDER BY created_at DESC",
      [applyBody.pages_updated.map((p) => p.id)]
    )).rows;
    assert.equal(versions.length, 2, "ogni pagina modificata deve avere uno snapshot pre-modifica");
    for (const v of versions) {
      assert.ok(v.content.includes("</footer>"), "lo snapshot deve contenere il markup ORIGINALE, non il tag");
    }
  });

  test("apply: 409 se il nome dello snippet esiste già", async () => {
    const FOOTER = footerFor("t4");
    const homeId = await insertPage(site.id, "/dup-home", "Dup Home", `<html><body>${FOOTER}<main>x</main>${footerFor("t4-variant")}</body></html>`);
    await insertPage(site.id, "/dup-other", "Dup Other", `<html><body>${FOOTER}</body></html>`);

    const findRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates`, { headers: auth() });
    const findBody = await findRes.json();
    const footerCandidate = findBody.candidates.find((c) => c.preview.includes("Acme Srl"));
    assert.ok(footerCandidate);

    await query("INSERT INTO snippets (site_id, name, content) VALUES ($1, 'dup-name-taken', 'x')", [site.id]);

    const applyRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates/apply`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ hash: footerCandidate.hash, name: "dup-name-taken" }),
    });
    assert.equal(applyRes.status, 409);
  });

  test("apply: 404 se l'hash non corrisponde più a nulla sulla pagina di riferimento", async () => {
    const homeId = await insertPage(site.id, "/stale-home", "Stale Home", `<html><body>${footerFor("t5")}</body></html>`);
    const applyRes = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates/apply`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ hash: "0".repeat(64), name: "non-esistera-mai" }),
    });
    assert.equal(applyRes.status, 404);
  });

  test("isolamento tenant: non si possono cercare/leggere candidati su una pagina di un altro sito", async () => {
    const homeId = await insertPage(site.id, "/tenant-home", "Tenant Home", `<html><body>${footerFor("t6")}</body></html>`);
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/pages/${homeId}/snippet-candidates`, { headers: auth(otherToken) });
    assert.equal(res.status, 403);
  });
});
