import { syncBlogListingPages } from "./blog-index.js";
import { syncHomepageSections } from "./homepage-sections.js";
import { exportPublishedPages, deleteStaticPage } from "./static-export.js";
import { logger } from "./logger.js";

// Un solo punto per "i contenuti pubblici del sito sono cambiati": ricostruisce listing blog e
// sezioni homepage, rimuove i file statici indicati, ri-esporta il sito UNA volta.
export async function afterContentChange(siteId, { articleChanged = true, deleteStaticPaths = [], pageIds = null, awaitExport = true } = {}) {
  if (articleChanged) {
    try { await syncBlogListingPages(siteId); } catch (e) { logger.error(`afterContentChange blog sync site=${siteId}: ${e.message}`); }
  }
  try { await syncHomepageSections(siteId); } catch (e) { logger.error(`afterContentChange homepage sync site=${siteId}: ${e.message}`); }
  for (const p of deleteStaticPaths) {
    try { await deleteStaticPage(siteId, p); } catch (e) { logger.error(`afterContentChange deleteStatic ${p}: ${e.message}`); }
  }
  const run = exportPublishedPages({ siteId, pageIds }).catch((e) => logger.error(`afterContentChange export site=${siteId}: ${e.message}`));
  if (awaitExport) await run;
}
