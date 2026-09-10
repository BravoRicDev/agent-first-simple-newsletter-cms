import { query } from "../db.js";
import { getExternalId, findByAnyId, publicId } from "./external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda A: Servizio opportunities per clone API.
// Trasformazioni: stage (string) → pipelineStageId (uuid),
// contact_email → contactId (uuid via contacts.external_id),
// title → name, amount → monetaryValue, owner_id → assignedTo,
// status enum open|won|lost|abandoned.
//
// Parity ghl_id: ogni id esposto (opportunità, pipeline, pipeline stage,
// contatto, utente) preferisce il ghl_id reale del CRM sorgente quando
// presente, con fallback all'UUID interno — stesso pattern già applicato
// a contatti/calendari/conversazioni/tag.
// ─────────────────────────────────────────────────────────────────────────

export async function serializeOpportunity(row, pipelineStageId = null, contactId = null, assignedToId = null, locationId = null) {
  if (!row) return null;
  return {
    id: publicId(row),
    locationId,
    name: row.title || "",
    pipelineId: publicId({ ghl_id: row.pipeline_ghl_id, external_id: row.pipeline_external_id }),
    pipelineStageId,
    status: row.status || "open",
    monetaryValue: row.amount ? parseFloat(row.amount) : 0,
    contactId,
    assignedTo: assignedToId || null,
    source: row.source || null,
    lastStatusChange: row.last_status_change || null,
    lostReason: row.lost_reason || null,
    dateAdded: row.created_at?.toISOString() || null,
    dateUpdated: row.updated_at?.toISOString() || null,
  };
}

export async function serializePipeline(row, stages = [], locationId = null) {
  if (!row) return null;
  return {
    id: publicId(row),
    locationId,
    name: row.name || "",
    stages,
    dateAdded: row.created_at?.toISOString() || null,
    dateUpdated: row.updated_at?.toISOString() || null,
  };
}

// Risolvi uno stage (key) → pipelineStageId (ghl_id reale o uuid) da
// pipeline_stages. Se manca, inserisci lazy con external_id auto.
async function resolveOrCreatePipelineStage(siteId, pipelineId, stageKey) {
  if (!stageKey) return null;
  const existing = (await query(
    `SELECT external_id, ghl_id FROM pipeline_stages WHERE pipeline_id = $1 AND key = $2`,
    [pipelineId, stageKey]
  )).rows[0];
  if (existing) return publicId(existing);

  // Inserisci lazy
  const inserted = (await query(
    `INSERT INTO pipeline_stages (pipeline_id, key, label, position)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (pipeline_id, key) DO UPDATE SET external_id = COALESCE(pipeline_stages.external_id, gen_random_uuid())
     RETURNING external_id, ghl_id`,
    [pipelineId, stageKey, stageKey]
  )).rows[0];
  return inserted ? publicId(inserted) : null;
}

// Risolvi contactEmail → contactId (ghl_id reale o external_id).
// Ritorna null se contatto non trovato.
async function resolveContactId(siteId, contactEmail) {
  if (!contactEmail) return null;
  const row = (await query(
    `SELECT external_id, ghl_id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2)`,
    [siteId, contactEmail]
  )).rows[0];
  return row ? publicId(row) : null;
}

// Risolvi assignedTo (user_id interno) → assignedTo (ghl_id reale o uuid).
async function resolveAssignedToId(siteId, userId) {
  if (!userId) return null;
  const row = (await query(
    `SELECT external_id, ghl_id FROM users WHERE id = $1 AND site_id = $2`,
    [userId, siteId]
  )).rows[0];
  return row ? publicId(row) : null;
}

// Risolvi contactId (UUID o ghl_id reale) → contact id interno.
async function resolveContactInternalId(siteId, contactIdAny) {
  if (!contactIdAny) return null;
  const row = await findByAnyId("contacts", siteId, contactIdAny);
  return row?.id || null;
}

