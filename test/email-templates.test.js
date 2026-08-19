import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueDomain, uniqueEmail } from "./helpers.js";
import { resetSiteTransporter } from "../src/services/email.js";
import { setEmailTemplate, deleteEmailTemplate, listEmailTemplates, EMAIL_TEMPLATE_KINDS } from "../src/services/email-templates.js";
import config from "../src/config.js";

// Livello sito — email_templates (ago 2026): ogni email di sistema del sito
// (conferma newsletter, chiamate, form, deploy, review) può avere subject e
// corpo custom, con placeholder {var}. Senza template → default standard.
// Il mock intercetta nodemailer.createTransport: nessuna email reale parte.
describe("email_templates: override per sito + fix dominio chiamate", () => {
  let site, domain;
  const sent = [];

  before(async () => {
    site = await createTestSite("Email Templates Test");
    domain = uniqueDomain("tpl");
    await query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [site.id, domain]);
    await query(
      "INSERT INTO newsletter_settings (site_id, smtp_host, from_email, rate_per_hour) VALUES ($1, 'smtp.test', 'noreply@test', 1000)",
      [site.id]
    );

    mock.method(nodemailer, "createTransport", () => ({
      sendMail: async (opts) => { sent.push(opts); return { messageId: "mock" }; },
    }));
  });

  after(async () => {
    mock.restoreAll();
    await closeDb();
  });

  test("senza template: conferma newsletter usa il default standard (no override)", async () => {
    sent.length = 0;
    resetSiteTransporter(site.id);

    const token = `tok-tpl-default-${crypto.randomBytes(4).toString("hex")}`;
    const email = uniqueEmail("def");
    const { sendConfirmationEmail } = await import("../src/services/newsletter.js");
    await sendConfirmationEmail(site.id, email, token);

    assert.equal(sent.length, 1, "sendMail chiamata una volta");
    const { subject, html } = sent[0];
    assert.ok(subject.includes("Conferma la tua iscrizione"), `subject default: ${subject}`);
    assert.ok(html.includes(`https://${domain}/newsletter/confirm/${token}`), "URL confirmation uses site domain");
    assert.ok(!html.includes(config.magicLinkBaseUrl), "nessun magicLinkBaseUrl globale");
  });

  test("con template: subject e body custom con placeholder interpolati", async () => {
    sent.length = 0;
    resetSiteTransporter(site.id);

    await setEmailTemplate(site.id, "newsletter_confirm", {
      subject: "Benvenuto su {siteName}, conferma!",
      body_html: "<p>Ciao da {siteName}!</p><a href=\"{confirmUrl}\">CLICCA QUI</a>",
    });

    const token = `tok-tpl-custom-${crypto.randomBytes(4).toString("hex")}`;
    const email = uniqueEmail("custom");
    const { sendConfirmationEmail } = await import("../src/services/newsletter.js");
    await sendConfirmationEmail(site.id, email, token);

    assert.equal(sent.length, 1);
    const { subject, html } = sent[0];
    assert.ok(subject.includes("Benvenuto su"), `subject custom: ${subject}`);
    assert.ok(subject.includes("Email Templates Test"), "placeholder {siteName} nel subject");
    assert.ok(html.includes("Ciao da Email Templates Test!"), "placeholder {siteName} nel body");
    assert.ok(html.includes(`https://${domain}/newsletter/confirm/${token}`), "placeholder {confirmUrl}");
    assert.ok(html.includes("CLICCA QUI"), "body custom usato al posto del default");
  });

  test("listEmailTemplates: kinds con flag configured, rileva l'override", async () => {
    const res = await listEmailTemplates(site.id);
    assert.ok(Array.isArray(res.templates));
    assert.equal(res.kinds.length, EMAIL_TEMPLATE_KINDS.length);
    const confirm = res.kinds.find(k => k.kind === "newsletter_confirm");
    assert.ok(confirm.configured, "newsletter_confirm deve risultare configurato");
    const other = res.kinds.find(k => k.kind === "call_confirmation");
    assert.ok(!other.configured, "call_confirmation deve risultare non configurato");
    assert.equal(res.templates.length, 1, "solo il template impostato");
  });

  test("deleteEmailTemplate: rimuove e torna al default", async () => {
    await deleteEmailTemplate(site.id, "newsletter_confirm");
    const res = await listEmailTemplates(site.id);
    assert.equal(res.templates.length, 0, "nessun template residuo");
    assert.ok(!res.kinds.find(k => k.kind === "newsletter_confirm").configured);

    sent.length = 0;
    resetSiteTransporter(site.id);
    const token = `tok-tpl-back-${crypto.randomBytes(4).toString("hex")}`;
    const email = uniqueEmail("back");
    const { sendConfirmationEmail } = await import("../src/services/newsletter.js");
    await sendConfirmationEmail(site.id, email, token);
    assert.ok(sent[0].subject.includes("Conferma la tua iscrizione"), "dopo delete torna il subject default");
  });

  test("fix calls: il link di annullamento usa il dominio del sito e niente em dash", async () => {
    sent.length = 0;
    resetSiteTransporter(site.id);

    const email = uniqueEmail("call");
    await query(
      `INSERT INTO calls (site_id, email, name, scheduled_at, duration_minutes, status, booking_token, calendar_id)
       VALUES ($1, $2, 'Test Call', NOW() + INTERVAL '30 minutes', 30, 'programmata', $3, NULL)`,
      [site.id, email, `tok-call-${crypto.randomBytes(4).toString("hex")}`]
    );

    const { sendCallReminders } = await import("../src/services/calls.js");
    await sendCallReminders();

    const mine = sent.filter(({ to }) => to === email);
    assert.equal(mine.length, 1, "promemoria inviato al nostro contatto");
    const { subject, html } = mine[0];
    assert.ok(subject.includes("Promemoria"), `subject reminder: ${subject}`);
    assert.ok(!subject.includes("—"), "subject senza em dash");
    assert.ok(html.includes(`https://${domain}/book/cancel/`), "link annullamento col dominio del sito");
    assert.ok(!html.includes(config.magicLinkBaseUrl), "nessun magicLinkBaseUrl globale nelle email chiamate");
    // cleanup: segna il reminder come inviato per non interferire con altri test
    await query("DELETE FROM calls WHERE site_id = $1 AND email = $2", [site.id, email]);
  });
});