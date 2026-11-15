import fs from "node:fs";
import path from "node:path";
import { query } from "../db.js";
import { logger } from "./logger.js";
import { MEDIA_ROOT, isEligible, getVariantInfo, generateVariants } from "./image-variants.js";

let tick = 0;
const PER_RUN = 3;

// Ogni 5 tick (~5 min): genera le varianti mancanti dei siti con images_srcset_mode != "0".
export async function runMediaVariantsBackfill({ everyNth = 5, limit = PER_RUN } = {}) {
  tick++;
  if (tick % everyNth !== 0) return { generated: 0, skipped: true };
  try {
    const sites = (await query("SELECT site_id FROM settings WHERE key = 'images_srcset_mode' AND value IN ('srcset','picture') AND site_id IS NOT NULL")).rows;
    let generated = 0;
    for (const { site_id } of sites) {
      const dir = path.join(MEDIA_ROOT, String(site_id));
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (generated >= limit) return { generated };
        if (!isEligible(name) || getVariantInfo(site_id, name)) continue;
        try { await generateVariants(site_id, name); generated++; } catch (err) { logger.error(`variants backfill ${site_id}/${name}: ${err.message}`); }
      }
    }
    return { generated };
  } catch (err) {
    logger.error("Media variants backfill error", { error: err.message });
    return { generated: 0, error: err.message };
  }
}
