import crypto from "crypto";
import { query } from "../db.js";
import { sendMagicLink } from "./email.js";
import { logger } from "./logger.js";
import { translate } from "../middleware/i18n.js";
import config from "../config.js";

const t = (key, vars) => translate(config.defaultLang, key, vars);

const MAGIC_LINK_EXPIRY_MS = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

export async function generateAndSend(email) {
  // Normalizzazione: l'email salvata può avere case diverso (es. creato da
  // admin con "User@X.com") — senza lowercase il login falliva silenziosamente.
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const userResult = await query("SELECT id, name, email FROM users WHERE email = $1 AND status = 'active'", [normalizedEmail]);
  if (userResult.rows.length === 0) {
    // Uniforma il tempo di risposta: senza questo ritardo, una email inesistente
    // risponde molto più velocemente di una esistente (che genera token, scrive
    // su DB e invia email) → user enumeration via timing.
    await new Promise(r => setTimeout(r, 250 + Math.floor(Math.random() * 200)));
    return { sent: false, reason: t("api.auth.userNotFoundOrDisabled") };
  }
  const user = userResult.rows[0];

  const token = crypto.randomBytes(48).toString("hex");
  const otp = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MS);

  await query(
    "INSERT INTO magic_links (user_id, token, otp, expires_at) VALUES ($1, $2, $3, $4)",
    [user.id, token, otp, expiresAt]
  );

  // Pulisce token scaduti da più di 24 ore (fire-and-forget, non blocca)
  query("DELETE FROM magic_links WHERE expires_at < NOW() - INTERVAL '24 hours'").catch(() => {});

  try {
    await sendMagicLink(normalizedEmail, token, otp);
  } catch (err) {
    logger.error(`Failed to send magic link email: ${err.message}`);
    return { sent: false, reason: t("email.magicLink.sendFailed") };
  }

  return { sent: true };
}

export async function verify(token, otp) {
  const linkResult = await query(
    "SELECT id, otp, failed_attempts FROM magic_links WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()",
    [token]
  );
  if (linkResult.rows.length === 0) return null;
  const link = linkResult.rows[0];

  if (link.failed_attempts >= MAX_OTP_ATTEMPTS) return null;

  // Confronto a tempo costante: `!==` esce al primo carattere diverso,
  // permettendo di dedurre quante cifre si sono indovinate misurando il
  // tempo di risposta (timing attack). Gli OTP sono sempre 6 cifre, quindi
  // sha256 dei due valori ha lunghezza identica per timingSafeEqual.
  const a = crypto.createHash("sha256").update(String(link.otp)).digest();
  const b = crypto.createHash("sha256").update(String(otp)).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    // Incremento ATOMICO con tetto: prima il check-then-increment era una
    // race (due richieste concorrenti leggevano failed_attempts = 4 e
    // superavano entrambe il tetto). L'UPDATE condizionale fallisce quando
    // il contatore ha già raggiunto il massimo, anche sotto concorrenza.
    const incremented = await query(
      "UPDATE magic_links SET failed_attempts = failed_attempts + 1 WHERE id = $1 AND failed_attempts < $2 RETURNING id",
      [link.id, MAX_OTP_ATTEMPTS]
    );
    if (incremented.rows.length === 0) return null;
    return null;
  }

  const result = await query(
    `WITH updated AS (
       UPDATE magic_links SET used_at = NOW()
       WHERE id = $1 AND used_at IS NULL
       RETURNING user_id
     )
     SELECT u.id, u.email, u.name, u.role, u.site_id, u.status, u.token_version
     FROM updated ml
     JOIN users u ON u.id = ml.user_id`,
    [link.id]
  );

  if (result.rows.length === 0) return null;

  const user = result.rows[0];
  if (user.status === "disabled") return { id: user.id, email: user.email, name: user.name, role: user.role, site_id: user.site_id, status: "disabled", token_version: user.token_version };

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    site_id: user.site_id,
    token_version: user.token_version,
  };
}