// Risolvi pipelineId (UUID o ghl_id reale) → pipeline id interno.
async function resolvePipelineInternalId(siteId, pipelineIdAny) {
  if (!pipelineIdAny) return null;
  const row = await findByAnyId("pipelines", siteId, pipelineIdAny);
  return row?.id || null;
}

// Risolvi pipelineStageId (UUID o ghl_id reale) → (pipeline_id, stage key).
// pipeline_stages NON ha una propria colonna site_id (tabella figlia, tenant
// derivato da pipeline_id) — niente findByAnyId qui, serve un JOIN esplicito
// su pipelines per lo scoping multi-tenant corretto (due siti sullo stesso
// account GHL possono condividere lo stesso ghl_id di stage, vedi
// db/126_ghl_id_per_site.sql: indice composito su (pipeline_id, ghl_id),
// non (site_id, ghl_id)).
async function resolvePipelineStageInternal(siteId, pipelineStageIdAny) {
  if (!pipelineStageIdAny) return { pipelineId: null, stageKey: null };
  const row = (await query(
    `SELECT ps.pipeline_id, ps.key FROM pipeline_stages ps
     JOIN pipelines p ON p.id = ps.pipeline_id AND p.site_id = $1
     WHERE ps.external_id::text = $2 OR ps.ghl_id = $2`,
    [siteId, pipelineStageIdAny]
  )).rows[0];
  if (!row) return { pipelineId: null, stageKey: null };
  return { pipelineId: row.pipeline_id, stageKey: row.key };
}

// Risolvi assignedToId (UUID o ghl_id reale) → user id interno.
async function resolveUserInternalId(siteId, assignedToAny) {
  if (!assignedToAny) return null;
  const row = await findByAnyId("users", siteId, assignedToAny);
  return row?.id || null;
}

export async function listOpportunities(siteId, filters = {}, locationId = null) {
  const params = [siteId];
  let where = "o.site_id = $1";

  if (filters.pipelineId) {
    const pipelineIntId = await resolvePipelineInternalId(siteId, filters.pipelineId);
    if (pipelineIntId) {
      params.push(pipelineIntId);
      where += ` AND o.pipeline_id = $${params.length}`;
    } else {
      return { opportunities: [], total: 0 };
    }
  }

  if (filters.pipelineStageId) {
    const resolved = await resolvePipelineStageInternal(siteId, filters.pipelineStageId);
    if (resolved.stageKey) {
      params.push(resolved.stageKey);
      where += ` AND o.stage = $${params.length}`;
    } else {
      return { opportunities: [], total: 0 };
    }
  }

  if (filters.status && ["open", "won", "lost", "abandoned"].includes(filters.status)) {
    params.push(filters.status);
    where += ` AND o.status = $${params.length}`;
  }

  if (filters.contactId) {
    const contactIntId = await resolveContactInternalId(siteId, filters.contactId);
    if (contactIntId) {
      params.push(contactIntId);
      where += ` AND o.contact_email = (SELECT email FROM contacts WHERE id = $${params.length})`;
    } else {
      return { opportunities: [], total: 0 };
    }
  }

  if (filters.q) {
    params.push(`%${filters.q}%`);
    where += ` AND o.title ILIKE $${params.length}`;
  }

  // Count totale
  const countRow = (await query(
    `SELECT COUNT(*)::int AS cnt FROM opportunities o WHERE ${where}`,
    params
  )).rows[0];
  const total = countRow?.cnt || 0;

  // Lista con paginazione cursore
  let limit = filters.limit || 20;
  if (limit < 1) limit = 1;
  if (limit > 100) limit = 100;

  let orderClause = "ORDER BY o.id DESC";
  if (filters.startAfterId) {
    const afterRow = await findByAnyId("opportunities", siteId, filters.startAfterId);
    if (afterRow) {
      params.push(afterRow.id);
      where += ` AND o.id < $${params.length}`;
      orderClause = "ORDER BY o.id DESC";
    }
  }

  const rows = (await query(
    `SELECT o.*, p.external_id AS pipeline_external_id, p.ghl_id AS pipeline_ghl_id
     FROM opportunities o
     LEFT JOIN pipelines p ON p.id = o.pipeline_id
     WHERE ${where} ${orderClause} LIMIT $${params.length + 1}`,
    [...params, limit + 1]
  )).rows;

  let nextStartAfterId = null;
  let items = rows.slice(0, limit);
  if (rows.length > limit) {
    nextStartAfterId = publicId(rows[limit]);
  }

  const opportunities = await Promise.all(
    items.map(async (row) => {
      const contactId = await resolveContactId(siteId, row.contact_email);
      const pipelineStageId = await resolveOrCreatePipelineStage(siteId, row.pipeline_id, row.stage);
      const assignedToId = await resolveAssignedToId(siteId, row.owner_id);
      return serializeOpportunity(row, pipelineStageId, contactId, assignedToId, locationId);
    })
  );

  return { opportunities, total, nextStartAfterId };
}

