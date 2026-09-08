import { query } from "../db.js";
import { ensureExternalId, findByExternalId } from "./external-ids.js";

// ─────────────────────────────────────────────────────────────────────────
// Onda H: Products — CRUD con prezzi associati, clone API.
// Serializzazione camelCase UUID, array prezzi inline.
// ─────────────────────────────────────────────────────────────────────────

function serializePrice(row, locationId) {
  return {
    id: row.external_id,
    name: row.name || "Standard",
    amount: Number(row.amount) || 0,
    currency: row.currency || "EUR",
    billingType: row.billing_type || "one_time",
    active: row.active !== false,
  };
}

function serializeProduct(row, locationId, prices = []) {
  return {
    id: row.external_id,
    locationId,
    name: row.name || "",
    description: row.description || "",
    type: row.product_type || "physical",
    active: row.active !== false,
    prices: prices.map(p => serializePrice(p, locationId)),
    dateAdded: row.created_at ? row.created_at.toISOString() : null,
    dateUpdated: row.updated_at ? row.updated_at.toISOString() : row.created_at.toISOString(),
  };
}

export async function listProducts(siteId, { limit = 20, startAfterId = null }, locationId) {
  let sql = "SELECT * FROM products WHERE site_id = $1";
  const params = [siteId];

  if (startAfterId) {
    const prev = (await query(
      "SELECT id FROM products WHERE external_id = $1 LIMIT 1",
      [startAfterId]
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
  const total = (await query(
    "SELECT COUNT(*) as count FROM products WHERE site_id = $1",
    [siteId]
  )).rows[0].count;

  // Carica prezzi per ogni prodotto
  const productsWithPrices = await Promise.all(
    rows.map(async (p) => {
      const priceRows = (await query(
        "SELECT * FROM product_prices WHERE product_id = $1 ORDER BY id ASC",
        [p.id]
      )).rows;
      return serializeProduct(p, locationId, priceRows);
    })
  );

  let nextStartAfterId = null;
  if (result.rows.length > limit && rows.length > 0) {
    nextStartAfterId = rows[rows.length - 1].external_id;
  }

  return {
    products: productsWithPrices,
    total: parseInt(total, 10),
    nextStartAfterId,
  };
}

export async function createProduct(siteId, { name, description, type, prices }, locationId) {
  if (!name) {
    const err = new Error("name è obbligatorio");
    err.status = 400;
    throw err;
  }

  const productType = type || "physical";
  const result = await query(
    `INSERT INTO products (site_id, name, description, product_type, active)
     VALUES ($1, $2, $3, $4, true)
     RETURNING *`,
    [siteId, name, description || "", productType]
  );

  const productRow = result.rows[0];
  if (!productRow.external_id) {
    await ensureExternalId("products", productRow.id);
  }

  // Inserisci prezzi se forniti
  let priceRows = [];
  if (Array.isArray(prices) && prices.length > 0) {
    for (const p of prices) {
      const priceResult = await query(
        `INSERT INTO product_prices (site_id, product_id, name, amount, currency, billing_type, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING *`,
        [
          siteId,
          productRow.id,
          p.name || "Standard",
          p.amount || 0,
          p.currency || "EUR",
          p.billingType || "one_time"
        ]
      );
      const pr = priceResult.rows[0];
      if (!pr.external_id) {
        await ensureExternalId("product_prices", pr.id);
      }
      priceRows.push(pr);
    }
  }

  const productRowUpdated = (await query(
    "SELECT * FROM products WHERE id = $1",
    [productRow.id]
  )).rows[0];

  return serializeProduct(productRowUpdated, locationId, priceRows);
}

export async function getProduct(siteId, productExternalId, locationId) {
  const row = await findByExternalId("products", productExternalId);
  if (!row || row.site_id !== siteId) return null;

  const priceRows = (await query(
    "SELECT * FROM product_prices WHERE product_id = $1 ORDER BY id ASC",
    [row.id]
  )).rows;

  return serializeProduct(row, locationId, priceRows);
}

export async function updateProduct(siteId, productExternalId, { name, description, type, prices }, locationId) {
  const row = await findByExternalId("products", productExternalId);
  if (!row || row.site_id !== siteId) return null;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (type !== undefined) updates.product_type = type;

  const setClauses = Object.keys(updates)
    .map((k, i) => `${k} = $${i + 3}`)
    .join(", ");

  let productRow = row;
  if (setClauses) {
    const result = await query(
      `UPDATE products SET ${setClauses}, updated_at = NOW()
       WHERE id = $1 AND site_id = $2
       RETURNING *`,
      [row.id, siteId, ...Object.values(updates)]
    );
    productRow = result.rows[0];
  }

  // Sostituisci prezzi se array fornito
  let priceRows = [];
  if (Array.isArray(prices)) {
    await query("DELETE FROM product_prices WHERE product_id = $1", [row.id]);
    for (const p of prices) {
      const priceResult = await query(
        `INSERT INTO product_prices (site_id, product_id, name, amount, currency, billing_type, active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING *`,
        [
          siteId,
          row.id,
          p.name || "Standard",
          p.amount || 0,
          p.currency || "EUR",
          p.billingType || "one_time"
        ]
      );
      const pr = priceResult.rows[0];
      if (!pr.external_id) {
        await ensureExternalId("product_prices", pr.id);
      }
      priceRows.push(pr);
    }
  } else {
    // Carica prezzi attuali se non forniti
    priceRows = (await query(
      "SELECT * FROM product_prices WHERE product_id = $1 ORDER BY id ASC",
      [row.id]
    )).rows;
  }

  return serializeProduct(productRow, locationId, priceRows);
}

export async function deleteProduct(siteId, productExternalId) {
  const row = await findByExternalId("products", productExternalId);
  if (!row || row.site_id !== siteId) return 0;

  const result = await query("DELETE FROM products WHERE id = $1", [row.id]);
  return result.rowCount;
}
