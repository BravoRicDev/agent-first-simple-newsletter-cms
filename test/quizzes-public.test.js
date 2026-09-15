import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import quizzesRouter from "../src/routes/quizzes.js";

// Route pubblica dei questionari: calcolo del punteggio SERVER-SIDE (fonte
// di verità), verdetto per soglia, salvataggio in quiz_submissions, email →
// CRM con tag, honeypot e redirect.
describe("quizzes: submit pubblico con punteggi", () => {
  let site, server, baseUrl;

  const QUESTIONS = [
    { key: "budget", label: "Qual è il budget disponibile?", options: [
      { label: "Meno di 1.000 €", points: 0 },
      { label: "1.000-5.000 €", points: 1 },
      { label: "5.000-20.000 €", points: 2 },
      { label: "Oltre 20.000 €", points: 3 },
    ] },
    { key: "authority", label: "Sei tu il decisore?", options: [
      { label: "Sì, decido io", points: 3 },
      { label: "Posso influenzare", points: 1 },
      { label: "No, devo chiedere", points: 0 },
    ] },
  ];
  const THRESHOLDS = [
    { min: 0, max: 1, title: "Lead freddo", message: "Va coltivato.", class: "cold" },
    { min: 2, max: 3, title: "Lead tiepido", message: "Da qualificare.", class: "warn" },
    { min: 4, max: null, title: "Lead qualificato 🔥", message: "Contattare subito.", class: "ok" },
  ];

  before(async () => {
    site = await createTestSite("Quizzes Public Test");
    await query(
      `INSERT INTO quizzes (site_id, slug, name, questions, thresholds, ask_email, contact_tag, redirect_url)
       VALUES ($1, 'qualifica-lead', 'Qualifica lead', $2, $3, true, 'qualifica-lead', '/grazie')`,
      [site.id, JSON.stringify(QUESTIONS), JSON.stringify(THRESHOLDS)]
    );
    await query(
      `INSERT INTO quizzes (site_id, slug, name, questions, thresholds, enabled)
       VALUES ($1, 'disattivato', 'Disattivato', $2, $3, false)`,
      [site.id, JSON.stringify(QUESTIONS), JSON.stringify(THRESHOLDS)]
    );

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(quizzesRouter);

    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => { server.close(); await closeDb(); });

  test("AJAX: punteggio massimo (3+3) → verdetto 'Lead qualificato', punti ricalcolati dal server", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        answers: { budget: "Oltre 20.000 €", authority: "Sì, decido io" },
        points: 999, // il client mente: il server deve ricalcolare
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.points, 6, "il punteggio va ricalcolato dal server, non fidarsi del client");
    assert.equal(body.result, "Lead qualificato 🔥");
    assert.equal(body.redirect, "/grazie");
  });

  test("AJAX: punteggio basso (0+0) → verdetto 'Lead freddo'", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ answers: { budget: "Meno di 1.000 €", authority: "No, devo chiedere" } }),
    });
    const body = await res.json();
    assert.equal(body.points, 0);
    assert.equal(body.result, "Lead freddo");
  });

  test("opzioni sconosciute ignorate silenziosamente (niente errori, niente punti)", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ answers: { budget: "Opzione inesistente", authority: "Sì, decido io", fantasma: "x" } }),
    });
    const body = await res.json();
    assert.equal(body.points, 3, "solo l'opzione riconosciuta conta");
    assert.equal(body.result, "Lead tiepido");
  });

  test("honeypot → 200 finto, nessun salvataggio", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ _honeypot: "bot", answers: { budget: "Oltre 20.000 €", authority: "Sì, decido io" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const count = await query("SELECT COUNT(*) AS c FROM quiz_submissions WHERE site_id = $1", [site.id]);
    assert.equal(parseInt(count.rows[0].c, 10), 3, "l'honeypot non deve salvare nulla (3 invii reali finora)");
  });

  test("browser classico (urlencoded, senza Accept JSON) → 302 alla pagina di ringraziamento", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "answers[budget]": "1.000-5.000 €",
        "answers[authority]": "Posso influenzare",
      }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/grazie");
  });

  test("quiz disattivato → 200 finto, nessun salvataggio", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/disattivato`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ answers: { budget: "Oltre 20.000 €", authority: "Sì, decido io" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    const count = await query(
      "SELECT COUNT(*) AS c FROM quiz_submissions WHERE site_id = $1 AND quiz_slug = 'disattivato'",
      [site.id]
    );
    assert.equal(parseInt(count.rows[0].c, 10), 0);
  });

  test("email compilata → contatto creato con contact_tag", async () => {
    const email = "lead-qualificato@example.test";
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        email,
        answers: { budget: "Oltre 20.000 €", authority: "Sì, decido io" },
      }),
    });
    assert.equal(res.status, 200);
    // upsertContact/addContactTag sono fire-and-forget
    await new Promise(r => setTimeout(r, 250));
    const contact = await query("SELECT tags FROM contacts WHERE site_id = $1 AND email = $2", [site.id, email]);
    assert.equal(contact.rows.length, 1, "il contatto deve esistere");
    assert.ok(contact.rows[0].tags.includes("qualifica-lead"), `tags deve contenere qualifica-lead: ${JSON.stringify(contact.rows[0].tags)}`);
  });

  test("email senza consenso marketing → nessun evento CAPI (nessun crash)", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/qualifica-lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ email: "lead-senza-consenso@example.test", answers: { budget: "Meno di 1.000 €", authority: "No, devo chiedere" } }),
    });
    assert.equal(res.status, 200);
  });

  test("quiz inesistente → 200 finto (stesso comportamento honeypot)", async () => {
    const res = await fetch(`${baseUrl}/quiz/${site.id}/non-esiste`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ answers: {} }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  test("i risultati salvati hanno punteggio e verdetto corretti", async () => {
    const rows = (await query(
      "SELECT data, total_points, result_title FROM quiz_submissions WHERE site_id = $1 AND quiz_slug = 'qualifica-lead' ORDER BY id",
      [site.id]
    )).rows;
    assert.ok(rows.length >= 4);
    const last = rows[rows.length - 1];
    assert.equal(last.total_points, 0);
    assert.equal(last.result_title, "Lead freddo");
    assert.equal(last.data.budget, "Meno di 1.000 €");
  });
});
