import { query } from "../db.js";
import { logger } from "./logger.js";
import { executeRelease } from "./releases.js";

export async function runReleasesDue() {
  try {
    await query("UPDATE releases SET status = 'failed', error = 'stalled', updated_at = NOW() WHERE status = 'running' AND updated_at < NOW() - INTERVAL '15 minutes'");
    const due = (await query("SELECT id FROM releases WHERE status = 'scheduled' AND scheduled_at <= NOW() ORDER BY scheduled_at, id LIMIT 10")).rows;
    let executed = 0;
    for (const r of due) {
      const out = await executeRelease(r.id, { source: "scheduler" });
      if (out?.ok) executed++;
    }
    if (due.length) logger.info(`Scheduler: release eseguite ${executed}/${due.length}`);
    return { executed, due: due.length };
  } catch (err) {
    logger.error("Scheduler releases error", { error: err.message });
    return { executed: 0, due: 0, error: err.message };
  }
}
