import { query, default as pool } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Merge contatti duplicati — unisce un contatto in un altro.
// Transazione unica: se un passaggio fallisce, niente merge parziale.
// ─────────────────────────────────────────────────────────────────────────

// Ordine di avanzamento degli stadi pipeline (per scegliere lo status più
// avanzato durante il merge).
const STAGE_ORDER = ["", "lead", "contattato", "chiamata_fissata", "proposta_inviata", "vinto", "perso"];

export async function mergeContacts(siteId, sourceEmail, intoEmail) {
  const source = String(sourceEmail || "").trim().toLowerCase();
  const into = String(intoEmail || "").trim().toLowerCase();
  if (!source || !into) return { error: "Email mancanti" };
  if (source === into) return { ok: true, merged: 0 }; // idempotente

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const src = (await client.query(
      "SELECT * FROM contacts WHERE site_id = $1 AND email = $2",
      [siteId, source]
    )).rows[0];
    const dst = (await client.query(
      "SELECT * FROM contacts WHERE site_id = $1 AND email = $2",
      [siteId, into]
    )).rows[0];

    await client.query(
      `INSERT INTO contacts (site_id, email) VALUES ($1, $2) ON CONFLICT (site_id, email) DO NOTHING`,
      [siteId, into]
    );

    // Unione campi: tags union, notes concat, score max, value max,
    // status più avanzato, UTM primo non vuoto, preferenze OR.
    const tags = [...new Set([...(dst?.tags || []), ...(src?.tags || [])])];
    const notes = [dst?.notes, src?.notes].filter(Boolean).join("\n---\n").slice(0, 10000);
    const score = Math.max(Number(src?.score || 0), Number(dst?.score || 0));
    const value = Math.max(Number(src?.value_estimate || 0) || 0, Number(dst?.value_estimate || 0) || 0) || null;
    const stageIdx = (a) => STAGE_ORDER.indexOf(a || "");
    const status = stageIdx(src?.status || "") >= stageIdx(dst?.status || "") ? (src?.status || dst?.status || "") : (dst?.status || src?.status || "");
    const utmSource = dst?.utm_source || src?.utm_source || null;
    const utmMedium = dst?.utm_medium || src?.utm_medium || null;
    const utmCampaign = dst?.utm_campaign || src?.utm_campaign || null;
    const firstSource = dst?.first_source || src?.first_source || "";
    const prefToken = dst?.pref_token || src?.pref_token || null;

    await client.query(
      `UPDATE contacts SET tags = $1, notes = $2, score = $3, value_estimate = $4,
         status = $5, utm_source = $6, utm_medium = $7, utm_campaign = $8,
         first_source = $9, pref_token = $10,
         pref_email = $11, pref_sms = $12, pref_phone = $13,
         pref_whatsapp = $14, pref_marketing = $15,
         updated_at = NOW()
       WHERE site_id = $16 AND email = $17`,
      [
        tags, notes, score, value, status, utmSource, utmMedium, utmCampaign,
        firstSource, prefToken,
        !!(dst?.pref_email || src?.pref_email), !!(dst?.pref_sms || src?.pref_sms),
        !!(dst?.pref_phone || src?.pref_phone), !!(dst?.pref_whatsapp || src?.pref_whatsapp),
        !!(dst?.pref_marketing || src?.pref_marketing),
        siteId, into,
      ]
    );

    // Riaggancia le tabelle collegate (email dirette).
    await client.query("UPDATE form_submissions SET data = jsonb_set(data, '{email}', to_jsonb($1::text)) WHERE site_id = $2 AND data->>'email' = $3", [into, siteId, source]);
    await client.query("UPDATE quiz_submissions SET data = jsonb_set(data, '{email}', to_jsonb($1::text)) WHERE site_id = $2 AND data->>'email' = $3", [into, siteId, source]);
    await client.query("UPDATE calls SET email = $1 WHERE site_id = $2 AND email = $3", [into, siteId, source]);
    await client.query("UPDATE tasks SET email = $1 WHERE site_id = $2 AND email = $3", [into, siteId, source]);
    await client.query("UPDATE contact_events SET email = $1 WHERE site_id = $2 AND email = $3", [into, siteId, source]);
    await client.query(
      `UPDATE newsletter_subscribers SET email = $1 WHERE site_id = $2 AND email = $3
       AND NOT EXISTS (SELECT 1 FROM newsletter_subscribers WHERE site_id = $2 AND email = $1)`,
      [into, siteId, source]
    );
    // Segmento: se il destinatario è GIÀ membro dello stesso segmento,
    // l'UPDATE violerebbe la PK (segment_id, email) → 23505 e rollback del
    // merge. Escludiamo i segmenti già occupati dal destinatario.
    await client.query(
      `UPDATE segment_members sm SET email = $1
       WHERE sm.site_id = $2 AND sm.email = $3
         AND NOT EXISTS (
           SELECT 1 FROM segment_members x
           WHERE x.site_id = $2 AND x.email = $1 AND x.segment_id = sm.segment_id
         )`,
      [into, siteId, source]
    );

    // Custom values del contatto sorgente: vanno UNITI nel destinatario
    // prima della DELETE (contact_custom_values è chiavato per contact_id,
    // FK ON DELETE CASCADE — senza copia andrebbero persi per sempre).
    if (src) {
      const dstRow = (await client.query(
        "SELECT id FROM contacts WHERE site_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1",
        [siteId, into]
      )).rows[0];
      if (dstRow && dstRow.id !== src.id) {
        const srcCv = (await client.query(
          "SELECT object_key, values FROM contact_custom_values WHERE site_id = $1 AND contact_id = $2",
          [siteId, src.id]
        )).rows;
        for (const cv of srcCv) {
          await client.query(
            `INSERT INTO contact_custom_values (site_id, contact_id, object_key, values)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (site_id, contact_id, object_key)
             DO UPDATE SET values = contact_custom_values.values || EXCLUDED.values`,
            [siteId, dstRow.id, cv.object_key, JSON.stringify(cv.values)]
          );
        }
      }
    }

    // Elimina il contatto sorgente (se esisteva).
    if (src) {
      await client.query("DELETE FROM contacts WHERE site_id = $1 AND email = $2", [siteId, source]);
    }

    await client.query("COMMIT");
    return { ok: true, merged: src ? 1 : 0, into_email: into };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
