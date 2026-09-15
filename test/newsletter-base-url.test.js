import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { query } from "../src/db.js";
import { createTestSite, closeDb, uniqueDomain, uniqueEmail } from "./helpers.js";
import { resetSiteTransporter } from "../src/services/email.js";
import config from "../src/config.js";

// Regressione (ago 2026): i link delle email newsletter (conferma doppio
// opt-in, footer campagne, footer sequenze) usavano la variabile GLOBALE
// MAGIC_LINK_BASE_URL invece del dominio canonico del sito. Un iscritto a un
// sito cliente riceveva link con il dominio globale invece del proprio.
// Ora ogni email usa getCanonicalBaseUrl(siteId) -> site_domains.
//
// Il mock intercetta nodemailer.createTransport (CJS, mockabile — mockare il
// namespace ESM di email.js fallisce con "Cannot redefine property"): le
// email vengono "inviate" al transporter finto e l'HTML resta catturato.
describe("newsletter: i link email usano il dominio del sito, non MAGIC_LINK_BASE_URL", () => {
  let site, domain;
  const sent = [];

  before(async () => {
    site = await createTestSite("Newsletter Base URL Test");
    // Simula il caso reale: il sito ha un dominio canonico in site_domains
    // (per un sito cliente) diverso da MAGIC_LINK_BASE_URL.
    domain = uniqueDomain("nlfix");
    await query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [site.id, domain]);
    await query(
      "INSERT INTO newsletter_settings (site_id, smtp_host, from_email, rate_per_hour) VALUES ($1, 'smtp.test', 'noreply@test', 1000)",
      [site.id]
    );
    // Click tracking OFF: injectClickTracking riscrive i link del footer in
    // /newsletter/click/... — per verificare il DOMINIO dei link (il punto
    // del bug) serve il footer non riscritto.
    await query(
      "INSERT INTO site_variables (site_id, key, value) VALUES ($1, 'tracking_email_enabled', '0')",
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

  test("conferma doppio opt-in: URL col dominio del sito (PUNTO 1)", async () => {
    sent.length = 0;
    resetSiteTransporter(site.id);

    const token = `tok-confirm-baseurl-${crypto.randomBytes(4).toString("hex")}`;
    const email = uniqueEmail("iscritto");
    const { sendConfirmationEmail } = await import("../src/services/newsletter.js");
    await sendConfirmationEmail(site.id, email, token);

    assert.equal(sent.length, 1, "sendMail deve essere chiamata una volta");
    const { to, html } = sent[0];
    assert.equal(to, email);

    const expected = `https://${domain}/newsletter/confirm/${token}`;
    assert.ok(html.includes(expected), `l'HTML deve contenere ${expected}`);
    assert.ok(
      !html.includes(config.magicLinkBaseUrl),
      `l'HTML non deve contenere MAGIC_LINK_BASE_URL (${config.magicLinkBaseUrl})`
    );
  });

  test("footer campagna: Disiscriviti e pixel col dominio del sito (PUNTO 2)", async () => {
    sent.length = 0;
    resetSiteTransporter(site.id);

    const camp = (await query(
      `INSERT INTO newsletter_campaigns (site_id, subject, html_content, status)
       VALUES ($1, 'Campagna test', '<p>Ciao</p>', 'sending') RETURNING id`,
      [site.id]
    )).rows[0];

    const email = uniqueEmail("iscritto2");
    const token = `tok-campagna-baseurl-${crypto.randomBytes(4).toString("hex")}`;
    await query(
      `INSERT INTO newsletter_subscribers (site_id, email, status, token, confirmed_at)
       VALUES ($1, $2, 'confirmed', $3, NOW())`,
      [site.id, email, token]
    );

    const { sendCampaignBatch } = await import("../src/services/newsletter.js");
    await sendCampaignBatch();

    // Il mock può ricevere chiamate per altre email residue (stesso DB di
    // test, subscriber/step di altri test sullo stesso sito): cerchiamo la
    // mail che contiene IL NOSTRO token.
    const mine = sent.filter(({ html }) => html.includes(token));
    assert.ok(mine.length >= 1, "almeno una email col nostro token deve essere stata inviata");

    const html = mine[0].html;
    assert.ok(html.includes(`https://${domain}/newsletter/unsubscribe/${token}`), "link Disiscriviti col dominio del sito");
    assert.ok(html.includes(`https://${domain}/newsletter/track/c/${camp.id}/${token}.gif`), "pixel di apertura col dominio del sito");
    assert.ok(!html.includes(config.magicLinkBaseUrl), "footer campagna senza MAGIC_LINK_BASE_URL");
  });

  test("footer sequenza evergreen: Disiscriviti e pixel col dominio del sito (PUNTO 3)", async () => {
    sent.length = 0;
    resetSiteTransporter(site.id);

    const seq = (await query(
      `INSERT INTO newsletter_sequences (site_id, name, active)
       VALUES ($1, 'Sequenza test', true) RETURNING id`,
      [site.id]
    )).rows[0];
    const step = (await query(
      `INSERT INTO newsletter_sequence_steps (sequence_id, step_order, delay_days, subject, html_content)
       VALUES ($1, 1, 0, 'Step 1', '<p>Step</p>') RETURNING id`,
      [seq.id]
    )).rows[0];

    const email = uniqueEmail("iscritto3");
    const token = `tok-sequenza-baseurl-${crypto.randomBytes(4).toString("hex")}`;
    await query(
      `INSERT INTO newsletter_subscribers (site_id, email, status, token, confirmed_at)
       VALUES ($1, $2, 'confirmed', $3, NOW())`,
      [site.id, email, token]
    );

    const { sendSequenceSteps } = await import("../src/services/newsletter.js");
    await sendSequenceSteps();

    // Cerchiamo la mail che contiene IL NOSTRO token (lo stesso subscriber
    // del test 2 è confermato sullo stesso sito e riceve anch'esso lo step).
    const mine = sent.filter(({ html }) => html.includes(token));
    assert.ok(mine.length >= 1, "almeno una email col nostro token deve essere stata inviata");

    const html = mine[0].html;
    assert.ok(html.includes(`https://${domain}/newsletter/unsubscribe/${token}`), "link Disiscriviti col dominio del sito");
    assert.ok(html.includes(`https://${domain}/newsletter/track/s/${step.id}/${token}.gif`), "pixel di apertura col dominio del sito");
    assert.ok(!html.includes(config.magicLinkBaseUrl), "footer sequenza senza MAGIC_LINK_BASE_URL");
  });
});
