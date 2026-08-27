import { test, describe } from "node:test";
import assert from "node:assert/strict";
import config from "../src/config.js";
import { checkEncryptionKey, encryptSecret, decryptSecret } from "../src/services/crypto.js";

// checkEncryptionKey: usato al boot (src/index.js) per loggare un warning
// quando ENCRYPTION_KEY manca o è malformata, senza bloccare l'avvio
// dell'app (decisione deliberata — vedi commento in crypto.js). Regression
// per la segnalazione ElenaCorvesi (site 22): la chiave mancante nel
// container faceva fallire silenziosamente il decrypt dei token source-sync,
// scoperto solo a runtime.
describe("services/crypto: checkEncryptionKey", () => {
  const original = config.encryptionKey;
  const restore = () => { config.encryptionKey = original; };

  test("chiave assente -> present:false, valid:false", () => {
    config.encryptionKey = "";
    try {
      assert.deepEqual(checkEncryptionKey(), { present: false, valid: false });
    } finally { restore(); }
  });

  test("chiave hex a 64 caratteri -> present:true, valid:true", () => {
    config.encryptionKey = "a".repeat(64);
    try {
      assert.deepEqual(checkEncryptionKey(), { present: true, valid: true });
    } finally { restore(); }
  });

  test("chiave troppo corta -> present:true, valid:false", () => {
    config.encryptionKey = "tropp0-c0rta";
    try {
      assert.deepEqual(checkEncryptionKey(), { present: true, valid: false });
    } finally { restore(); }
  });

  test("con chiave valida, un round-trip encrypt/decrypt funziona ancora", () => {
    config.encryptionKey = "b".repeat(64);
    try {
      assert.equal(checkEncryptionKey().valid, true);
      const enc = encryptSecret("segreto-di-test");
      assert.equal(decryptSecret(enc), "segreto-di-test");
    } finally { restore(); }
  });
});
