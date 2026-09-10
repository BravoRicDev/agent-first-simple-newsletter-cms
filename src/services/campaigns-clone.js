import { query } from "../db.js";
import { findByAnyId, publicId } from "./external-ids.js";
import { logger } from "./logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda E: Campagne broadcast, templates, subscriptions — clone API.
// Serializzazione camelCase UUID, paginazione cursore, scheduling.
//
// Parity ghl_id: campagne e template accettano/espongono il ghl_id reale
// del CRM sorgente quando presente — stesso pattern già applicato a
// contatti/opportunità/calendari/conversazioni/tag/custom field/form/
// survey/utenti. campaign_subscriptions NON ha ghl_id (relazione puramente
// locale, mai sincronizzata come risorsa a sé da GHL): il suo id resta
// UUID-only, ma campaignId/contactId nella risposta preferiscono comunque
// il ghl_id reale della campagna/contatto collegato.
// ─────────────────────────────────────────────────────────────────────────

function serializeCampaign(row, locationId) {
  return {
    id: publicId(row),
    locationId,
    name: row.clone_name || row.subject || "",
    subject: row.subject || "",
    status: row.status,
    type: "Email",
    scheduledAt: row.scheduled_at ? row.scheduled_at.toISOString() : null,
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : row.created_at.toISOString(),
  };
}

function serializeTemplate(row, locationId) {
  return {
    id: publicId(row),
    locationId,
    type: row.type === "SMS" ? "SMS" : "Email",
    name: row.name || "",
    subject: row.subject || "",
    bodyHtml: row.body_html || "",
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : row.created_at.toISOString(),
  };
}

function serializeSubscription(row) {
  return {
    id: row.external_id,
    campaignId: row.campaign_public_id,
    contactId: row.contact_public_id,
    status: row.status,
    addedAt: row.added_at ? row.added_at.toISOString() : null,
  };
}

// Campagne

export async function listCampaigns(siteId, { limit = 20, startAfterId = null }, locationId) {
  let sql = "SELECT * FROM newsletter_campaigns WHERE site_id = $1";
  const params = [siteId];

  if (startAfterId) {
    const afterRow = await findByAnyId("newsletter_campaigns", siteId, startAfterId);
    if (afterRow) {
      sql += ` AND id > $${params.length + 1}`;
      params.push(afterRow.id);
    }
  }

  sql += " ORDER BY id ASC LIMIT $" + (params.length + 1);
  params.push(limit + 1);

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);
  const total = (await query(
    "SELECT COUNT(*) as count FROM newsletter_campaigns WHERE site_id = $1",
    [siteId]
  )).rows[0].count;

  let nextStartAfterId = null;
  if (result.rows.length > limit && rows.length > 0) {
    nextStartAfterId = publicId(rows[rows.length - 1]);
  }

  return {
    campaigns: rows.map(r => serializeCampaign(r, locationId)),
    total: parseInt(total, 10),
    nextStartAfterId,
  };
}

export async function createCampaign(siteId, { name, subject, content }, locationId) {
  const subjectVal = subject || name || "";
  const cloneName = name || null;

  const result = await query(
    `INSERT INTO newsletter_campaigns (site_id, subject, html_content, status, clone_name)
     VALUES ($1, $2, $3, 'draft', $4)
     RETURNING *`,
    [siteId, subjectVal, content || "", cloneName]
  );

  return serializeCampaign(result.rows[0], locationId);
}

export async function getCampaign(siteId, campaignExternalId, locationId) {
  const row = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!row) return null;
  return serializeCampaign(row, locationId);
}

export async function updateCampaign(siteId, campaignExternalId, { subject, content }, locationId) {
  const row = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!row) return null;

  const updates = {};
  if (subject !== undefined) updates.subject = subject;
  if (content !== undefined) updates.html_content = content;

  const setClauses = Object.keys(updates)
    .map((k, i) => `${k} = $${i + 3}`)
    .join(", ");
  if (!setClauses) {
    return serializeCampaign(row, locationId);
  }

  const result = await query(
    `UPDATE newsletter_campaigns SET ${setClauses}
     WHERE id = $1 AND site_id = $2
     RETURNING *`,
    [row.id, siteId, ...Object.values(updates)]
  );

  return result.rows[0] ? serializeCampaign(result.rows[0], locationId) : null;
}

export async function deleteCampaign(siteId, campaignExternalId) {
  const row = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!row || row.status !== "draft") return 0;

  const result = await query("DELETE FROM newsletter_campaigns WHERE id = $1", [row.id]);
  return result.rowCount;
}

export async function scheduleCampaign(siteId, campaignExternalId, scheduledAtIso, locationId) {
  const row = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!row) return null;

  const scheduledAt = new Date(scheduledAtIso);
  const result = await query(
    `UPDATE newsletter_campaigns SET status = 'scheduled', scheduled_at = $2
     WHERE id = $1
     RETURNING *`,
    [row.id, scheduledAt]
  );

  return result.rows[0] ? serializeCampaign(result.rows[0], locationId) : null;
}

export async function unscheduleCampaign(siteId, campaignExternalId, locationId) {
  const row = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!row) return null;

  const result = await query(
    `UPDATE newsletter_campaigns SET status = 'draft', scheduled_at = NULL
     WHERE id = $1
     RETURNING *`,
    [row.id]
  );

  return result.rows[0] ? serializeCampaign(result.rows[0], locationId) : null;
}

