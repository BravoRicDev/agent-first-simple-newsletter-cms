import crypto from "node:crypto";
import config from "../config.js";

// ─────────────────────────────────────────────────────────────────────────
// Cifratura a riposo dei segreti del registro satelliti (agent_token_enc).
//
// aes-256-gcm con chiave da config.encryptionKey (env ENCRYPTION_KEY):
// 32 byte accettati come hex (64 char) o base64. Il formato cifrato è
// "v1:<iv b64>:<tag b64>:<ciphertext b64>" così un futuro cambio schema
// può convivere con i vecchi valori.
//
// La chiave NON è richiesta all'avvio: encryptSecret la richiede solo
// quando si registra/aggiorna un token, decryptSecret segnala il problema
// senza esporre mai il materiale.
// ─────────────────────────────────────────────────────────────────────────

function loadKey() {
  const raw = String(config.encryptionKey || "").trim();
  if (!raw) {
    const err = new Error("encryption_key_missing");
    err.code = "ENCRYPTION_KEY_MISSING";
    throw err;
  }
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    const err = new Error("encryption_key_invalid");
    err.code = "ENCRYPTION_KEY_INVALID";
    throw err;
  }
  return key;
}

// Controllo non fatale per il boot log (src/index.js): la chiave resta
// opzionale a runtime (vedi sopra), ma un deploy che la perde per errore
// (.env non ricaricato, container ricreato senza env_file aggiornato...)
// deve essere visibile nei log invece di scoprirsi solo quando un sync
// fallisce silenziosamente a decifrare un token.
export function checkEncryptionKey() {
  const raw = String(config.encryptionKey || "").trim();
  if (!raw) return { present: false, valid: false };
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return { present: true, valid: key.length === 32 };
}

export function encryptSecret(plaintext) {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

export function decryptSecret(stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    const err = new Error("decrypt_failed");
    err.code = "DECRYPT_FAILED";
    throw err;
  }
  const key = loadKey();
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
  } catch {
    const err = new Error("decrypt_failed");
    err.code = "DECRYPT_FAILED";
    throw err;
  }
}
