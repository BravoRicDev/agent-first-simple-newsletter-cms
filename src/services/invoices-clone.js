import { query } from "../db.js";
import { findByAnyId, publicId } from "./external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda H: Invoices — CRUD con items, coupon discount come riga negativa.
// Numero progressivo per sito: 'SITE<id>-<counter>'.
// "Doppio id": ghl_id reale preferito all'UUID interno in output e in
// accettazione input (findByAnyId/publicId).
// ─────────────────────────────────────────────────────────────────────────

function serializeItem(row) {
  return {
    id: publicId(row),
    description: row.description || "",
    quantity: Number(row.quantity) || 1,
    unitPrice: Number(row.unit_price) || 0,
    total: Number(row.total) || 0,
  };
}

// Risolve l'id pubblico (ghl_id reale, fallback UUID) del contatto a cui la
// fattura è collegata — stesso pattern "doppio id" della fattura stessa.
async function contactPublicId(contactInternalId) {
  if (!contactInternalId) return null;
  const c = (await query(
    "SELECT external_id, ghl_id FROM contacts WHERE id = $1",
    [contactInternalId]
  )).rows[0];
  if (!c) return null;
  return (c.ghl_id && String(c.ghl_id).trim()) || c.external_id;
}

function serializeInvoice(row, locationId, items = []) {
  return {
    id: publicId(row),
    locationId,
    invoiceNumber: row.invoice_number || "",
    contactId: row.contact_public_id || null,
    status: row.status || "draft",
    currency: row.currency || "EUR",
    issueDate: row.issue_date ? row.issue_date.toISOString().split("T")[0] : null,
    dueDate: row.due_date ? row.due_date.toISOString().split("T")[0] : null,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
    total: Number(row.total) || 0,
    notes: row.notes || "",
    items: items.map(i => serializeItem(i)),
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : row.created_at.toISOString(),
  };
}

async function getNextInvoiceNumber(siteId) {
  const result = await query(
    "SELECT COUNT(*) as count FROM invoices WHERE site_id = $1",
    [siteId]
  );
  const count = parseInt(result.rows[0].count || 0, 10);
  return `SITE${siteId}-${String(count + 1).padStart(4, "0")}`;
}

export async function listInvoices(siteId, { status = null, contactId = null, limit = 20, startAfterId = null }, locationId) {
  let sql = "SELECT * FROM invoices WHERE site_id = $1";
  const params = [siteId];
  let paramIdx = 2;

  if (status) {
    params.push(status);
    sql += ` AND status = $${paramIdx++}`;
  }

  if (contactId) {
    // contactId può essere l'UUID interno O il ghl_id reale del contatto
    const contact = await query(
      "SELECT id FROM contacts WHERE site_id = $2 AND (external_id::text = $1 OR ghl_id = $1) LIMIT 1",
      [contactId, siteId]
    );
    if (contact.rows.length > 0) {
      params.push(contact.rows[0].id);
      sql += ` AND contact_id = $${paramIdx++}`;
    } else {
      // Nessun contatto: lista vuota
      return { invoices: [], total: 0, nextStartAfterId: null };
    }
  }

  if (startAfterId) {
    // Cursore site-scoped: accetta sia UUID interno sia ghl_id reale
    const prev = (await query(
      "SELECT id FROM invoices WHERE site_id = $1 AND (external_id::text = $2 OR ghl_id = $2) LIMIT 1",
      [siteId, startAfterId]
    )).rows[0];
    if (prev) {
      params.push(prev.id);
      sql += ` AND id > $${params.length}`;
    }
  }

  params.push(limit + 1);
  sql += ` ORDER BY id ASC LIMIT $${params.length}`;

  const result = await query(sql, params);
  const rows = result.rows.slice(0, limit);

  // Calcola il COUNT correto
  let countSql = "SELECT COUNT(*) as count FROM invoices WHERE site_id = $1";
  const countParams = [siteId];
  let countParamIdx = 2;

  if (status) {
    countParams.push(status);
    countSql += ` AND status = $${countParamIdx++}`;
  }

  if (contactId) {
    const contact = await query(
      "SELECT id FROM contacts WHERE site_id = $2 AND (external_id::text = $1 OR ghl_id = $1) LIMIT 1",
      [contactId, siteId]
    );
    if (contact.rows.length > 0) {
      countParams.push(contact.rows[0].id);
      countSql += ` AND contact_id = $${countParamIdx++}`;
    }
  }

  const total = (await query(countSql, countParams)).rows[0].count;

  // Carica items per ogni fattura
  const invoicesWithItems = await Promise.all(
    rows.map(async (inv) => {
      const itemRows = (await query(
        "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC",
        [inv.id]
      )).rows;

      // Aggiungi contact_public_id per serializzazione (ghl_id reale, fallback UUID)
      inv.contact_public_id = await contactPublicId(inv.contact_id);

      return serializeInvoice(inv, locationId, itemRows);
    })
  );

  let nextStartAfterId = null;
  if (result.rows.length > limit && rows.length > 0) {
    nextStartAfterId = publicId(rows[rows.length - 1]);
  }

  return {
    invoices: invoicesWithItems,
    total: parseInt(total, 10),
    nextStartAfterId,
  };
}

