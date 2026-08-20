import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { subscribeEmail } from "../src/services/newsletter.js";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";

let dbAvailable = false;
let site = null;

describe("Doppio opt-in disattivabile (newsletter_auto_confirm)", { concurrency: 1 }, () => {
  before(async () => {
    try {
      site = await createTestSite("Auto Confirm Test");
      dbAvailable = true;
    } catch (err) {
      console.log("DB non disponibile - test saranno skippati. Errore:", err.message);
      dbAvailable = false;
    }
  });

  after(async () => {
    if (dbAvailable) {
      try {
        await closeDb();
      } catch (err) {
        // Ignore cleanup errors
      }
    }
  });

  // ── Test funzionali con DB ──────────────────────────────────────────────────

  test("subscribeEmail con autoConfirm=false (default): nuovo iscritto → status pending + email di conferma", async function() {
    if (!dbAvailable) this.skip();

    const email = "test-pending@example.com";
    const result = await subscribeEmail(site.id, email, { autoConfirm: false });

    assert.deepEqual(result, { alreadyConfirmed: false });

    const sub = (await query(
      "SELECT status, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];

    assert.equal(sub.status, "pending");
    assert.equal(sub.confirmed_at, null);
  });

  test("subscribeEmail con autoConfirm=true: nuovo iscritto → status confirmed + confirmed_at = NOW()", async function() {
    if (!dbAvailable) this.skip();

    const email = "test-direct@example.com";
    const result = await subscribeEmail(site.id, email, { autoConfirm: true });

    assert.deepEqual(result, { alreadyConfirmed: false });

    const sub = (await query(
      "SELECT status, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];

    assert.equal(sub.status, "confirmed");
    assert.notEqual(sub.confirmed_at, null);
  });

  test("subscribeEmail con autoConfirm=false su pending → aggiorna a pending (re-subscribe con conferma)", async function() {
    if (!dbAvailable) this.skip();

    const email = "test-resubscribe-pending@example.com";

    // Prima iscrizione: pending
    await subscribeEmail(site.id, email, { autoConfirm: false });
    const pending = (await query(
      "SELECT status, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(pending.status, "pending");

    // Re-subscribe con autoConfirm=false
    const result = await subscribeEmail(site.id, email, { autoConfirm: false });
    assert.deepEqual(result, { alreadyConfirmed: false });

    const updated = (await query(
      "SELECT status, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(updated.status, "pending");
    assert.equal(updated.confirmed_at, null);
  });

  test("subscribeEmail con autoConfirm=true su pending → aggiorna a confirmed immediatamente", async function() {
    if (!dbAvailable) this.skip();

    const email = "test-resubscribe-direct@example.com";

    // Prima iscrizione: pending
    await subscribeEmail(site.id, email, { autoConfirm: false });
    const pending = (await query(
      "SELECT status, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(pending.status, "pending");

    // Re-subscribe con autoConfirm=true
    const result = await subscribeEmail(site.id, email, { autoConfirm: true });
    assert.deepEqual(result, { alreadyConfirmed: false });

    const updated = (await query(
      "SELECT status, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(updated.status, "confirmed");
    assert.notEqual(updated.confirmed_at, null);
    assert.equal(updated.unsubscribed_at, null);
  });

  test("subscribeEmail su confirmed (indipendentemente da autoConfirm) → return alreadyConfirmed=true", async function() {
    if (!dbAvailable) this.skip();

    const email = "test-confirmed@example.com";

    // Iscrizione diretta: confirmed
    await subscribeEmail(site.id, email, { autoConfirm: true });

    // Tentativo di re-subscribe con autoConfirm=false
    const result1 = await subscribeEmail(site.id, email, { autoConfirm: false });
    assert.deepEqual(result1, { alreadyConfirmed: true });

    // Tentativo di re-subscribe con autoConfirm=true
    const result2 = await subscribeEmail(site.id, email, { autoConfirm: true });
    assert.deepEqual(result2, { alreadyConfirmed: true });
  });

  test("subscribeEmail con email bloccata (spam/disposable/no-reply) → blocco in entrambi i rami", async function() {
    if (!dbAvailable) this.skip();

    // Disposable domain
    const result1 = await subscribeEmail(site.id, "test@mailinator.com", { autoConfirm: false });
    assert.equal(result1.blocked, true);
    assert.match(result1.reason, /temporaneo|monouso/);

    const result2 = await subscribeEmail(site.id, "test@mailinator.com", { autoConfirm: true });
    assert.equal(result2.blocked, true);
    assert.match(result2.reason, /temporaneo|monouso/);

    // No-reply address
    const result3 = await subscribeEmail(site.id, "noreply@example.com", { autoConfirm: false });
    assert.equal(result3.blocked, true);
    assert.match(result3.reason, /no-reply/);

    const result4 = await subscribeEmail(site.id, "noreply@example.com", { autoConfirm: true });
    assert.equal(result4.blocked, true);
    assert.match(result4.reason, /no-reply/);

    // Nessun insert nel DB
    const count = (await query(
      "SELECT COUNT(*) AS c FROM newsletter_subscribers WHERE email IN ($1, $2) AND site_id = $3",
      ["test@mailinator.com", "noreply@example.com", site.id]
    )).rows[0].c;
    assert.equal(parseInt(count, 10), 0);
  });

  test("subscribeEmail con email valida ma dominio senza MX → blocco in entrambi i rami", async function() {
    if (!dbAvailable) this.skip();

    // Dominio fittizio senza MX (questo sarà bloccato dal checkMx)
    const result1 = await subscribeEmail(site.id, "user@nonexistentdomain123456.test", { autoConfirm: false });
    assert.equal(result1.blocked, true);

    const result2 = await subscribeEmail(site.id, "user@nonexistentdomain123456.test", { autoConfirm: true });
    assert.equal(result2.blocked, true);
  });

  test("subscribeEmail senza opts (default) → autoConfirm=false (doppio opt-in)", async function() {
    if (!dbAvailable) this.skip();

    const email = "test-default@example.com";
    const result = await subscribeEmail(site.id, email);

    assert.deepEqual(result, { alreadyConfirmed: false });

    const sub = (await query(
      "SELECT status, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];

    assert.equal(sub.status, "pending");
    assert.equal(sub.confirmed_at, null);
  });

  test("subscribeEmail su role address (info@, admin@) con autoConfirm=false → pending ma con verification=role", async function() {
    if (!dbAvailable) this.skip();

    const email = "info@example.com";
    const result = await subscribeEmail(site.id, email, { autoConfirm: false });

    assert.deepEqual(result, { alreadyConfirmed: false });

    const sub = (await query(
      "SELECT status, verification, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];

    assert.equal(sub.status, "pending");
    assert.equal(sub.verification, "role");
    assert.equal(sub.confirmed_at, null);
  });

  test("subscribeEmail su role address (admin@) con autoConfirm=true → confirmed ma con verification=role", async function() {
    if (!dbAvailable) this.skip();

    const email = "admin@example.com";
    const result = await subscribeEmail(site.id, email, { autoConfirm: true });

    assert.deepEqual(result, { alreadyConfirmed: false });

    const sub = (await query(
      "SELECT status, verification, confirmed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];

    assert.equal(sub.status, "confirmed");
    assert.equal(sub.verification, "role");
    assert.notEqual(sub.confirmed_at, null);
  });
});