export async function getOpportunity(siteId, externalId, locationId = null) {
  const row = (await query(
    `SELECT o.*, p.external_id AS pipeline_external_id, p.ghl_id AS pipeline_ghl_id
     FROM opportunities o
     LEFT JOIN pipelines p ON p.id = o.pipeline_id
     WHERE o.site_id = $1 AND (o.external_id::text = $2 OR o.ghl_id = $2)`,
    [siteId, externalId]
  )).rows[0];
  if (!row) return null;

  const contactId = await resolveContactId(siteId, row.contact_email);
  const pipelineStageId = await resolveOrCreatePipelineStage(siteId, row.pipeline_id, row.stage);
  const assignedToId = await resolveAssignedToId(siteId, row.owner_id);
  return serializeOpportunity(row, pipelineStageId, contactId, assignedToId, locationId);
}

export async function createOpportunity(siteId, input = {}, locationId = null) {
  const name = (input.name || input.title || "").trim();
  if (!name) return null;

  let contactEmail = null;
  if (input.contactId) {
    const contactRow = await findByAnyId("contacts", siteId, input.contactId);
    if (!contactRow) return null; // contactId non trovato
    contactEmail = contactRow.email;
  }

  let pipelineId = null;
  if (input.pipelineId) {
    pipelineId = await resolvePipelineInternalId(siteId, input.pipelineId);
    if (!pipelineId) return null;
  }

  let stageKey = "";
  if (input.pipelineStageId) {
    const resolved = await resolvePipelineStageInternal(siteId, input.pipelineStageId);
    stageKey = resolved.stageKey || "";
  }

  let assignedToId = null;
  if (input.assignedTo) {
    assignedToId = await resolveUserInternalId(siteId, input.assignedTo);
    if (!assignedToId) return null;
  }

  const monetaryValue = parseFloat(input.monetaryValue) || 0;
  const status = (input.status || "open").toLowerCase();
  if (!["open", "won", "lost", "abandoned"].includes(status)) return null;

  const row = (await query(
    `INSERT INTO opportunities (site_id, contact_email, pipeline_id, stage, title, amount, status, source, owner_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     RETURNING *`,
    [siteId, contactEmail || "", pipelineId || null, stageKey, name, monetaryValue, status, input.source || null, assignedToId || null]
  )).rows[0];

  await getExternalId("opportunities", row.id);

  const contactId = await resolveContactId(siteId, row.contact_email);
  const pipelineStageId = await resolveOrCreatePipelineStage(siteId, row.pipeline_id, row.stage);
  const assignedToIdResolved = await resolveAssignedToId(siteId, row.owner_id);
  return serializeOpportunity(row, pipelineStageId, contactId, assignedToIdResolved, locationId);
}

