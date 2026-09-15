import { query } from "../db.js";
import { logger } from "./logger.js";
import config from "../config.js";

// Real social media posting implementations for Twitter, LinkedIn, and Facebook.
// Previously a stub — now calls actual APIs when tokens are configured.
// Falls back to simulated when tokens are missing or API calls fail,
// so the scheduler never crashes and admins can distinguish real vs fake posts.

async function postToTwitter(message) {
  if (!config.twitterBearerToken) return { simulated: true };
  const res = await fetch("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.twitterBearerToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: message }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const txt = await res.text();
    logger.warn(`Twitter API ${res.status}: ${txt.slice(0, 200)}`);
    // Se il token è configurato ma l'API fallisce, PROPAGA l'errore: il post
    // resta schedulato (posted_at = NULL) e verrà ritentato al tick successivo.
    // Prima tornava { simulated: true }, facendo marcare il post come
    // "pubblicato" (consumato) anche se non è mai andato su nessuna piattaforma.
    throw new Error(`Twitter API ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  logger.info(`Postato su Twitter: ${data.data?.id || 'unknown'}`);
  return { simulated: false, externalId: data.data.id };
}

async function postToLinkedIn(message) {
  if (!config.linkedinAccessToken) return { simulated: true };
  // Ottieni l'URN del member dalla info del token
  let authorUrn = "urn:li:person:unknown";
  try {
    const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${config.linkedinAccessToken}` },
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      authorUrn = profile.sub || authorUrn;
    }
  } catch (err) {
    logger.warn("Impossible to fetch LinkedIn profile info: " + err.message);
  }

  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.linkedinAccessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: message },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const txt = await res.text();
    logger.warn(`LinkedIn API ${res.status}: ${txt.slice(0, 200)}`);
    throw new Error(`LinkedIn API ${res.status}: ${txt.slice(0, 200)}`);
  }
  logger.info(`Postato su LinkedIn: ${authorUrn}`);
  return { simulated: false };
}

async function postToFacebook(message) {
  if (!config.facebookPageToken) return { simulated: true };
  // Ottieni page ID dal page access token
  let pageId = "";
  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v18.0/me?fields=id&access_token=${config.facebookPageToken}`
    );
    if (metaRes.ok) {
      const meta = await metaRes.json();
      pageId = meta.id || "";
    }
  } catch (err) {
    logger.warn("Impossible to fetch Facebook page info: " + err.message);
  }

  if (!pageId) {
    const msg = "Impossibile ottenere page ID da Facebook token";
    logger.warn(msg);
    throw new Error(msg);
  }

  const res = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}/feed?access_token=${config.facebookPageToken}`,
    { method: "POST", body: new URLSearchParams({ message }) }
  );
  if (!res.ok) {
    const txt = await res.text();
    logger.warn(`Facebook API ${res.status}: ${txt.slice(0, 200)}`);
    throw new Error(`Facebook API ${res.status}: ${txt.slice(0, 200)}`);
  }
  logger.info(`Postato su Facebook su pagina ${pageId}`);
  return { simulated: false };
}

async function postToPlatform(platform, message) {
  switch (platform) {
    case "twitter":
      return await postToTwitter(message);
    case "linkedin":
      return await postToLinkedIn(message);
    case "facebook":
      return await postToFacebook(message);
    default:
      throw new Error(`Piatforma social non supportata: ${platform}`);
  }
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
      logger.info(
        `Social post #${post.id} pubblicato su ${post.platform}${
          result.simulated ? " (SIMULATO, non è stata chiamata alcuna API reale)" : ""
        }`
      );
    } catch (err) {
      logger.error(`Social post #${post.id} fallito: ${err.message}`);
    }
  }
}