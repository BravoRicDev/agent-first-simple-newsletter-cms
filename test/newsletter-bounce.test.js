import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { classifySmtpError, decideBounceAction } from "../src/services/bounce.js";
import { query } from "../src/db.js";
import pool from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";

describe("Bounce handling", () => {
  // Pure tests: classifySmtpError e decideBounceAction non dipendono dal DB.
  describe("classifySmtpError: classificazione errori SMTP", () => {
    test("5xx -> 'hard'", () => {
      const err = { responseCode: 550 };
      assert.equal(classifySmtpError(err), "hard");
    });

    test("552 (message too large) -> 'hard'", () => {
      const err = { responseCode: 552 };
      assert.equal(classifySmtpError(err), "hard");
    });

    test("4xx (400-499) -> 'soft'", () => {
      assert.equal(classifySmtpError({ responseCode: 400 }), "soft");
      assert.equal(classifySmtpError({ responseCode: 450 }), "soft");
      assert.equal(classifySmtpError({ responseCode: 421 }), "soft");
      assert.equal(classifySmtpError({ responseCode: 451 }), "soft");
    });

    test("errore senza responseCode e senza response -> null", () => {
      const err = { message: "Generic error" };
      assert.equal(classifySmtpError(err), null);
    });

    test("errore di connessione (ECONNREFUSED) -> null", () => {
      const err = { code: "ECONNREFUSED", message: "Connection refused" };
      assert.equal(classifySmtpError(err), null);
    });

    test("parsing codice da err.response testuale", () => {
      const err = { response: "550-5.1.1 The email account that you tried to reach does not exist" };
      assert.equal(classifySmtpError(err), "hard");
    });

    test("parsing codice 4xx da err.response", () => {
      const err = { response: "421 Service not available, try again later" };
      assert.equal(classifySmtpError(err), "soft");
    });

    test("risposta senza 3-digit code -> null", () => {
      const err = { response: "Some non-standard error message" };
      assert.equal(classifySmtpError(err), null);
    });
  });

  describe("decideBounceAction: logica pura di decisione", () => {
    test("hard bounce -> suppress con reason='hard_bounce'", () => {
      const action = decideBounceAction("hard", 0);
      assert.deepEqual(action, { action: "suppress", reason: "hard_bounce" });
    });

    test("soft bounce con count=0 -> count_soft", () => {
      const action = decideBounceAction("soft", 0);
      assert.deepEqual(action, { action: "count_soft" });
    });

    test("soft bounce con count=1 -> count_soft", () => {
      const action = decideBounceAction("soft", 1);
      assert.deepEqual(action, { action: "count_soft" });
    });

    test("soft bounce con count=2 (sarà 3° dopo record) -> suppress con reason='too_many_soft'", () => {
      const action = decideBounceAction("soft", 2);
      assert.deepEqual(action, { action: "suppress", reason: "too_many_soft" });
    });

    test("unknown kind -> ignore", () => {
      const action = decideBounceAction("unknown", 0);
      assert.deepEqual(action, { action: "ignore" });
    });
  });

  // Test con DB: creiamo uno subscriber e simuliamo un bounce record.
  // Se il DB non è disponibile, skippiamo.
  let site;
  before(async () => {
    try {
      site = await createTestSite("Bounce Test Site");
    } catch (err) {
      console.log("⊘ DB non raggiungibile: test con DB skippati. Pure tests comunque eseguiti.");
      return;
    }
  });

  after(async () => {
    try {
      await closeDb();
    } catch {
      // ignore
    }
  });

  describe("recordBounce: transazioni DB", () => {
    // Questi test richiedono il DB. Se site è undefined (DB non disponibile), skippiamo.
    test("hard bounce: subscriber passa a status='bounced'", async (t) => {
      if (!site) {
        t.skip();
        return;
      }

      // Crea un subscriber di test.
      const subResult = await query(
        `INSERT INTO newsletter_subscribers (site_id, email, status, token)
         VALUES ($1, $2, 'confirmed', $3) RETURNING id, email, bounce_soft`,
        [site.id, `test-hard-${Date.now()}@example.test`, "testtoken-hard"]
      );
      const subscriber = subResult.rows[0];

      // Simula un hard bounce.
      const { recordBounce } = await import("../src/services/bounce.js");
      await recordBounce(site.id, subscriber, "hard", "550 Mailbox does not exist");

      // Verifica lo stato aggiornato.
      const updated = await query(
        "SELECT id, status, bounce_hard, bounce_soft, suppressed_at, suppression_reason FROM newsletter_subscribers WHERE id = $1",
        [subscriber.id]
      );
      const row = updated.rows[0];
      assert.equal(row.status, "bounced", "status deve diventare 'bounced'");
      assert.equal(row.bounce_hard, 1, "bounce_hard deve essere 1");
      assert.equal(row.bounce_soft, 0, "bounce_soft deve rimanere 0");
      assert.equal(row.suppression_reason, "hard_bounce");
      assert.ok(row.suppressed_at, "suppressed_at deve essere settato");
    });

    test("soft bounce 3 volte: subscriber passa a status='bounced' con suppression_reason='too_many_soft'", async (t) => {
      if (!site) {
        t.skip();
        return;
      }

      // Crea un subscriber.
      const subResult = await query(
        `INSERT INTO newsletter_subscribers (site_id, email, status, token, bounce_soft)
         VALUES ($1, $2, 'confirmed', $3, 2) RETURNING id, email, bounce_soft`,
        [site.id, `test-soft-${Date.now()}@example.test`, "testtoken-soft"]
      );
      const subscriber = subResult.rows[0];
      assert.equal(subscriber.bounce_soft, 2, "setup: bounce_soft iniziale = 2");

      // Simuliamo il 3° soft bounce.
      const { recordBounce } = await import("../src/services/bounce.js");
      await recordBounce(site.id, subscriber, "soft", "421 Temporary server error");

      // Verifica che è stato soppresso.
      const updated = await query(
        "SELECT id, status, bounce_soft, suppression_reason FROM newsletter_subscribers WHERE id = $1",
        [subscriber.id]
      );
      const row = updated.rows[0];
      assert.equal(row.status, "bounced", "status deve diventare 'bounced' dopo 3 soft");
      assert.equal(row.bounce_soft, 3, "bounce_soft deve essere 3");
      assert.equal(row.suppression_reason, "too_many_soft");
    });

    test("evento bounce viene registrato in newsletter_bounces", async (t) => {
      if (!site) {
        t.skip();
        return;
      }

      const email = `test-bounce-log-${Date.now()}@example.test`;
      const subResult = await query(
        `INSERT INTO newsletter_subscribers (site_id, email, status, token)
         VALUES ($1, $2, 'confirmed', $3) RETURNING id`,
        [site.id, email, "testtoken-log"]
      );
      const subscriber = subResult.rows[0];

      const { recordBounce } = await import("../src/services/bounce.js");
      await recordBounce(site.id, subscriber, "hard", "550 User unknown");

      // Verifica che è stato registrato in newsletter_bounces.
      const bounceLog = await query(
        "SELECT id, kind, reason, email FROM newsletter_bounces WHERE subscriber_id = $1 ORDER BY created_at DESC LIMIT 1",
        [subscriber.id]
      );
      const bounce = bounceLog.rows[0];
      assert.ok(bounce, "deve esserci un record in newsletter_bounces");
      assert.equal(bounce.kind, "hard");
      assert.equal(bounce.email, email);
      assert.ok(bounce.reason.includes("550"), "reason deve contenere il codice SMTP");
    });
  });
});
