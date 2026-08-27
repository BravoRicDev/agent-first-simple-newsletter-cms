import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  validateEmailSyntax,
  isDisposable,
  isRoleAddress,
  checkMx,
  verifySubscriberEmail,
} from "../src/services/email-verify.js";
import { subscribeEmail } from "../src/services/newsletter.js";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";

// Test suite divisa in due parti:
// 1. Test unitari (funzioni di validazione) - non richiedono DB
// 2. Test di integrazione (subscribeEmail + DB) - richiedono DB connesso

let dbAvailable = false;
let site = null;

describe("Igiene lista newsletter (BLOCCO A): validazione e verifica email", { concurrency: 1 }, () => {
  before(async () => {
    try {
      site = await createTestSite("Newsletter Verification Test");
      dbAvailable = true;
    } catch (err) {
      console.log("DB non disponibile - test di integrazione saranno skippati. Errore:", err.message);
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

  // ── validateEmailSyntax ────────────────────────────────────────────────────

  test("validateEmailSyntax: email valida → ok:true", () => {
    const result = validateEmailSyntax("user@example.com");
    assert.equal(result.ok, true);
  });

  test("validateEmailSyntax: email senza @ → bloccata", () => {
    const result = validateEmailSyntax("userexample.com");
    assert.equal(result.ok, false);
  });

  test("validateEmailSyntax: email con due @ → bloccata", () => {
    const result = validateEmailSyntax("user@@example.com");
    assert.equal(result.ok, false);
  });

  test("validateEmailSyntax: email come a@b (dominio senza punto) → bloccata", () => {
    const result = validateEmailSyntax("a@b");
    assert.equal(result.ok, false);
  });

  test("validateEmailSyntax: email con spazi → bloccata", () => {
    const result = validateEmailSyntax("user @example.com");
    assert.equal(result.ok, false);
  });

  test("validateEmailSyntax: email vuota → bloccata", () => {
    const result = validateEmailSyntax("");
    assert.equal(result.ok, false);
  });

  test("validateEmailSyntax: .. consecutivi nel local-part → bloccata", () => {
    const result = validateEmailSyntax("user..name@example.com");
    assert.equal(result.ok, false);
  });

  test("validateEmailSyntax: .. consecutivi nel dominio → bloccata", () => {
    const result = validateEmailSyntax("user@example..com");
    assert.equal(result.ok, false);
  });

  // ── isDisposable ────────────────────────────────────────────────────────────

  test("isDisposable: mailinator.com → true", () => {
    assert.equal(isDisposable("mailinator.com"), true);
  });

  test("isDisposable: guerrillamail.com → true", () => {
    assert.equal(isDisposable("guerrillamail.com"), true);
  });

  test("isDisposable: gmail.com → false", () => {
    assert.equal(isDisposable("gmail.com"), false);
  });

  test("isDisposable: example.com → false", () => {
    assert.equal(isDisposable("example.com"), false);
  });

  // ── isRoleAddress ───────────────────────────────────────────────────────────

  test("isRoleAddress: info → true (role-based)", () => {
    assert.equal(isRoleAddress("info"), true);
  });

  test("isRoleAddress: admin → true (role-based)", () => {
    assert.equal(isRoleAddress("admin"), true);
  });

  test("isRoleAddress: amministrazione → true (role-based)", () => {
    assert.equal(isRoleAddress("amministrazione"), true);
  });

  test("isRoleAddress: john.doe → false (personal)", () => {
    assert.equal(isRoleAddress("john.doe"), false);
  });

  // ── checkMx ─────────────────────────────────────────────────────────────────

  test("checkMx: gmail.com ha record MX → true", async () => {
    const result = await checkMx("gmail.com");
    assert.equal(result, true);
  });

  test("checkMx: dominio inesistente → false", async () => {
    const result = await checkMx("this-domain-does-not-exist-12345.com");
    assert.equal(result, false);
  });

  // ── verifySubscriberEmail orchestrata ───────────────────────────────────────

  test("verifySubscriberEmail: email valida e con MX valido → status:'passed'", async () => {
    const result = await verifySubscriberEmail("user@gmail.com");
    assert.equal(result.status, "passed");
    assert.equal(result.isRole, false);
  });

  test("verifySubscriberEmail: dominio disposable → status:'blocked'", async () => {
    const result = await verifySubscriberEmail("user@mailinator.com");
    assert.equal(result.status, "blocked");
    assert.ok(result.reason.includes("temporaneo"));
  });

  test("verifySubscriberEmail: noreply@azienda.it → status:'blocked'", async () => {
    const result = await verifySubscriberEmail("noreply@azienda.it");
    assert.equal(result.status, "blocked");
    assert.ok(result.reason.includes("no-reply"));
  });

  test("verifySubscriberEmail: no-reply@azienda.it → status:'blocked'", async () => {
    const result = await verifySubscriberEmail("no-reply@azienda.it");
    assert.equal(result.status, "blocked");
  });

  test("verifySubscriberEmail: no_reply@azienda.it → status:'blocked'", async () => {
    const result = await verifySubscriberEmail("no_reply@azienda.it");
    assert.equal(result.status, "blocked");
  });

  test("verifySubscriberEmail: info@azienda.it → status:'role' (non bloccato)", async () => {
    const result = await verifySubscriberEmail("info@gmail.com");
    assert.equal(result.status, "role");
    assert.equal(result.isRole, true);
  });

  test("verifySubscriberEmail: admin@azienda.it → status:'role' (non bloccato)", async () => {
    const result = await verifySubscriberEmail("admin@gmail.com");
    assert.equal(result.status, "role");
    assert.equal(result.isRole, true);
  });

  test("verifySubscriberEmail: sintassi invalida (a@b) → status:'blocked'", async () => {
    const result = await verifySubscriberEmail("a@b");
    assert.equal(result.status, "blocked");
  });

  test("verifySubscriberEmail: dominio senza MX (custom) → status:'blocked'", async () => {
    const result = await verifySubscriberEmail("user@invalid-domain-no-mx-12345.test");
    assert.equal(result.status, "blocked");
    assert.ok(result.reason.includes("MX"));
  });

  // ── subscribeEmail integrazione (richiedono DB) ────────────────────────────

  test("subscribeEmail: email valida → inserted con verification='passed'", async function() {
    const email = "valid@gmail.com";
    if (!dbAvailable) this.skip();
    const result = await subscribeEmail(site.id, email);
    assert.equal(result.blocked, undefined, "non è bloccato");
    assert.equal(result.alreadyConfirmed, false);

    // Verifica che sia stato inserito nel DB con verification corretto.
    const sub = (await query(
      "SELECT verification, verified_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.ok(sub, "subscriber inserito");
    assert.equal(sub.verification, "passed");
    assert.ok(sub.verified_at, "verified_at impostato");
  });

  test("subscribeEmail: email role-based → inserted con verification='role'", async function() {
    if (!dbAvailable) this.skip();
    const email = "info@gmail.com";
    const result = await subscribeEmail(site.id, email);
    assert.equal(result.blocked, undefined);

    const sub = (await query(
      "SELECT verification FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.ok(sub, "subscriber role-based inserito");
    assert.equal(sub.verification, "role");
  });

  test("subscribeEmail: dominio monouso mailinator → blocked, NON inserito", async function() {
    if (!dbAvailable) this.skip();
    const email = "test@mailinator.com";
    const result = await subscribeEmail(site.id, email);
    assert.equal(result.blocked, true);
    assert.ok(result.reason);

    // Verifica che NON sia stato inserito nel DB.
    const sub = (await query(
      "SELECT id FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(sub, undefined, "subscriber NON inserito");
  });

  test("subscribeEmail: noreply prefix → blocked, NON inserito", async function() {
    if (!dbAvailable) this.skip();
    const email = "noreply@company.com";
    // Mock checkMx per questo test (o usa un dominio che non ha MX, come invalid-domain-12345.test).
    const result = await subscribeEmail(site.id, email);
    assert.equal(result.blocked, true);

    const sub = (await query(
      "SELECT id FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(sub, undefined, "subscriber NON inserito");
  });

  test("subscribeEmail: email senza @ → blocked, NON inserito", async function() {
    if (!dbAvailable) this.skip();
    const email = "invalidemail";
    const result = await subscribeEmail(site.id, email);
    assert.equal(result.blocked, true);

    const sub = (await query(
      "SELECT id FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [site.id, email]
    )).rows[0];
    assert.equal(sub, undefined, "subscriber NON inserito");
  });

  test("subscribeEmail: already confirmed subscriber → ignored, returns alreadyConfirmed:true", async function() {
    if (!dbAvailable) this.skip();
    const email = "already@gmail.com";
    // Prima iscrizione.
    await subscribeEmail(site.id, email);
    // Marca come confermato nel DB.
    await query(
      "UPDATE newsletter_subscribers SET status = 'confirmed', confirmed_at = NOW() WHERE site_id = $1 AND email = $2",
      [site.id, email]
    );

    // Secondo tentativo: subscriber già confermato.
    const result = await subscribeEmail(site.id, email);
    assert.equal(result.alreadyConfirmed, true);
  });
});