export async function sendCampaignNow(siteId, campaignExternalId, locationId) {
  const row = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!row || (row.status !== "draft" && row.status !== "scheduled")) {
    return null;
  }

  const result = await query(
    `UPDATE newsletter_campaigns SET status = 'sending'
     WHERE id = $1
     RETURNING *`,
    [row.id]
  );

  return result.rows[0] ? serializeCampaign(result.rows[0], locationId) : null;
}

// Templates

export async function listTemplates(siteId, { type = null, limit = 20, startAfterId = null }, locationId) {
  let sql = "SELECT * FROM marketing_templates WHERE site_id = $1";
  const params = [siteId];

  if (type) {
    sql += " AND type = $" + (params.length + 1);
    params.push(type.toUpperCase());
  }

  if (startAfterId) {
    const afterRow = await findByAnyId("marketing_templates", siteId, startAfterId);
    if (afterRow) {
      sql += ` AND id > $${params.length + 1}`;
      params.push(afterRow.id);
    }
  }

  sql += " ORDER BY id ASC LIMIT $" + (params.length + 1);
  params.push(limit + 1);

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);

  let totalSql = "SELECT COUNT(*) as count FROM marketing_templates WHERE site_id = $1";
  const totalParams = [siteId];
  if (type) {
    totalSql += " AND type = $2";
    totalParams.push(type.toUpperCase());
  }
  const total = (await query(totalSql, totalParams)).rows[0].count;

  let nextStartAfterId = null;
  if (result.rows.length > limit && rows.length > 0) {
    nextStartAfterId = publicId(rows[rows.length - 1]);
  }

  return {
    templates: rows.map(r => serializeTemplate(r, locationId)),
    total: parseInt(total, 10),
    nextStartAfterId,
  };
}

export async function createTemplate(siteId, { name, type, subject, bodyHtml }, locationId) {
  const typeVal = (type || "EMAIL").toUpperCase();

  const result = await query(
    `INSERT INTO marketing_templates (site_id, type, name, subject, body_html)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [siteId, typeVal, name || "", subject || "", bodyHtml || ""]
  );

  return serializeTemplate(result.rows[0], locationId);
}

export async function getTemplate(siteId, templateExternalId, locationId) {
  const row = await findByAnyId("marketing_templates", siteId, templateExternalId);
  if (!row) return null;
  return serializeTemplate(row, locationId);
}

export async function updateTemplate(siteId, templateExternalId, { name, type, subject, bodyHtml }, locationId) {
  const row = await findByAnyId("marketing_templates", siteId, templateExternalId);
  if (!row) return null;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (type !== undefined) updates.type = type.toUpperCase();
  if (subject !== undefined) updates.subject = subject;
  if (bodyHtml !== undefined) updates.body_html = bodyHtml;

  const setClauses = Object.keys(updates)
    .map((k, i) => `${k} = $${i + 3}`)
    .join(", ");
  if (!setClauses) {
    return serializeTemplate(row, locationId);
  }

  const result = await query(
    `UPDATE marketing_templates SET ${setClauses}, updated_at = NOW()
     WHERE id = $1 AND site_id = $2
     RETURNING *`,
    [row.id, siteId, ...Object.values(updates)]
  );

  return result.rows[0] ? serializeTemplate(result.rows[0], locationId) : null;
}

export async function deleteTemplate(siteId, templateExternalId) {
  const row = await findByAnyId("marketing_templates", siteId, templateExternalId);
  if (!row) return 0;

  const result = await query("DELETE FROM marketing_templates WHERE id = $1", [row.id]);
  return result.rowCount;
}

// Subscriptions

export async function addContactToCampaign(siteId, contactExternalId, campaignExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact) return null;

  const campaign = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);
  if (!campaign) return null;

  const result = await query(
    `INSERT INTO campaign_subscriptions (site_id, campaign_id, contact_id, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (campaign_id, contact_id) DO UPDATE SET status = 'active'
     RETURNING *`,
    [siteId, campaign.id, contact.id]
  );

  return serializeSubscription({
    ...result.rows[0],
    campaign_public_id: publicId(campaign),
    contact_public_id: publicId(contact),
  });
}

export async function listContactCampaigns(siteId, contactExternalId, locationId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact) {
    return { campaigns: [], meta: { total: 0, nextPage: null, prevPage: null } };
  }

  const result = await query(
    `SELECT nc.*, cs.added_at FROM campaign_subscriptions cs
     JOIN newsletter_campaigns nc ON nc.id = cs.campaign_id
     WHERE cs.site_id = $1 AND cs.contact_id = $2 AND cs.status = 'active'
     ORDER BY nc.id ASC`,
    [siteId, contact.id]
  );

  const campaigns = result.rows.map(r => ({
    ...serializeCampaign(r, locationId),
    addedAt: r.added_at ? r.added_at.toISOString() : null,
  }));

  return {
    campaigns,
    meta: { total: result.rowCount, nextPage: null, prevPage: null },
  };
}

export async function removeContactFromCampaign(siteId, contactExternalId, campaignExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  const campaign = await findByAnyId("newsletter_campaigns", siteId, campaignExternalId);

  if (!contact || !campaign) {
    return 0;
  }

  const result = await query(
    "DELETE FROM campaign_subscriptions WHERE site_id = $1 AND campaign_id = $2 AND contact_id = $3",
    [siteId, campaign.id, contact.id]
  );

  return result.rowCount;
}

export async function removeAllContactCampaigns(siteId, contactExternalId) {
  const contact = await findByAnyId("contacts", siteId, contactExternalId);
  if (!contact) return 0;

  const result = await query(
    "DELETE FROM campaign_subscriptions WHERE site_id = $1 AND contact_id = $2",
    [siteId, contact.id]
  );

  return result.rowCount;
}
