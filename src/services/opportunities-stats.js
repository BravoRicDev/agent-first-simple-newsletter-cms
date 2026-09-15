import { query } from "../db.js";
import { getBoardPipelines, getOpportunity } from "./opportunities.js";

function mapOpportunity(row) {
  if (!row) return row;
  return { ...row, amount: Number(row.amount) || 0 };
}

export async function searchOpportunities(siteId, { q, limit = 20, offset = 0 } = {}) {
  const parsedLimit = parseInt(limit, 10);
  const lim = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 100) : 20;
  const parsedOffset = parseInt(offset, 10);
  const off = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
  const search = String(q || "").trim();
  if (!search) {
    const countResult = await query("SELECT COUNT(*) FROM opportunities WHERE site_id = $1", [siteId]);
    const rows = (await query("SELECT * FROM opportunities WHERE site_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3", [siteId, lim, off])).rows;
    return { data: rows.map(mapOpportunity), total: parseInt(countResult.rows[0].count, 10) };
  }
  const like = `%${search}%`;
  const countSql = "SELECT COUNT(*) FROM opportunities WHERE site_id = $1 AND (title ILIKE $2 OR contact_name ILIKE $2 OR contact_email ILIKE $2 OR contact_company ILIKE $2)";
  const dataSql = "SELECT * FROM opportunities WHERE site_id = $1 AND (title ILIKE $2 OR contact_name ILIKE $2 OR contact_email ILIKE $2 OR contact_company ILIKE $2) ORDER BY updated_at DESC LIMIT $3 OFFSET $4";
  const [countResult, dataResult] = await Promise.all([
    query(countSql, [siteId, like]),
    query(dataSql, [siteId, like, lim, off]),
  ]);
  return { data: dataResult.rows.map(mapOpportunity), total: parseInt(countResult.rows[0].count, 10) };
}

export async function getRevenueStats(siteId, { pipelineId } = {}) {
  const pid = pipelineId !== undefined && pipelineId !== null && pipelineId !== "" ? parseInt(pipelineId, 10) : null;
  const hasPipeline = Number.isInteger(pid);
  const params = [siteId];
  let where = "site_id = $1";
  if (hasPipeline) {
    params.push(pid);
    where += ` AND pipeline_id = $${params.length}`;
  }
  const byStatusRows = (await query(
    `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS revenue FROM opportunities WHERE ${where} GROUP BY status`,
    params
  )).rows;

  // byPipeline: group by pipeline_id + name
  const byPipelineParams = [siteId];
  let byPipelineWhere = "o.site_id = $1";
  if (hasPipeline) {
    byPipelineParams.push(pid);
    byPipelineWhere += ` AND o.pipeline_id = $${byPipelineParams.length}`;
  }
  const byPipelineRows = (await query(
    `SELECT o.pipeline_id, COALESCE(p.name,'') AS pipeline_name, COUNT(o.*)::int AS count, COALESCE(SUM(o.amount) FILTER (WHERE o.status='won'),0) AS revenue_won
     FROM opportunities o LEFT JOIN pipelines p ON p.id = o.pipeline_id
     WHERE ${byPipelineWhere}
     GROUP BY o.pipeline_id, p.name
     ORDER BY revenue_won DESC`,
    byPipelineParams
  )).rows;

  return {
    byStatus: byStatusRows.map((r) => ({ status: r.status, count: Number(r.count), revenue: Number(r.revenue) })),
    byPipeline: byPipelineRows.map((r) => ({
      pipeline_id: r.pipeline_id,
      pipeline_name: r.pipeline_name,
      count: Number(r.count),
      revenue_won: Number(r.revenue_won),
    })),
  };
}

export async function getConversionFunnel(siteId, pipelineId) {
  const pid = parseInt(pipelineId, 10);
  if (!Number.isInteger(pid)) return null;
  const pipelines = await getBoardPipelines(siteId);
  const pipeline = pipelines.find((p) => p.id === pid);
  if (!pipeline) return null;
  const stages = Array.isArray(pipeline.stages) ? pipeline.stages : [];
  if (stages.length === 0) return [];
  const rows = (await query(
    `SELECT stage, COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS revenue, COUNT(*) FILTER (WHERE status='won')::int AS won_count, COALESCE(SUM(amount) FILTER (WHERE status='won'),0) AS revenue_won
     FROM opportunities WHERE site_id = $1 AND pipeline_id = $2 GROUP BY stage`,
    [siteId, pid]
  )).rows;
  const map = new Map(rows.map((r) => [String(r.stage), r]));
  return stages.map((s) => {
    const key = s.key ? String(s.key) : String(s.label);
    const label = s.label || s.key || key;
    const row = map.get(key);
    return {
      stage: key,
      label,
      count: row ? Number(row.count) : 0,
      revenue: row ? Number(row.revenue) : 0,
      won_count: row ? Number(row.won_count) : 0,
      revenue_won: row ? Number(row.revenue_won) : 0,
    };
  });
}

