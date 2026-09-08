import { query } from "../db.js";
import { ensureExternalId, findByExternalId } from "./external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda D: Surveys — sondaggi multi-domanda con risposte. Contratto camelCase
// UUID, paginazione cursore, logica condizionale show_if, answers key-value.
// ─────────────────────────────────────────────────────────────────────────

function sanitizeFieldKey(label) {
  if (!label) return "";
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function serializeSurvey(row, locationId) {
  // Recupera domande del sondaggio
  const questionsResult = await query(
    "SELECT id, position, type, label, required, options, show_if FROM survey_questions WHERE survey_id = $1 ORDER BY position ASC",
    [row.id]
  );

  const questions = await Promise.all(
    questionsResult.rows.map(async (q) => {
      const questionExternalId = await ensureExternalId("survey_questions", q.id);
      return {
        id: questionExternalId,
        position: q.position,
        type: q.type,
        label: q.label,
        required: q.required,
        options: q.options || [],
        showIf: q.show_if || null,
      };
    })
  );

  return {
    id: row.external_id,
    locationId,
    name: row.name,
    status: row.status,
    questions,
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

async function serializeSubmission(row, locationId) {
  let contactExternalId = null;
  if (row.contact_id) {
    contactExternalId = await ensureExternalId("contacts", row.contact_id);
  }

  const surveyExternalId = await ensureExternalId("surveys", row.survey_id);

  return {
    id: row.external_id,
    surveyId: surveyExternalId,
    contactId: contactExternalId,
    submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
    answers: row.answers || {},
  };
}

// Surveys

export async function listSurveys(siteId, { limit = 20, startAfterId = null }, locationId) {
  let sql = "SELECT * FROM surveys WHERE site_id = $1";
  const params = [siteId];

  if (startAfterId) {
    sql += " AND id > (SELECT id FROM surveys WHERE external_id = $2 LIMIT 1)";
    params.push(startAfterId);
  }

  sql += " ORDER BY id ASC LIMIT $" + (params.length + 1);
  params.push(limit + 1);

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);
  const total = (await query(
    "SELECT COUNT(*) as count FROM surveys WHERE site_id = $1",
    [siteId]
  )).rows[0].count;

  let nextStartAfterId = null;
  if (result.rows.length > limit && rows.length > 0) {
    nextStartAfterId = rows[rows.length - 1].external_id;
  }

  const surveys = await Promise.all(
    rows.map((r) => serializeSurvey(r, locationId))
  );

  return {
    surveys,
    total: parseInt(total, 10),
    nextStartAfterId,
  };
}

export async function createSurvey(siteId, { name, questions = [] }, locationId) {
  if (!name) throw new Error("Name mancante");

  const result = await query(
    "INSERT INTO surveys (site_id, name, status) VALUES ($1, $2, 'draft') RETURNING *",
    [siteId, name]
  );

  const surveyRow = result.rows[0];
  if (!surveyRow.external_id) {
    await ensureExternalId("surveys", surveyRow.id);
  }

  // Inserisci domande se fornite
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    await query(
      `INSERT INTO survey_questions (survey_id, position, type, label, required, options, show_if)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        surveyRow.id,
        i,
        q.type || "TEXT",
        q.label,
        q.required || false,
        JSON.stringify(q.options || []),
        q.showIf ? JSON.stringify(q.showIf) : null,
      ]
    );
  }

  // Recupera il sondaggio completo
  const fullResult = await query("SELECT * FROM surveys WHERE id = $1", [surveyRow.id]);
  return serializeSurvey(fullResult.rows[0], locationId);
}

export async function getSurvey(siteId, surveyExternalId, locationId) {
  const row = await findByExternalId("surveys", surveyExternalId);
  if (!row || row.site_id !== siteId) return null;
  return serializeSurvey(row, locationId);
}

export async function updateSurvey(siteId, surveyExternalId, { name, status, questions }, locationId) {
  const row = await findByExternalId("surveys", surveyExternalId);
  if (!row || row.site_id !== siteId) return null;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (status !== undefined) updates.status = status;
  updates.updated_at = new Date();

  const setClauses = Object.keys(updates)
    .map((k, i) => `${k} = $${i + 3}`)
    .join(", ");

  let updatedRow = row;
  if (setClauses) {
    const result = await query(
      `UPDATE surveys SET ${setClauses} WHERE id = $1 AND site_id = $2 RETURNING *`,
      [row.id, siteId, ...Object.values(updates)]
    );
    updatedRow = result.rows[0];
  }

  // Se fornite le domande, sostituiscile tutte (REPLACE pattern)
  if (questions !== undefined) {
    await query("DELETE FROM survey_questions WHERE survey_id = $1", [updatedRow.id]);
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await query(
        `INSERT INTO survey_questions (survey_id, position, type, label, required, options, show_if)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          updatedRow.id,
          i,
          q.type || "TEXT",
          q.label,
          q.required || false,
          JSON.stringify(q.options || []),
          q.showIf ? JSON.stringify(q.showIf) : null,
        ]
      );
    }
  }

  return serializeSurvey(updatedRow, locationId);
}