export async function updateOpportunity(siteId, externalId, input = {}, locationId = null) {
  const current = await getOpportunity(siteId, externalId, locationId);
  if (!current) return null;

  const internalRow = (await query(
    `SELECT id, contact_email, pipeline_id, stage, owner_id, status FROM opportunities WHERE site_id = $1 AND (external_id::text = $2 OR ghl_id = $2)`,
    [siteId, externalId]
  )).rows[0];

  let contactEmail = internalRow.contact_email;
  if (input.contactId !== undefined) {
    if (input.contactId === null) {
      contactEmail = "";
    } else {
      const contactRow = await findByAnyId("contacts", siteId, input.contactId);
      if (!contactRow) return null;
      contactEmail = contactRow.email;
    }
  }

  let pipelineId = internalRow.pipeline_id;
  if (input.pipelineId !== undefined) {
    if (input.pipelineId === null) {
      pipelineId = null;
    } else {
      pipelineId = await resolvePipelineInternalId(siteId, input.pipelineId);
      if (!pipelineId) return null;
    }
  }

  let stageKey = internalRow.stage;
  if (input.pipelineStageId !== undefined) {
    if (input.pipelineStageId === null) {
      stageKey = "";
    } else {
      const resolved = await resolvePipelineStageInternal(siteId, input.pipelineStageId);
      stageKey = resolved.stageKey || "";
    }
  }

  let assignedToId = internalRow.owner_id;
  if (input.assignedTo !== undefined) {
    if (input.assignedTo === null) {
      assignedToId = null;
    } else {
      assignedToId = await resolveUserInternalId(siteId, input.assignedTo);
      if (!assignedToId) return null;
    }
  }

  let status = internalRow.status;
  if (input.status !== undefined) {
    const newStatus = input.status.toLowerCase();
    if (["open", "won", "lost", "abandoned"].includes(newStatus)) {
      status = newStatus;
    }
  }

  const name = input.name !== undefined ? (input.name || "").trim() : current.name;
  const monetaryValue = input.monetaryValue !== undefined ? parseFloat(input.monetaryValue) || 0 : current.monetaryValue;
  const source = input.source !== undefined ? input.source : (current.source || null);
  const lostReason = input.lostReason !== undefined ? input.lostReason : (current.lostReason || null);

  // Se status cambia, aggiorna last_status_change
  let lastStatusChange = current.lastStatusChange;
  if (status !== internalRow.status) {
    lastStatusChange = new Date().toISOString();
  }

  await query(
    `UPDATE opportunities SET contact_email = $1, pipeline_id = $2, stage = $3, title = $4, amount = $5, status = $6, source = $7, lost_reason = $8, last_status_change = $9, owner_id = $10, updated_at = NOW()
     WHERE id = $11 AND site_id = $12`,
    [contactEmail, pipelineId, stageKey, name, monetaryValue, status, source, lostReason, lastStatusChange ? new Date(lastStatusChange) : null, assignedToId, internalRow.id, siteId]
  );

  return getOpportunity(siteId, externalId, locationId);
}

export async function deleteOpportunity(siteId, externalId) {
  const row = (await query(
    `DELETE FROM opportunities WHERE site_id = $1 AND (external_id::text = $2 OR ghl_id = $2) RETURNING id`,
    [siteId, externalId]
  )).rows[0];
  return row ? 1 : 0;
}

export async function setOpportunityStatus(siteId, externalId, status, locationId = null) {
  const newStatus = (status || "").toLowerCase();
  if (!["open", "won", "lost", "abandoned"].includes(newStatus)) return null;

  const internalRow = (await query(
    `SELECT id, status FROM opportunities WHERE site_id = $1 AND (external_id::text = $2 OR ghl_id = $2)`,
    [siteId, externalId]
  )).rows[0];
  if (!internalRow) return null;

  let lastStatusChange = null;
  if (newStatus !== internalRow.status) {
    lastStatusChange = new Date();
  }

  await query(
    `UPDATE opportunities SET status = $1, last_status_change = $2, updated_at = NOW() WHERE id = $3 AND site_id = $4`,
    [newStatus, lastStatusChange, internalRow.id, siteId]
  );

  return getOpportunity(siteId, externalId, locationId);
}

export async function searchOpportunities(siteId, filters = {}, locationId = null) {
  return listOpportunities(siteId, filters, locationId);
}

