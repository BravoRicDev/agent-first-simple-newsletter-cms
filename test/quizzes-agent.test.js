import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import agentRouter from "../src/routes/agent.js";

// Route agent per i questionari con punteggi (quiz): CRUD delle definizioni
// e lettura dei risultati. Usa un token API reale (agent:true) come farebbe
// un'automazione n8n.
describe("agent: questionari (quiz) CRUD + submissions", () => {
  let site, user, server, baseUrl, token, quizId;

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
    { min: 0, max: 2, title: "Lead freddo", message: "Va coltivato.", class: "cold" },
    { min: 3, max: 4, title: "Lead tiepido", message: "Da qualificare.", class: "warn" },
    { min: 5, max: null, title: "Lead qualificato 🔥", message: "Contattare subito.", class: "ok" },
  ];

  before(async () => {
    site = await createTestSite("Agent Quizzes Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "agent quizzes test", 30);
    token = created.token;

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(agentRouter);

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

  test("GET /quizzes senza questionari → lista vuota", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.quizzes, []);
  });

  test("POST /quizzes crea un questionario con punteggi", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Qualifica lead",
        slug: "qualifica-lead",
        intro: "Scopri quanto è qualificato il tuo lead.",
        questions: QUESTIONS,
        thresholds: THRESHOLDS,
        ask_email: true,
        contact_tag: "qualifica-lead",
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.quiz.id, "deve restituire il questionario creato");
    assert.equal(body.quiz.slug, "qualifica-lead");
    assert.equal(body.quiz.enabled, true);
    assert.equal(body.quiz.ask_email, true);
    assert.equal(body.quiz.contact_tag, "qualifica-lead");
    assert.equal(body.quiz.questions.length, 2);
    assert.equal(body.quiz.questions[0].options.length, 4);
    // max:null (open-ended) NON deve diventare 0 — Number(null)===0 rompeva
    // la soglia finale (bug fixato in sanitizeQuizThresholds).
    const lastThreshold = body.quiz.thresholds[body.quiz.thresholds.length - 1];
    assert.equal(lastThreshold.title, "Lead qualificato 🔥");
    assert.equal(lastThreshold.max, null, "la soglia open-ended deve restare null, non 0");
    quizId = body.quiz.id;
  });

  test("POST /quizzes con slug duplicato → 409", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Altro", slug: "qualifica-lead", questions: QUESTIONS, thresholds: THRESHOLDS }),
    });
    assert.equal(res.status, 409);
  });

  test("PUT /quizzes/:id aggiorna soglie e disattiva", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes/${quizId}`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, contact_tag: "" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.quiz.enabled, false);
    assert.equal(body.quiz.contact_tag, null, "contact_tag vuoto deve essere rimosso");
    assert.equal(body.quiz.questions.length, 2, "i campi omessi restano invariati");
  });

  test("GET /quizzes ora elenca il questionario con conteggio 0", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.quizzes.length, 1);
    assert.equal(parseInt(body.quizzes[0].total, 10), 0);
  });

  test("GET /quizzes/:slug/submissions su quiz senza risultati → lista vuota", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes/qualifica-lead/submissions`, { headers: auth() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 0);
    assert.deepEqual(body.submissions, []);
  });

  test("DELETE /quizzes/:id elimina la definizione", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes/${quizId}`, {
      method: "DELETE",
      headers: auth(),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.deleted, quizId);

    const list = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes`, { headers: auth() });
    const listBody = await list.json();
    assert.equal(listBody.quizzes.length, 0);
  });

  test("PUT /quizzes/:id su quiz inesistente → 404", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/${site.id}/quizzes/99999`, {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    assert.equal(res.status, 404);
  });
});
