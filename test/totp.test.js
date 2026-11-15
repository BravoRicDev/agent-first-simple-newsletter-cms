import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  base32Encode, base32Decode, generateSecret, hotp, totp, verifyTotp, otpauthUri,
} from "../src/services/totp.js";

const SECRET_ASCII = Buffer.from("12345678901234567890");
const SECRET_B32 = base32Encode(SECRET_ASCII);

describe("totp", () => {
  test("base32 round trip", () => {
    const buf = Buffer.from([0, 1, 2, 127, 128, 254, 255, 42]);
    assert.deepEqual(base32Decode(base32Encode(buf)), buf);
    assert.equal(base32Decode(base32Encode(SECRET_ASCII)).toString(), "12345678901234567890");
  });

  test("base32Encode known vector", () => {
    assert.equal(base32Encode(Buffer.from("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  test("base32Decode rejects invalid chars", () => {
    assert.throws(() => base32Decode("ABC1!"), /invalid base32/);
  });

  test("RFC 4226 HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => {
      assert.equal(hotp(SECRET_ASCII, counter), code);
    });
  });

  test("RFC 6238 SHA1 8-digit vectors", () => {
    const vectors = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) {
      assert.equal(hotp(SECRET_ASCII, Math.floor(t / 30), 8), code);
    }
  });

  test("totp() matches hotp() for the same time", () => {
    const time = 1111111109000;
    assert.equal(totp(SECRET_B32, { time, digits: 8 }), "07081804");
  });

  test("verifyTotp accepts current, previous and next step, rejects +-2", () => {
    const time = 1700000000000;
    const step = Math.floor(time / 1000 / 30);
    const at = (s) => totp(SECRET_B32, { time: s * 30 * 1000 });
    assert.equal(verifyTotp(SECRET_B32, at(step), { time }).ok, true);
    assert.equal(verifyTotp(SECRET_B32, at(step - 1), { time }).ok, true);
    assert.equal(verifyTotp(SECRET_B32, at(step + 1), { time }).ok, true);
    assert.equal(verifyTotp(SECRET_B32, at(step - 2), { time }).ok, false);
    assert.equal(verifyTotp(SECRET_B32, at(step + 2), { time }).ok, false);
  });

  test("verifyTotp returns the matched step", () => {
    const time = 1700000000000;
    const step = Math.floor(time / 1000 / 30);
    const code = totp(SECRET_B32, { time: (step + 1) * 30 * 1000 });
    assert.deepEqual(verifyTotp(SECRET_B32, code, { time }), { ok: true, step: step + 1 });
  });

  test("replay: code of lastStep rejected, later step accepted", () => {
    const time = 1700000000000;
    const step = Math.floor(time / 1000 / 30);
    const codeNow = totp(SECRET_B32, { time });
    assert.equal(verifyTotp(SECRET_B32, codeNow, { time, lastStep: step }).ok, false);
    const codeNext = totp(SECRET_B32, { time: (step + 1) * 30 * 1000 });
    assert.equal(verifyTotp(SECRET_B32, codeNext, { time, lastStep: step }).ok, true);
  });

  test("wrong length and non-digit codes rejected", () => {
    const time = 1700000000000;
    assert.equal(verifyTotp(SECRET_B32, "12345", { time }).ok, false);
    assert.equal(verifyTotp(SECRET_B32, "1234567", { time }).ok, false);
    assert.equal(verifyTotp(SECRET_B32, "12345a", { time }).ok, false);
    assert.equal(verifyTotp(SECRET_B32, undefined, { time }).ok, false);
  });

  test("otpauthUri contains secret, issuer and period", () => {
    const uri = otpauthUri({ issuer: "Serverino", account: "user@example.com", secret: SECRET_B32 });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.ok(uri.includes(`secret=${SECRET_B32}`));
    assert.ok(uri.includes("issuer=Serverino"));
    assert.ok(uri.includes("period=30"));
  });

  test("generateSecret returns 32 base32 chars", () => {
    const s = generateSecret();
    assert.equal(s.length, 32);
    assert.match(s, /^[A-Z2-7]{32}$/);
  });
});
