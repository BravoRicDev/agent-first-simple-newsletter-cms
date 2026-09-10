import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda D: Surveys clone API — sondaggi multi-domanda con risposte.
describe("Onda D — Surveys clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;

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
    // Auth REALE via dialetto moderno: Bearer api-key COMPLETA + locationId in query
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
    // parsa il body SEMPRE (anche 4xx): i test assertano su statusCode/message
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Surveys Clone");
    apiKey = await mkKey(site.id, "test key");

    // Crea contatto di test
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id };
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    // Crea app express
    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── Sondaggi ─────────────────────────────────────────────────────────────

  test("Sondaggio: create con 3 domande → list meta → get → put sostituzione → publish → submit con email → submissions list linkage → delete", async () => {
    // Create con 3 domande: TEXT, RADIO, DATE
    const createRes = await fetch("/surveys", {
      method: "POST",
      body: JSON.stringify({
        name: "Customer Experience",
        questions: [
          {
            type: "TEXT",
            label: "What is your name?",
            required: true,
            options: [],
          },
          {
            type: "RADIO",
            label: "Rate your experience",
            required: true,
            options: [
              { value: "excellent", label: "Excellent" },
              { value: "good", label: "Good" },
              { value: "fair", label: "Fair" },
            ],
          },
          {
            type: "DATE",
            label: "Visit date",
            required: false,
            options: [],
            showIf: {
              questionId: "experience",
              operator: "equals",
              value: "excellent",
            },
          },
        ],
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.survey);
    assert(createRes.data.survey.id);
    assert.equal(createRes.data.survey.name, "Customer Experience");
    assert.equal(createRes.data.survey.status, "draft");
    assert.equal(createRes.data.survey.questions.length, 3);
    assert.equal(createRes.data.survey.questions[0].type, "TEXT");
    assert.equal(createRes.data.survey.questions[1].type, "RADIO");
    assert.equal(createRes.data.survey.questions[2].type, "DATE");
    assert.equal(createRes.data.survey.questions[2].showIf.operator, "equals");
    const surveyId = createRes.data.survey.id;

    // List con meta
    const listRes = await fetch("/surveys");
    assert.equal(listRes.status, 200);
    assert(listRes.data.surveys);
    assert(listRes.data.meta);
    assert.equal(typeof listRes.data.meta.total, "number");
    assert(listRes.data.meta.total >= 1);
    const found = listRes.data.surveys.find((s) => s.id === surveyId);
    assert(found, "Survey non trovato in lista");

    // Get singolo
    const getRes = await fetch(`/surveys/${surveyId}`);
    assert.equal(getRes.status, 200);
    assert(getRes.data.survey);
    assert.equal(getRes.data.survey.id, surveyId);
    assert.equal(getRes.data.survey.questions.length, 3);

    // Put: sostituisci domande (preserva count almeno: new count = 3)
    const putRes = await fetch(`/surveys/${surveyId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: "Updated Survey",
        questions: [
          {
            type: "TEXTAREA",
            label: "Tell us more",
            required: false,
            options: [],
          },
          {
            type: "DROPDOWN",
            label: "Select category",
            required: true,
            options: [
              { value: "a", label: "Category A" },
              { value: "b", label: "Category B" },
            ],
          },
          {
            type: "CHECKBOX",
            label: "Agree to terms",
            required: true,
            options: [{ value: "yes", label: "I agree" }],
          },
        ],
      }),
    });
    assert.equal(putRes.status, 200);
    assert(putRes.data.survey);
    assert.equal(putRes.data.survey.name, "Updated Survey");
    assert.equal(putRes.data.survey.questions.length, 3);
    assert.equal(putRes.data.survey.questions[0].type, "TEXTAREA");
    assert.equal(putRes.data.survey.questions[1].type, "DROPDOWN");

    // Put: publish (cambia status)
    const publishRes = await fetch(`/surveys/${surveyId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "published" }),
    });
    assert.equal(publishRes.status, 200);
    assert.equal(publishRes.data.survey.status, "published");
    assert.equal(publishRes.data.survey.questions.length, 3, "Domande preservate se non fornite");

    // Post submission con email (upsert contatto)
    const submissionEmail = `survey-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const submitRes = await fetch(`/surveys/${surveyId}/submissions`, {
      method: "POST",
      body: JSON.stringify({
        email: submissionEmail,
        answers: {
          tell_us_more: "Great experience overall",
          select_category: "b",
          agree_to_terms: "yes",
        },
      }),
    });
    assert.equal(submitRes.status, 201);
    assert(submitRes.data.submission);
    assert(submitRes.data.submission.id);
    assert.equal(submitRes.data.submission.surveyId, surveyId);
    assert(submitRes.data.submission.contactId, "contactId dovrebbe essere presente per email");
    assert(submitRes.data.submission.answers);
    assert.equal(submitRes.data.submission.answers.select_category, "b");

    // Get submissions list con linkage
    const submissionsRes = await fetch(`/surveys/${surveyId}/submissions`);
    assert.equal(submissionsRes.status, 200);
    assert(submissionsRes.data.submissions);
    assert(submissionsRes.data.meta);
    assert(submissionsRes.data.meta.total >= 1);
    const subFound = submissionsRes.data.submissions.find((s) => s.id === submitRes.data.submission.id);
    assert(subFound, "Submission non trovato");
    assert(subFound.contactId, "Submission deve avere contactId linkato");

    // Delete survey (submission resta, contact ON DELETE SET NULL)
    const deleteRes = await fetch(`/surveys/${surveyId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal(deleteRes.data.deleted, true);

    // Verifica che survey sia effettivamente cancellato
    const verifyDeleteRes = await fetch(`/surveys/${surveyId}`);
    assert.equal(verifyDeleteRes.status, 404);

    // Verifica che submission sia ancora lì ma con survey_id = NULL (no, FK constraint = ON DELETE CASCADE)
    // Quindi la submission sarà cancellata insieme al survey (CASCADE)
    // Questo comportamento va documentato
  });

  test("Submission: POST con contactId esplicito", async () => {
    // Crea survey
    const surveyRes = await fetch("/surveys", {
      method: "POST",
      body: JSON.stringify({
        name: "Direct Contact Survey",
        questions: [
          {
            type: "TEXT",
            label: "Feedback",
            required: false,
          },
        ],
      }),
    });
    const surveyId = surveyRes.data.survey.id;

    // Submit con contactId esplicito (quello creato nel before)
    const submitRes = await fetch(`/surveys/${surveyId}/submissions`, {
      method: "POST",
      body: JSON.stringify({
        contactId: contact.externalId,
        answers: {
          feedback: "Good survey",
        },
      }),
    });
    assert.equal(submitRes.status, 201);
    assert.equal(submitRes.data.submission.contactId, contact.externalId);
    assert.equal(submitRes.data.submission.answers.feedback, "Good survey");
  });

  // Parity ghl_id: "not-a-uuid" è un formato di id valido (potrebbe essere
  // un ghl_id reale) — requireAnyId/findByAnyId lo accettano e rispondono
  // 404 (non trovato), non più 400.
  test("Errore: id non-UUID ma valido come formato, nessun match → 404", async () => {
    const res = await fetch("/surveys/not-a-uuid");
    assert.equal(res.status, 404);
  });

  test("Errore: id malformato (300 char) → 400", async () => {
    const res = await fetch(`/surveys/${"x".repeat(300)}`);
    assert.equal(res.status, 400);
    assert(res.data.statusCode);
    assert(res.data.message);
  });

  test("Errore: survey non trovato → 404", async () => {
    const fakeId = "550e8400-e29b-41d4-a716-446655440099";
    const res = await fetch(`/surveys/${fakeId}`);
    assert.equal(res.status, 404);
    assert.equal(res.data.statusCode, 404);
  });

  test("Parity ghl_id: round-trip GET/PUT/DELETE survey col ghl_id reale", async () => {
    const createRes = await fetch("/surveys", {
      method: "POST",
      body: JSON.stringify({ name: "RtSurvey" }),
    });
    assert.equal(createRes.status, 201);
    const created = createRes.data.survey;
    assert.ok(created.id, "uuid assente");

    const realGhlId = "ghlSURVEYparity001";
    await query("UPDATE surveys SET ghl_id = $1 WHERE external_id = $2", [realGhlId, created.id]);

    const getRes = await fetch(`/surveys/${realGhlId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.survey.id, realGhlId, "id risposta deve essere il ghl_id reale");

    const putRes = await fetch(`/surveys/${realGhlId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "RtSurveyUpdated" }),
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.data.survey.name, "RtSurveyUpdated");

    const deleteRes = await fetch(`/surveys/${realGhlId}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);

    const getAfterDel = await fetch(`/surveys/${realGhlId}`);
    assert.equal(getAfterDel.status, 404);
  });

  test("Parity ghl_id: submission espone surveyId/contactId reali quando presenti", async () => {
    const createRes = await fetch("/surveys", {
      method: "POST",
      body: JSON.stringify({ name: "RtSurveyForSub" }),
    });
    const created = createRes.data.survey;
    const realSurveyGhlId = "ghlSURVEYforsub001";
    await query("UPDATE surveys SET ghl_id = $1 WHERE external_id = $2", [realSurveyGhlId, created.id]);

    const realContactGhlId = "ghlCONTACTforsub001";
    await query("UPDATE contacts SET ghl_id = $1 WHERE id = $2", [realContactGhlId, contact.id]);

    const submitRes = await fetch(`/surveys/${realSurveyGhlId}/submissions`, {
      method: "POST",
      body: JSON.stringify({
        contactId: realContactGhlId,
        answers: { feedback: "ghl_id round-trip" },
      }),
    });
    assert.equal(submitRes.status, 201);
    assert.equal(submitRes.data.submission.surveyId, realSurveyGhlId);
    assert.equal(submitRes.data.submission.contactId, realContactGhlId);
  });
});