export async function deleteSurvey(siteId, surveyExternalId) {
  const row = await findByExternalId("surveys", surveyExternalId);
  if (!row || row.site_id !== siteId) return 0;

  const result = await query("DELETE FROM surveys WHERE id = $1", [row.id]);
  return result.rowCount;
}

// Submissions

export async function listSurveySubmissions(siteId, surveyId, { limit = 20, startAfterId = null }, locationId) {
  // Recupera il survey per verificare ownership
  const surveyRow = await query("SELECT id, site_id FROM surveys WHERE id = $1", [surveyId]);
  if (!surveyRow.rows.length || surveyRow.rows[0].site_id !== siteId) return null;

  let sql = "SELECT * FROM survey_submissions WHERE survey_id = $1";
  const params = [surveyId];

  if (startAfterId) {
    sql += " AND id > (SELECT id FROM survey_submissions WHERE external_id = $2 LIMIT 1)";
    params.push(startAfterId);
  }

  sql += " ORDER BY id ASC LIMIT $" + (params.length + 1);
  params.push(limit + 1);

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);
  const total = (await query(
    "SELECT COUNT(*) as count FROM survey_submissions WHERE survey_id = $1",
    [surveyId]
  )).rows[0].count;

  let nextStartAfterId = null;
  if (result.rows.length > limit && rows.length > 0) {
    nextStartAfterId = rows[rows.length - 1].external_id;
  }

  const submissions = await Promise.all(
    rows.map((r) => serializeSubmission(r, locationId))
  );

  return {
    submissions,
    total: parseInt(total, 10),
    nextStartAfterId,
  };
}

export async function createSurveySubmission(siteId, surveyRef, { email, contactId, answers = {} }, locationId) {
  // surveyRef può essere l'id interno (già risolto dalla route) oppure un
  // uuid esterno: gestiamo entrambi per robustezza.
  let found;
  if (typeof surveyRef === "number" || /^\d+$/.test(String(surveyRef))) {
    const r = await query("SELECT * FROM surveys WHERE id = $1", [parseInt(surveyRef, 10)]);
    found = r.rows[0] || null;
  } else {
    found = await findByExternalId("surveys", String(surveyRef));
  }
  if (!found || found.site_id !== siteId) return null;
  const surveyId = found.id;

  // Recupera il survey
  const surveyRow = await query("SELECT id, site_id FROM surveys WHERE id = $1", [surveyId]);
  if (!surveyRow.rows.length || surveyRow.rows[0].site_id !== siteId) return null;

  let finalContactId = null;
  if (contactId) {
    // contactId è un uuid esterno: risolvilo all'id interno
    const c = await findByExternalId("contacts", contactId);
    if (!c || c.site_id !== siteId) return null;
    finalContactId = c.id;
  }

  // Se fornita email, cercane il contatto oppure crealo
  if (email && !finalContactId) {
    const contactResult = await query(
      "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
      [siteId, email]
    );
    if (contactResult.rows.length) {
      finalContactId = contactResult.rows[0].id;
    } else {
      // Upsert: crea contatto se non esiste
      const createResult = await query(
        "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') ON CONFLICT (site_id, email) DO UPDATE SET site_id = $1 RETURNING id",
        [siteId, email]
      );
      finalContactId = createResult.rows[0].id;
    }
  }

  const result = await query(
    `INSERT INTO survey_submissions (site_id, survey_id, contact_id, answers, submitted_at)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING *`,
    [siteId, surveyId, finalContactId, JSON.stringify(answers)]
  );

  const row = result.rows[0];
  if (!row.external_id) {
    await ensureExternalId("survey_submissions", row.id);
  }

  return serializeSubmission(row, locationId);
}