// Ritorna { opportunity, created }: created=true se la upsert ha INSERTato
// una nuova riga, false se ha aggiornato quella esistente.
export async function upsertOpportunity(siteId, input = {}, locationId = null) {
  // Match: contactId + name
  if (!input.contactId || !input.name) return null;

  const contactIntId = await resolveContactInternalId(siteId, input.contactId);
  if (!contactIntId) {
    // Contact non trovato → crea nuovo
    const opp = await createOpportunity(siteId, input, locationId);
    return opp ? { opportunity: opp, created: true } : null;
  }

  const contactEmail = (await query(
    `SELECT email FROM contacts WHERE id = $1`,
    [contactIntId]
  )).rows[0]?.email;

  const existing = (await query(
    `SELECT id, external_id, ghl_id FROM opportunities WHERE site_id = $1 AND LOWER(contact_email) = LOWER($2) AND LOWER(title) = LOWER($3)`,
    [siteId, contactEmail, input.name.trim()]
  )).rows[0];

  if (existing) {
    // Update
    const opp = await updateOpportunity(siteId, publicId(existing), input, locationId);
    return opp ? { opportunity: opp, created: false } : null;
  } else {
    // Create
    const opp = await createOpportunity(siteId, input, locationId);
    return opp ? { opportunity: opp, created: true } : null;
  }
}

export async function listOpportunityFollowers(siteId, opportunityExternalId) {
  const oppRow = await findByAnyId("opportunities", siteId, opportunityExternalId);
  if (!oppRow) return [];

  const rows = (await query(
    `SELECT f.external_id, u.external_id AS user_external_id, u.ghl_id AS user_ghl_id, u.name, u.email FROM opportunity_followers f
     JOIN users u ON u.id = f.user_id
     WHERE f.opportunity_id = $1 AND f.site_id = $2
     ORDER BY f.created_at DESC`,
    [oppRow.id, siteId]
  )).rows;

  return rows.map((r) => ({
    id: publicId({ external_id: r.user_external_id, ghl_id: r.user_ghl_id }),
    firstName: r.name || "",
    email: r.email || "",
  }));
}

export async function addOpportunityFollower(siteId, opportunityExternalId, userExternalId) {
  const oppRow = await findByAnyId("opportunities", siteId, opportunityExternalId);
  if (!oppRow) return null;

  const userRow = await findByAnyId("users", siteId, userExternalId);
  if (!userRow) return null;

  try {
    await query(
      `INSERT INTO opportunity_followers (site_id, opportunity_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (opportunity_id, user_id) DO NOTHING`,
      [siteId, oppRow.id, userRow.id]
    );
  } catch {
    return null;
  }

  return { id: publicId(userRow), firstName: userRow.name || "", email: userRow.email || "" };
}

export async function removeOpportunityFollower(siteId, opportunityExternalId, userExternalId) {
  const oppRow = await findByAnyId("opportunities", siteId, opportunityExternalId);
  if (!oppRow) return 0;

  const userRow = await findByAnyId("users", siteId, userExternalId);
  if (!userRow) return 0;

  const result = await query(
    `DELETE FROM opportunity_followers WHERE opportunity_id = $1 AND user_id = $2 AND site_id = $3`,
    [oppRow.id, userRow.id, siteId]
  );
  return result.rowCount;
}

export async function listPipelines(siteId, locationId = null) {
  const rows = (await query(
    `SELECT * FROM pipelines WHERE site_id = $1 ORDER BY created_at DESC`,
    [siteId]
  )).rows;

  return Promise.all(
    rows.map(async (p) => {
      const stageRows = (await query(
        `SELECT external_id, ghl_id, label FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position ASC`,
        [p.id]
      )).rows;
      const generatedExtId = await getExternalId("pipelines", p.id);
      const id = publicId(p) || generatedExtId;
      return serializePipeline(
        { ...p, external_id: id },
        stageRows.map((s) => ({ id: publicId(s) || s.external_id, name: s.label })),
        locationId
      );
    })
  );
}

