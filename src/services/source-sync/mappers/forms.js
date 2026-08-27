import { query } from "../../../db.js";
import { upsertByExternalId, findInternalId } from "../upsert.js";

export async function syncAll(ctx) {
  const { siteId, client, cfg, dryRun, addStat, knownContacts, discoveredContacts, log } = ctx;

  try {
    // Forms — GET /forms/ (doc CRM sorgente 2021-07-28): path CON trailing slash,
    // risposta { forms: [...], total } (total è una stringa in cima alla
    // risposta, NON dentro meta). Paginazione skip/limit (limit max 50,
    // default 10): senza limit esplicito l'API ne restituisce solo 10,
    // perdendo i form oltre il decimo. Paginiamo a mano con skip/limit.
    let formsSkip = 0;
    for (;;) {
      const formsRes = await client.get("/forms/", {
        locationId: cfg.location_id,
        limit: 50,
        skip: formsSkip,
      });
      const forms = Array.isArray(formsRes) ? formsRes : formsRes?.forms || [];
      if (forms.length === 0) break;
      addStat("forms", "fetched", forms.length);

      if (!dryRun) {
        for (const form of forms) {
          try {
            const formSlug =
              form.slug ||
              (form.name || "form").toLowerCase().replace(/\s+/g, "-") +
                "-" +
                Math.random().toString(36).slice(2, 8);
            const cols = {
              name: form.name || "",
              slug: formSlug,
              fields: JSON.stringify(form.fields || []),
            };
            // NOTA (da verificare con dati live): l'esempio della doc
            // 2021-07-28 per GET /forms/ mostra solo { id, name, locationId }
            // — non è documentato con certezza che la lista esponga slug,
            // fields, dateAdded/dateUpdated. Li leggiamo in modo difensivo
            // (fallback a valori vuoti / data di sync) senza rompere nulla.
            const timestamps = {
              createdAt: form.dateAdded,
              updatedAt: form.dateUpdated,
            };

            const { action } = await upsertByExternalId({
              table: "forms",
              siteId,
              externalId: form.id,
              cols,
              timestamps,
            });

            if (action === "inserted") addStat("forms", "upserted", 1);
            else if (action === "updated") addStat("forms", "updated", 1);
            else addStat("forms", "skipped", 1);
          } catch (err) {
            addStat("forms", "errors", 1);
            log(`form ${form.id}: ${err.message}`);
          }
        }
      } else {
        addStat("forms", "upserted", forms.length);
      }

      if (forms.length < 50) break;
      formsSkip += 50;
    }

    // Submissions — GET /forms/submissions (doc CRM sorgente 2021-07-28): risposta
    // { submissions: [...], meta: { total, currentPage, nextPage, prevPage } }.
    // Paginazione PER NUMERO DI PAGINA (param "page", default 1, limit max
    // 100): meta.nextPage è il NUMERO della pagina successiva (o null). NON
    // è una paginazione a cursore.
    //   - client.paginate() NON è adatto: pathToKey("/forms/submissions")
    //     ritorna "forms" (leggerebbe res.forms, inesistente → 0 risultati)
    //     e tratterebbe meta.nextPage come startAfterId rileggendo sempre la
    //     pagina 1 → loop infinito (stesso bug visto su /contacts).
    //   - il campo data di invio si chiama "createdAt" (NON "submittedAt"):
    //     usare submittedAt azzerava sempre la data a "now".
    // Paginiamo a mano seguendo meta.nextPage come numero di pagina.
    let page = 1;
    for (;;) {
      const subsRes = await client.raw("/forms/submissions", {
        params: { page, limit: 100 },
      });
      const submissions = Array.isArray(subsRes) ? subsRes : subsRes?.submissions || [];
      addStat("forms", "fetched", submissions.length);

      for (const sub of submissions) {
        try {
          const existing = !dryRun
            ? (
                await query(
                  "SELECT id, created_at FROM form_submissions WHERE external_id = $1 AND site_id = $2 LIMIT 1",
                  [sub.id, siteId]
                )
              ).rows[0]
            : null;

          if (existing) {
            addStat("forms", "skipped", 1);
          } else {
            if (!dryRun) {
              await query(
                `INSERT INTO form_submissions (site_id, external_id, form_slug, data, created_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [siteId, sub.id, sub.formId || "", JSON.stringify(sub), sub.createdAt || new Date()]
              );
            }
            addStat("forms", "upserted", 1);
          }

          // Discovery: contatti sconosciuti
          if (sub.contactId && !knownContacts.has(sub.contactId)) {
            discoveredContacts.add(sub.contactId);
          }
        } catch (err) {
          addStat("forms", "errors", 1);
          log(`form_submission ${sub.id}: ${err.message}`);
        }
      }

      const meta = subsRes?.meta || {};
      // meta.nextPage è un NUMERO di pagina: fermati se assente o se non
      // avanza (guard contro loop se l'API risponde sempre la stessa pagina).
      if (typeof meta.nextPage !== "number" || meta.nextPage <= page) break;
      page = meta.nextPage;
    }
  } catch (err) {
    addStat("forms", "errors", 1);
    log(`syncAll forms fallito: ${err.message}`);
    throw err;
  }
}
