import crypto from "node:crypto";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function generateSecret(bytes = 20) { return base32Encode(crypto.randomBytes(bytes)); }

export function hotp(secretBuf, counter, digits = 6, algo = "sha1") {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
export function totp(secretB32, { time = Date.now(), step = 30, digits = 6, algo = "sha1" } = {}) {
  return hotp(base32Decode(secretB32), Math.floor(time / 1000 / step), digits, algo);
}
// Ritorna { ok, step }. lastStep: ultimo counter gia' usato (anti-replay): counter <= lastStep rifiutati.
export function verifyTotp(secretB32, code, { time = Date.now(), step = 30, window = 1, digits = 6, lastStep = 0 } = {}) {
  const c = String(code ?? "").replace(/\s/g, "");
  if (!/^\d+$/.test(c) || c.length !== digits) return { ok: false };
  const secret = base32Decode(secretB32);
  const now = Math.floor(time / 1000 / step);
  let found = null;
  for (let i = -window; i <= window; i++) {
    const counter = now + i;
    if (counter <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, counter, digits));
    if (crypto.timingSafeEqual(expected, Buffer.from(c)) && found === null) found = counter; // niente early return: tempo costante
  }
  return found === null ? { ok: false } : { ok: true, step: found };
}
export function otpauthUri({ issuer, account, secret, digits = 6, step = 30 }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${digits}&period=${step}`;
}
