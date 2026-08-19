import { query } from "../db.js";
import { logger } from "./logger.js";
import config from "../config.js";

// STUB: non pubblica realmente sui social. Verifica solo che il token sia
// configurato, poi logga e ritorna successo — nessuna chiamata alle API
// Twitter/LinkedIn/Facebook. Implementarla è bassa priorità (vedi piano).
// Il chiamante deve marcare il post come "simulated" (colonna social_posts.simulated)
// così chi consulta i dati può distinguere un post davvero pubblicato da uno finto.
async function postToPlatform(platform, message) {
  switch (platform) {
    case "twitter":
      if (!config.twitterBearerToken) throw new Error("TWITTER_BEARER_TOKEN non configurato");
      break;
    case "linkedin":
      if (!config.linkedinAccessToken) throw new Error("LINKEDIN_ACCESS_TOKEN non configurato");
      break;
    case "facebook":
      if (!config.facebookPageToken) throw new Error("FACEBOOK_PAGE_TOKEN non configurato");
      break;
  }
  logger.info(`Social post simulato su ${platform}: "${message.slice(0, 60)}..."`);
  return { simulated: true };
}

export async function postScheduled() {
  let due;
  try {
    due = (await query(
      "SELECT * FROM social_posts WHERE posted_at IS NULL AND scheduled_at <= NOW()"
    )).rows;
  } catch (err) {
    // Un errore DB qui non deve bloccare il resto del tick dello scheduler
    // (review reminders, campagne, sequenze, backup...).
    logger.error("Social post query fallita", { error: err.message });
    return;
  }
  for (const post of due) {
    try {
      const result = await postToPlatform(post.platform, post.message);
      await query(
        "UPDATE social_posts SET posted_at = NOW(), simulated = $2 WHERE id = $1",
        [post.id, !!result.simulated]
      );
      logger.info(`Social post #${post.id} pubblicato su ${post.platform}${result.simulated ? " (SIMULATO, non è stata chiamata alcuna API reale)" : ""}`);
    } catch (err) {
      logger.error(`Social post #${post.id} fallito: ${err.message}`);
    }
  }
}
