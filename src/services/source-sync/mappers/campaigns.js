import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

function mapStatus(sourceStatus) {
  const mapping = {
    draft: "draft",
    scheduled: "draft",
    sending: "sending",
    sent: "sent",
    completed: "sent",
    paused: "draft",
    // GET /campaigns/ (doc CRM sorgente 2021-07-28) documenta "status": "published"
    // come valore di esempio — non era gestito e finiva in "draft". Una
    // campagna pubblicata è di fatto già stata inviata: la mappiamo a "sent".
    published: "sent",
  };
  return mapping[sourceStatus] || "draft";
}

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, log } = ctx;

  try {
    // Campaigns — GET /campaigns/ (doc CRM sorgente 2021-07-28, path con trailing
    // slash). Risposta { campaigns:[{ id, name, status, locationId }] }:
    // NOTA — la shape documentata NON include "content", "dateAdded" né
    // "completedAt"; il body HTML e le date non sono restituiti da questo
    // endpoint nella versione 2021-07-28 (da verificare con dati live).
    const campaignsRes = await client.get("/campaigns/", { locationId: cfg.location_id });
    const campaigns = Array.isArray(campaignsRes) ? campaignsRes : campaignsRes?.campaigns || [];
    addStat("campaigns", "fetched", campaigns.length);

    if (!dryRun) {
      for (const campaign of campaigns) {
        try {
          const status = mapStatus(campaign.status);
          const existing = (
            await query(
              "SELECT id FROM newsletter_campaigns WHERE external_id = $1 AND site_id = $2 LIMIT 1",
              [campaign.id, siteId]
            )
          ).rows[0];

          let row;
          if (!existing) {
            row = (
              await query(
                `INSERT INTO newsletter_campaigns (site_id, external_id, subject, html_content, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [siteId, campaign.id, campaign.name || "", campaign.content || "", status, campaign.dateAdded || new Date()]
              )
            ).rows[0];
            addStat("campaigns", "upserted", 1);
          } else {
            row = (
              await query(
                `UPDATE newsletter_campaigns SET subject = $1, html_content = $2, status = $3 WHERE id = $4 RETURNING *`,
                [campaign.name || "", campaign.content || "", status, existing.id]
              )
            ).rows[0];
            addStat("campaigns", "updated", 1);
          }

          // Set sent_at se status è sent
          if (row && status === "sent" && campaign.completedAt) {
            await query(
              "UPDATE newsletter_campaigns SET sent_at = $1 WHERE id = $2",
              [campaign.completedAt, row.id]
            );
          }
        } catch (err) {
          addStat("campaigns", "errors", 1);
          log(`campaign ${campaign.id}: ${err.message}`);
        }
      }
    } else {
      addStat("campaigns", "upserted", campaigns.length);
    }

    // Templates — Nella versione 2021-07-28 NON esiste un endpoint
    // "/templates": i template email vivono in GET /emails/builder
    // (deprecato ma unico disponibile per questa versione API). La sua
    // risposta NON ha un wrapper "templates" garantito né i campi
    // "type"(sms/email), "subject" o "bodyHtml"/"body": lo schema documentato
    // è { name, templateType, dateAdded, id, version, isPlainText, previewUrl,
    // updatedBy }. /emails/builder è email-only, quindi il tipo è sempre
    // EMAIL; subject/body_html non sono esposti da questa versione (restano
    // vuoti — da verificare con dati live). Leggiamo i campi in modo
    // difensivo per non rompere se la shape reale differsice.
    const templatesRes = await client.get("/emails/builder", { locationId: cfg.location_id });
    const templates = Array.isArray(templatesRes)
      ? templatesRes
      : templatesRes?.templates || templatesRes?.emails || [];
    addStat("campaigns", "fetched", templates.length);

    if (!dryRun) {
      for (const template of templates) {
        try {
          // /emails/builder è email-only: SMS non è applicabile. Se in futuro
          // la risposta esponesse un tipo SMS lo onoriamo, altrimenti EMAIL.
          const type =
            (template.type && template.type.toUpperCase() === "SMS") ||
            (template.templateType && String(template.templateType).toUpperCase() === "SMS")
              ? "SMS"
              : "EMAIL";
          const cols = {
            type,
            name: template.name || "",
            subject: template.subject || "",
            body_html: template.bodyHtml || template.body || "",
          };
          const timestamps = {
            createdAt: template.dateAdded,
          };

          const { action } = await upsertByExternalId({
            table: "marketing_templates",
            siteId,
            externalId: template.id,
            cols,
            timestamps,
          });

          if (action === "inserted") addStat("campaigns", "upserted", 1);
          else if (action === "updated") addStat("campaigns", "updated", 1);
          else addStat("campaigns", "skipped", 1);
        } catch (err) {
          addStat("campaigns", "errors", 1);
          log(`template ${template.id}: ${err.message}`);
        }
      }
    } else if (templates.length > 0) {
      addStat("campaigns", "upserted", templates.length);
    }
  } catch (err) {
    addStat("campaigns", "errors", 1);
    log(`syncAll campaigns fallito: ${err.message}`);
    throw err;
  }
}