export async function createInvoice(siteId, { contactId, items, dueDate, notes, couponCode }, locationId) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("items è obbligatorio e non può essere vuoto");
    err.status = 400;
    throw err;
  }

  let contactRow = null;
  if (contactId) {
    contactRow = await findByAnyId("contacts", siteId, contactId);
    if (!contactRow || contactRow.site_id !== siteId) {
      const err = new Error("Contatto non trovato");
      err.status = 404;
      throw err;
    }
  }

  // Genera numero di fattura
  const invoiceNumber = await getNextInvoiceNumber(siteId);

  // Calcola totale righe
  let lineTotal = 0;
  for (const item of items) {
    const total = (Number(item.quantity) || 1) * (Number(item.unitPrice) || 0);
    lineTotal += total;
  }

  // Applica sconto coupon se fornito
  let discountAmount = 0;
  let couponRow = null;
  if (couponCode) {
    couponRow = (await query(
      "SELECT * FROM coupons WHERE site_id = $1 AND code = $2 AND active = true LIMIT 1",
      [siteId, couponCode]
    )).rows[0];

    if (couponRow) {
      if (couponRow.discount_type === "percent") {
        discountAmount = (lineTotal * Number(couponRow.discount_value)) / 100;
      } else {
        discountAmount = Number(couponRow.discount_value) || 0;
      }
    }
  }

  const finalTotal = Math.max(0, lineTotal - discountAmount);

  // Inserisci fattura
  const invoiceResult = await query(
    `INSERT INTO invoices (site_id, contact_id, invoice_number, status, currency, due_date, notes, total)
     VALUES ($1, $2, $3, 'draft', 'EUR', $4, $5, $6)
     RETURNING *`,
    [siteId, contactRow ? contactRow.id : null, invoiceNumber, dueDate || null, notes || "", finalTotal]
  );

  const invoiceRow = invoiceResult.rows[0];

  // Inserisci items
  let itemRows = [];
  for (const item of items) {
    const itemTotal = (Number(item.quantity) || 1) * (Number(item.unitPrice) || 0);
    const itemResult = await query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [invoiceRow.id, item.description || "", item.quantity || 1, item.unitPrice || 0, itemTotal]
    );
    itemRows.push(itemResult.rows[0]);
  }

  // Aggiungi riga sconto se presente
  if (discountAmount > 0 && couponRow) {
    const discountResult = await query(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [invoiceRow.id, `Sconto: ${couponRow.code}`, 1, -discountAmount, -discountAmount]
    );
    itemRows.push(discountResult.rows[0]);
  }

  invoiceRow.contact_public_id = await contactPublicId(invoiceRow.contact_id);

  return serializeInvoice(invoiceRow, locationId, itemRows);
}

export async function getInvoice(siteId, invoiceExternalId, locationId) {
  const row = await findByAnyId("invoices", siteId, invoiceExternalId);
  if (!row || row.site_id !== siteId) return null;

  const itemRows = (await query(
    "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC",
    [row.id]
  )).rows;

  row.contact_public_id = await contactPublicId(row.contact_id);

  return serializeInvoice(row, locationId, itemRows);
}

export async function updateInvoice(siteId, invoiceExternalId, { status, dueDate, notes }, locationId) {
  const row = await findByAnyId("invoices", siteId, invoiceExternalId);
  if (!row || row.site_id !== siteId) return null;

  const updates = {};
  let paidAtUpdate = null;

  if (status !== undefined) {
    updates.status = status;
    if (status === "paid" && !row.paid_at) {
      paidAtUpdate = new Date();
    }
  }
  if (dueDate !== undefined) updates.due_date = dueDate || null;
  if (notes !== undefined) updates.notes = notes;

  let setClauses = Object.keys(updates)
    .map((k, i) => `${k} = $${i + 3}`)
    .join(", ");

  if (paidAtUpdate) {
    if (setClauses) setClauses += ", ";
    setClauses += `paid_at = $${Object.keys(updates).length + 3}`;
  }

  if (!setClauses) {
    // Nessun aggiornamento
    const itemRows = (await query(
      "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC",
      [row.id]
    )).rows;

    row.contact_public_id = await contactPublicId(row.contact_id);

    return serializeInvoice(row, locationId, itemRows);
  }

  const params = [row.id, siteId, ...Object.values(updates)];
  if (paidAtUpdate) params.push(paidAtUpdate);

  const result = await query(
    `UPDATE invoices SET ${setClauses}, updated_at = NOW()
     WHERE id = $1 AND site_id = $2
     RETURNING *`,
    params
  );

  const invoiceRow = result.rows[0];
  const itemRows = (await query(
    "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC",
    [invoiceRow.id]
  )).rows;

  invoiceRow.contact_public_id = await contactPublicId(invoiceRow.contact_id);

  return serializeInvoice(invoiceRow, locationId, itemRows);
}

export async function deleteInvoice(siteId, invoiceExternalId) {
  const row = await findByAnyId("invoices", siteId, invoiceExternalId);
  if (!row || row.site_id !== siteId || row.status !== "draft") return 0;

  const result = await query("DELETE FROM invoices WHERE id = $1", [row.id]);
  return result.rowCount;
}
