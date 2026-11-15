import fs from "node:fs";
import { query } from "../db.js";
import { originalPath, deleteTransforms } from "./image-variants.js";

export async function getFocalPoint(siteId, filename) {
  const r = (await query("SELECT x, y FROM media_focal_points WHERE site_id = $1 AND filename = $2", [siteId, filename])).rows[0];
  return r ? { x: Number(r.x), y: Number(r.y) } : null;
}
export async function setFocalPoint(siteId, filename, x, y) {
  const nx = Number(x), ny = Number(y);
  if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) { const e = new Error("invalid_focal"); e.code = "INVALID_FOCAL"; throw e; }
  if (!fs.existsSync(originalPath(siteId, filename))) { const e = new Error("not_found"); e.code = "MEDIA_NOT_FOUND"; throw e; }
  await query(`INSERT INTO media_focal_points (site_id, filename, x, y) VALUES ($1,$2,$3,$4)
               ON CONFLICT (site_id, filename) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = NOW()`, [siteId, filename, nx, ny]);
  await deleteTransforms(siteId, filename);
  return { x: nx, y: ny };
}
export async function clearFocalPoint(siteId, filename) {
  await query("DELETE FROM media_focal_points WHERE site_id = $1 AND filename = $2", [siteId, filename]);
  await deleteTransforms(siteId, filename);
}
