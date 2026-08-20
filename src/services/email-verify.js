import { promises as dns } from "dns";

// Blocklist di domini temporanei/monouso ben noti — aggiornato, efficace contro lo spam monouso.
// Mantiene lista statica per evitare dipendenze esterne. Se il dominio appare qui,
// l'email viene bloccata (indipendentemente da MX/sintassi, è una decisione strategica).
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "tempmail.com",
  "throwawaymail.com",
  "maildrop.cc",
  "guerrillamail.org",
  "sharklasers.com",
  "guerrillamail.de",
  "temp-mail.org",
  "trashmail.com",
  "fakeinbox.com",
  "minutemail.com",
  "temp-mail.io",
  "maildrop.cc",
  "email.ml",
  "throwaway.email",
  "tempmail.net",
  "mailnesia.com",
]);

// Regex per bloccare prefissi di no-reply — case-insensitive.
// Valori bloccati: noreply@, no-reply@, no_reply@, donotreply@, no.reply@.
const NO_REPLY_REGEX = /^(noreply|no[-._]reply|donotreply|do[-._]not[-._]reply)$/i;

// Role address: indirizzi B2B che sono comunque ACCETTATI (non bloccati), ma segnalati come 'role'.
// Questi sono legittimi e vengono usati dai clienti target (info@, admin@, support@, ecc.).
const ROLE_ADDRESSES = new Set([
  "info",
  "admin",
  "amministrazione",
  "support",
  "sales",
  "office",
  "team",
  "hello",
  "contatti",
]);

// RFC 5321/5322 basic: valida sintassi RFC base (non full RFC5322).
// - Esattamente una @
// - Parte locale non vuota, niente spazi
// - Dominio con almeno un punto e TLD non vuoto
// - Niente ".." consecutivi
export function validateEmailSyntax(email) {
  const trimmed = String(email || "").trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: "Email vuota" };
  if (trimmed.length > 255) return { ok: false, reason: "Email troppo lunga (max 255 caratteri)" };

  const atCount = (trimmed.match(/@/g) || []).length;
  if (atCount !== 1) return { ok: false, reason: "Email deve contenere esattamente una @" };

  const [localPart, domain] = trimmed.split("@");
  if (!localPart || localPart.length === 0) return { ok: false, reason: "Parte locale vuota" };
  if (localPart.includes(" ")) return { ok: false, reason: "Parte locale contiene spazi" };
  if (localPart.includes("..")) return { ok: false, reason: "Parte locale contiene .. consecutivi" };

  if (!domain || domain.length === 0) return { ok: false, reason: "Dominio vuoto" };
  if (domain.includes(" ")) return { ok: false, reason: "Dominio contiene spazi" };
  if (domain.includes("..")) return { ok: false, reason: "Dominio contiene .. consecutivi" };

  const dotCount = (domain.match(/\./g) || []).length;
  if (dotCount < 1) return { ok: false, reason: "Dominio deve contenere almeno un punto" };

  const parts = domain.split(".");
  const tld = parts[parts.length - 1];
  if (!tld || tld.length === 0) return { ok: false, reason: "TLD vuoto o mancante" };

  return { ok: true };
}

// Controlla se il dominio è in blocklist (monouso/temporaneo).
export function isDisposable(domain) {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

// Controlla se il local-part è un indirizzo role-based (informativo, NON blocca).
export function isRoleAddress(localPart) {
  return ROLE_ADDRESSES.has(localPart.toLowerCase());
}

// Verifica record MX del dominio via DNS. Ritorna true se esiste almeno un record MX.
// Se DNS fallisce (rete, timeout, dominio inesistente), considera il dominio non valido.
export async function checkMx(domain) {
  try {
    const mxRecords = await dns.resolveMx(domain);
    return Array.isArray(mxRecords) && mxRecords.length > 0;
  } catch {
    // DNS error, ENOTFOUND, timeout, o nessun record MX: considera non valido.
    return false;
  }
}

// Pipeline orchestrata di verifica email.
// Ritorna { status: 'passed'|'role'|'blocked', reason: string, isRole: boolean }
// Sequenza: 1) syntax, 2) disposable, 3) no-reply, 4) role (info), 5) MX.
export async function verifySubscriberEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();

  // 1) Validazione sintattica.
  const syntax = validateEmailSyntax(normalized);
  if (!syntax.ok) {
    return { status: "blocked", reason: syntax.reason, isRole: false };
  }

  const [localPart, domain] = normalized.split("@");

  // 2) Blocklist domini monouso.
  if (isDisposable(domain)) {
    return { status: "blocked", reason: "Dominio temporaneo/monouso", isRole: false };
  }

  // 3) Blocklist prefissi no-reply.
  if (NO_REPLY_REGEX.test(localPart)) {
    return { status: "blocked", reason: "Indirizzo no-reply", isRole: false };
  }

  // 4) Role address (informativo, non blocca — ma segnala).
  const isRole = isRoleAddress(localPart);

  // 5) Verifica MX (async).
  const hasMx = await checkMx(domain);
  if (!hasMx) {
    return { status: "blocked", reason: "Nessun record MX per il dominio", isRole: false };
  }

  // Tutto ok: ritorna passed o role a seconda che sia role-based.
  return { status: isRole ? "role" : "passed", reason: isRole ? "Indirizzo role-based B2B" : "Email valida", isRole };
}
