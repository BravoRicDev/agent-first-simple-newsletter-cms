import { query } from "../../db.js";
import { WHITELIST_TABLES } from "../external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Upsert fedele per il source sync (docs/SOURCE_SYNC_PLAN.md).
// external_id = ID della risorsa sul sorgente; created_at/updated_at FORZATE
// ai valori del sorgente (dateAdded/dateUpdated) per rifletterne lo stato.
//
// Strategia select-then-write (niente ON CONFLICT: indici parziali eterogenei)
// → { row, action: 'inserted'|'updated'|'unchanged' }.
// 'unchanged' quando updated_at esistente coincide con quella sorgente:
// lo skip economico richiesto da S4.
//
// NB schema legacy: alcune tabelle NON hanno created_at/updated_at (es. tasks,
// pipelines): le colonne vengono verificate via information_schema con cache.
// ─────────────────────────────────────────────────────────────────────────

const columnCache = new Map();
async function getColumns(table) {
  if (!columnCache.has(table)) {
    const r = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    columnCache.set(table, new Set(r.rows.map((x) => x.column_name)));
  }
  return columnCache.get(table);
}

function sameInstant(a, b) {
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * @param {object} p
 * @param {string} p.table      tabella (whitelist external-ids.js)
 * @param {number} p.siteId
 * @param {string} p.externalId uuid della risorsa SORGENTE
 * @param {object} p.cols       colonne DB → valori (solo nomi colonna validi!)
 * @param {{createdAt?:Date|string, updatedAt?:Date|string}} [p.timestamps]
 */
export async function upsertByExternalId({ table, siteId, externalId, cols, timestamps = {} }) {
  if (!WHITELIST_TABLES[table]) {
    throw new Error(`Tabella non autorizzata per source-sync: ${table}`);
  }
  const tableCols = await getColumns(table);
  const createdAt = timestamps.createdAt ? new Date(timestamps.createdAt) : null;
  // Se il sorgente non dà dateUpdated usiamo dateAdded come riferimento
  // per lo skip economico (record mai toccato ⇒ niente da aggiornare).
  const updatedAt = (timestamps.updatedAt ? new Date(timestamps.updatedAt) : null) || createdAt;

  const entries = Object.entries(cols).filter(
    ([k, v]) => v !== undefined && tableCols.has(k)
  );

  // Alcune tabelle figlie (es. pipeline_stages) non hanno una colonna
  // site_id propria: il tenant è derivato tramite il genitore (pipeline_id),
  // e external_id è comunque univoco a livello globale (indice unico
  // parziale). Scopiamo per site_id solo se la colonna esiste davvero,
  // altrimenti la query fallirebbe con "column site_id does not exist" e
  // l'errore verrebbe silenziosamente inghiottito dal try/catch del caller.
  const hasSiteId = tableCols.has("site_id");
  // Idem per created_at/updated_at: alcune tabelle legacy (es. contact_notes,
  // pipelines, tasks) non hanno tutte e due le colonne — selezionarle a
  // prescindere farebbe fallire la query con "column ... does not exist".
  const selectCols = ["id"];
  if (tableCols.has("created_at")) selectCols.push("created_at");
  if (tableCols.has("updated_at")) selectCols.push("updated_at");
  const existing = (
    await query(
      hasSiteId
        ? `SELECT ${selectCols.join(", ")} FROM ${table} WHERE external_id = $1 AND site_id = $2 LIMIT 1`
        : `SELECT ${selectCols.join(", ")} FROM ${table} WHERE external_id = $1 LIMIT 1`,
      hasSiteId ? [externalId, siteId] : [externalId]
    )
  ).rows[0];

  // Skip economico S4: stessa data aggiornamento ⇒ niente da fare.
  // Tabelle senza updated_at: confronta su created_at (record mai migrato
  // con date diverse ⇒ riscrivi; stesso created_at ⇒ invariato).
  //
  // ⚠️  TRADE-OFF (S4): se dateUpdated è identica ma i COLS sono diversi
  // (es. email cambiato senza bump timestamp sorgente), il record NON viene
  // aggiornato. Presuppone che il sorgente bumpi sempre dateUpdated quando
  // i dati cambiano. Se ciò non è garantito, potrebbe causare perdita dati.
  const referenceCol = tableCols.has("updated_at") ? "updated_at" : "created_at";
  const referenceNew = referenceCol === "updated_at" ? updatedAt : createdAt;
  if (existing && sameInstant(existing[referenceCol], referenceNew)) {
    // RETURNING * completo: i caller leggono campi arbitrari (email, ecc.)
    const full = (
      await query(`SELECT * FROM ${table} WHERE id = $1`, [existing.id])
    ).rows[0];
    return { row: full || existing, action: "unchanged" };
  }

  if (!existing) {
    const names = [];
    const values = [];
    if (tableCols.has("site_id")) {
      names.push("site_id");
      values.push(siteId);
    }
    names.push("external_id");
    values.push(externalId);
    for (const [k, v] of entries) {
      names.push(k);
      values.push(v);
    }
    if (tableCols.has("created_at")) {
      names.push("created_at");
      values.push(createdAt || new Date());
    }
    if (tableCols.has("updated_at")) {
      names.push("updated_at");
      values.push(updatedAt || createdAt || new Date());
    }
    const ph = names.map((_, i) => `$${i + 1}`);
    const row = (
      await query(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES (${ph.join(", ")}) RETURNING *`,
        values
      )
    ).rows[0];
    return { row, action: "inserted" };
  }

  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [k, v] of entries) {
    setClauses.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (tableCols.has("updated_at")) {
    setClauses.push(`updated_at = $${i++}`);
    values.push(updatedAt || new Date());
  }
  if (tableCols.has("created_at")) {
    setClauses.push(`created_at = $${i++}`);
    values.push(createdAt || existing.created_at);
  }
  setClauses.push(`id = $${i++}`);
  values.push(existing.id);
  // NB: la WHERE deve aggiungere site_id SOLO se la colonna esiste
  // (come nel ramo SELECT): pipeline_stages (db/074) non ha site_id e
  // prima l'UPDATE falliva con "column site_id does not exist", facendo
  // sì che label/color/position degli stage non venissero MAI aggiornati
  // ai sync successivi (errore inghiottito dal catch del mapper).
  let where = `id = $${i++}`;
  const whereValues = [existing.id];
  if (hasSiteId) {
    where += ` AND site_id = $${i++}`;
    whereValues.push(siteId);
  }
  const row = (
    await query(
      `UPDATE ${table} SET ${setClauses.join(", ")} WHERE ${where} RETURNING *`,
      [...values, ...whereValues]
    )
  ).rows[0];
  return { row, action: "updated" };
}

/** Risolve un uuid esterno in id interno della tabella (scope sito). */
export async function findInternalId(table, siteId, externalId) {
  if (!externalId) return null;
  if (!WHITELIST_TABLES[table]) {
    throw new Error(`Tabella non autorizzata per source-sync: ${table}`);
  }
  const r = await query(
    `SELECT id FROM ${table} WHERE external_id = $1 AND site_id = $2 LIMIT 1`,
    [externalId, siteId]
  );
  return r.rows[0]?.id ?? null;
}