export async function getPipeline(siteId, pipelineExternalId, locationId = null) {
  const row = await findByAnyId("pipelines", siteId, pipelineExternalId);
  if (!row) return null;

  const stageRows = (await query(
    `SELECT external_id, ghl_id, label FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position ASC`,
    [row.id]
  )).rows;

  return serializePipeline(row, stageRows.map((s) => ({ id: publicId(s) || s.external_id, name: s.label })), locationId);
}

export async function createPipeline(siteId, input = {}, locationId = null) {
  const name = (input.name || "").trim();
  if (!name) return null;

  const row = (await query(
    // NB: la tabella pipelines NON ha updated_at (solo created_at, db/043)
    `INSERT INTO pipelines (site_id, name, stages)
     VALUES ($1, $2, '[]')
     RETURNING *`,
    [siteId, name]
  )).rows[0];

  // Inserisci stages se forniti
  const stages = [];
  if (Array.isArray(input.stages)) {
    for (let i = 0; i < input.stages.length; i++) {
      const stageName = (input.stages[i].name || "").trim();
      if (!stageName) continue;
      const stageRow = (await query(
        `INSERT INTO pipeline_stages (pipeline_id, key, label, position)
         VALUES ($1, $2, $3, $4)
         RETURNING external_id, ghl_id, label`,
        [row.id, `stage_${i}`, stageName, i]
      )).rows[0];
      // external_id arriva già dal DEFAULT della colonna (migrazione 090):
      // nessuna ensure necessaria, getExternalId qui romperebbe (vorrebbe un int)
      stages.push({ id: publicId(stageRow) || stageRow.external_id, name: stageName });
    }
  }

  return serializePipeline(row, stages, locationId);
}

export async function updatePipeline(siteId, pipelineExternalId, input = {}, locationId = null) {
  const current = await getPipeline(siteId, pipelineExternalId, locationId);
  if (!current) return null;

  const row = await findByAnyId("pipelines", siteId, pipelineExternalId);

  const name = input.name !== undefined ? (input.name || "").trim() : current.name;
  if (!name) return null;

  await query(
    // NB: pipelines non ha updated_at: aggiorniamo solo il nome
    `UPDATE pipelines SET name = $1 WHERE id = $2 AND site_id = $3`,
    [name, row.id, siteId]
  );

  // Aggiorna stages (preserva key/label matching)
  if (Array.isArray(input.stages)) {
    const existingStages = (await query(
      `SELECT id, key, label FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position ASC`,
      [row.id]
    )).rows;
    const usedKeys = new Set(existingStages.map((s) => s.key));

    for (let i = 0; i < input.stages.length; i++) {
      const stageName = (input.stages[i].name || "").trim();
      if (!stageName) continue;

      const matchingExisting = existingStages.find((s) => s.label === stageName);
      if (matchingExisting) {
        // Update label
        await query(
          `UPDATE pipeline_stages SET label = $1, position = $2 WHERE id = $3`,
          [stageName, i, matchingExisting.id]
        );
      } else {
        // Insert nuovo: la key deve essere UNICA per pipeline
        // (vincolo UNIQUE(pipeline_id, key)) → slug dal label + dedup.
        let key = stageName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || `stage_${i}`;
        while (usedKeys.has(key)) key = `${key}_${i}`;
        usedKeys.add(key);
        await query(
          `INSERT INTO pipeline_stages (pipeline_id, key, label, position)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [row.id, key, stageName, i]
        );
      }
    }
  }

  return getPipeline(siteId, pipelineExternalId, locationId);
}

export async function deletePipeline(siteId, pipelineExternalId) {
  const result = await query(
    `DELETE FROM pipelines WHERE site_id = $1 AND (external_id::text = $2 OR ghl_id = $2)`,
    [siteId, pipelineExternalId]
  );
  return result.rowCount;
}

export async function getLostReasons(siteId) {
  const row = (await query(
    `SELECT value FROM tenant_config WHERE site_id = $1 AND key = 'lost_reasons'`,
    [siteId]
  )).rows[0];

  if (!row) return [];
  try {
    const value = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
