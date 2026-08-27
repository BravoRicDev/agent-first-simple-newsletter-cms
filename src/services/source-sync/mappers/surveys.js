import { query } from "../../../db.js";
import { upsertByExternalId } from "../upsert.js";

async function tableExists(tableName) {
  try {
    const res = await query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1`,
      [tableName]
    );
    return res.rows.length > 0;
  } catch {
    return false;
  }
}

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, knownContacts, discoveredContacts, log } = ctx;

  const surveysTableExists = await tableExists("surveys");

  try {
    // ── Surveys (GET /surveys/, doc CRM sorgente 2021-07-28) ──
    // Paginazione skip/limit (limit default 10, MAX 50 su questa versione).
    // Risposta documentata: { surveys: [{ id, name, locationId }], total }.
    // L'oggetto survey della LISTA espone solo id/name/locationId: slug/
    // questions/dateAdded/dateUpdated NON sono documentati sull'endpoint di
    // lista (probabilmente solo su GET /surveys/{id}, non chiamato qui) → li
    // leggiamo in modo difensivo, con fallback, e li segnaliamo nel report
    // come "da verificare con dati live".
    let skip = 0;
    const SURVEY_PAGE = 50;
    for (;;) {
      const surveysRes = await client.raw("/surveys/", {
        params: { locationId: cfg.location_id, skip, limit: SURVEY_PAGE },
      });
      const surveys = Array.isArray(surveysRes)
        ? surveysRes
        : surveysRes?.surveys || [];
      addStat("surveys", "fetched", surveys.length);

      if (!dryRun && surveysTableExists) {
        for (const survey of surveys) {
          try {
            const baseSlug = survey.slug ||
              (survey.name ? survey.name.toLowerCase().replace(/\s+/g, "-") : "survey");
            const surveySlug = baseSlug + "-" + Math.random().toString(36).slice(2, 8);
            const cols = {
              name: survey.name || "",
              slug: surveySlug,
              questions: JSON.stringify(survey.questions || []),
            };
            const timestamps = {
              createdAt: survey.dateAdded,
              updatedAt: survey.dateUpdated,
            };

            const { action } = await upsertByExternalId({
              table: "surveys",
              siteId,
              externalId: survey.id,
              cols,
              timestamps,
            });

            if (action === "inserted") addStat("surveys", "upserted", 1);
            else if (action === "updated") addStat("surveys", "updated", 1);
            else addStat("surveys", "skipped", 1);
          } catch (err) {
            addStat("surveys", "errors", 1);
            log(`survey ${survey.id}: ${err.message}`);
          }
        }
      } else if (surveys.length > 0) {
        addStat("surveys", "upserted", surveys.length);
      }

      const total = Number.isFinite(surveysRes?.total) ? surveysRes.total : null;
      if (surveys.length < SURVEY_PAGE) break;
      if (total !== null && skip + surveys.length >= total) break;
      skip += SURVEY_PAGE;
    }

    // ── Submissions (GET /surveys/submissions, doc CRM sorgente 2021-07-28) ──
    // Paginazione page/limit (page default 1, limit default 20, MAX 100).
    // Risposta documentata: { submissions: [...], meta: { total, currentPage,
    // nextPage, prevPage } }. NOTA: non usiamo client.paginate() perché (a) la
    // risposta ha chiave "submissions" mentre pathToKey("/surveys/submissions")
    // restituirebbe "surveys", e (b) la paginazione reale è page-based e non a
    // cursore startAfterId. Campo data invio: "createdAt" (NON "submittedAt").
    let page = 1;
    const SUB_PAGE = 100;
    for (;;) {
      const subRes = await client.raw("/surveys/submissions", {
        params: { locationId: cfg.location_id, page, limit: SUB_PAGE },
      });
      const submissions = Array.isArray(subRes) ? subRes : subRes?.submissions || [];
      addStat("surveys", "fetched", submissions.length);

      for (const sub of submissions) {
        try {
          if (surveysTableExists) {
            const cols = {
              survey_slug: sub.surveyId || "",
              data: JSON.stringify(sub),
            };
            const timestamps = {
              createdAt: sub.createdAt,
            };

            if (!dryRun) {
              await upsertByExternalId({
                table: "survey_submissions",
                siteId,
                externalId: sub.id,
                cols,
                timestamps,
              });
            }
            addStat("surveys", "upserted", 1);
          } else {
            // Fallback a form_submissions (NON ha updated_at)
            const existing = !dryRun
              ? (await query(
                  "SELECT id FROM form_submissions WHERE external_id = $1 AND site_id = $2 LIMIT 1",
                  [sub.id, siteId]
                )).rows[0]
              : null;

            if (existing) {
              addStat("surveys", "skipped", 1);
            } else {
              if (!dryRun) {
                await query(
                  `INSERT INTO form_submissions (site_id, external_id, form_slug, data, created_at)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [siteId, sub.id, "survey:" + (sub.surveyId || ""), JSON.stringify(sub), sub.createdAt || new Date()]
                );
              }
              addStat("surveys", "upserted", 1);
            }
          }

          if (sub.contactId && !knownContacts.has(sub.contactId)) {
            discoveredContacts.add(sub.contactId);
          }
        } catch (err) {
          addStat("surveys", "errors", 1);
          log(`survey_submission ${sub.id}: ${err.message}`);
        }
      }

      const subTotal = Number.isFinite(subRes?.meta?.total) ? subRes.meta.total : null;
      if (submissions.length < SUB_PAGE) break;
      if (subTotal !== null && (page - 1) * SUB_PAGE + submissions.length >= subTotal) break;
      page++;
    }
  } catch (err) {
    addStat("surveys", "errors", 1);
    log(`syncAll surveys fallito: ${err.message}`);
    throw err;
  }
}