export async function getVendorStats(siteId) {
  const rows = (await query(
    `SELECT u.id, u.name, u.surname, COUNT(o.*)::int AS total, COUNT(*) FILTER (WHERE o.status='won')::int AS won, COALESCE(SUM(o.amount) FILTER (WHERE o.status='won'),0) AS revenue_won
     FROM users u LEFT JOIN opportunities o ON o.owner_id = u.id AND o.site_id = $1
     WHERE u.site_id = $1 AND u.role IN ('setter','closer')
     GROUP BY u.id
     ORDER BY revenue_won DESC`,
    [siteId]
  )).rows;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    surname: r.surname,
    total: Number(r.total),
    won: Number(r.won),
    revenue_won: Number(r.revenue_won),
  }));
}

export async function getTrend(siteId, { granularity = "day", days = 30 } = {}) {
  const valid = ["day", "week", "month"];
  const gran = valid.includes(granularity) ? granularity : "day";
  let d = parseInt(days, 10);
  if (!Number.isInteger(d)) d = 30;
  d = Math.max(1, Math.min(365, d));
  const rows = (await query(
    `SELECT date_trunc($2, created_at) AS period, COUNT(*)::int AS count, COUNT(*) FILTER (WHERE status='won')::int AS won_count, COALESCE(SUM(amount) FILTER (WHERE status='won'),0) AS revenue
     FROM opportunities
     WHERE site_id = $1 AND created_at >= NOW() - ($3 || ' days')::interval
     GROUP BY period
     ORDER BY period ASC`,
    [siteId, gran, String(d)]
  )).rows;
  return rows.map((r) => ({
    period: r.period,
    count: Number(r.count),
    won_count: Number(r.won_count),
    revenue: Number(r.revenue),
  }));
}

export async function reassignOpportunityOwner(siteId, opportunityId, vendorName) {
  const opp = await getOpportunity(siteId, opportunityId);
  if (!opp) return null;
  const name = String(vendorName || "").trim();
  if (!name) {
    const err = new Error("vendor_not_found");
    throw err;
  }
  // Exact match: full name or name alone, case-insensitive
  let rows = (await query(
    `SELECT id, name, surname FROM users WHERE site_id = $1 AND role IN ('setter','closer') AND (LOWER(name || ' ' || surname) = LOWER($2) OR LOWER(name) = LOWER($2))`,
    [siteId, name]
  )).rows;
  if (rows.length === 1) {
    await query("UPDATE opportunities SET owner_id = $1, updated_at = NOW() WHERE id = $2 AND site_id = $3", [rows[0].id, parseInt(opportunityId, 10), siteId]);
    return getOpportunity(siteId, opportunityId);
  }
  if (rows.length > 1) {
    const err = new Error("vendor_ambiguous");
    err.candidates = rows.map((r) => `${r.name} ${r.surname}`.trim());
    throw err;
  }
  // Zero exact -> partial ILIKE
  rows = (await query(
    `SELECT id, name, surname FROM users WHERE site_id = $1 AND role IN ('setter','closer') AND (name || ' ' || surname) ILIKE $2`,
    [siteId, `%${name}%`]
  )).rows;
  if (rows.length === 0) {
    throw new Error("vendor_not_found");
  }
  if (rows.length === 1) {
    await query("UPDATE opportunities SET owner_id = $1, updated_at = NOW() WHERE id = $2 AND site_id = $3", [rows[0].id, parseInt(opportunityId, 10), siteId]);
    return getOpportunity(siteId, opportunityId);
  }
  const err = new Error("vendor_ambiguous");
  err.candidates = rows.map((r) => `${r.name} ${r.surname}`.trim());
  throw err;
}
