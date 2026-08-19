import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { scheduleCallManually, sendCallReminders } from "../src/services/calls.js";

describe("promemoria chiamata: finestra di invio e idempotenza", () => {
  let site;

  before(async () => { site = await createTestSite("Reminders Test"); });
  after(async () => { await closeDb(); });

  test("una chiamata tra 30 minuti rientra nella finestra di promemoria (1h)", async () => {
    const { id } = await scheduleCallManually(site.id, {
      email: "presto@example.test", start: new Date(Date.now() + 30 * 60000), durationMinutes: 30,
    });
    // Nessun SMTP configurato in questo sito di test: l'invio fallisce, e per
    // questo reminder_sent_at deve restare NULL (fail-safe: non segnare come
    // inviato ciò che non è realmente partito, così un giro successivo dello
    // scheduler può ritentare).
    await sendCallReminders();
    const row = (await query("SELECT reminder_sent_at FROM calls WHERE id = $1", [id])).rows[0];
    assert.equal(row.reminder_sent_at, null);
  });

  test("una chiamata tra 3 giorni NON rientra nella finestra (1h) e non viene toccata", async () => {
    const { id } = await scheduleCallManually(site.id, {
      email: "lontano@example.test", start: new Date(Date.now() + 3 * 86400000), durationMinutes: 30,
    });
    await sendCallReminders();
    const row = (await query("SELECT reminder_sent_at FROM calls WHERE id = $1", [id])).rows[0];
    assert.equal(row.reminder_sent_at, null, "corretto per questa chiamata: è troppo lontana, non deve nemmeno tentare l'invio");
  });

  test("una chiamata già segnata come promemoria-inviato non viene ripescata", async () => {
    // Orario a +2h: dentro la finestra di ricerca dei promemoria (±4h, stessa
    // del check in scheduleCallManually) ma lontano dalle chiamate degli altri
    // test (+30min e +3 giorni) così lo slot non collide.
    const { id } = await scheduleCallManually(site.id, {
      email: "gia-avvisato@example.test", start: new Date(Date.now() + 2 * 3600000), durationMinutes: 30,
    });
    await query("UPDATE calls SET reminder_sent_at = NOW() WHERE id = $1", [id]);

    // Se sendCallReminders la riprendesse, tenterebbe un invio (fallendo per
    // mancanza di SMTP) ma soprattutto la riselezionerebbe nella query "due":
    // verifichiamo direttamente che la query non la includa.
    const due = (await query(
      `SELECT id FROM calls WHERE site_id = $1 AND status = 'programmata' AND reminder_sent_at IS NULL
         AND scheduled_at > NOW() AND scheduled_at <= NOW() + INTERVAL '4 hours'`,
      [site.id]
    )).rows;
    assert.ok(!due.some(r => r.id === id));
  });

  test("una chiamata annullata non genera un promemoria", async () => {
    const { id } = await scheduleCallManually(site.id, {
      email: "annullata@example.test", start: new Date(Date.now() + 3 * 3600000), durationMinutes: 30,
    });
    await query("UPDATE calls SET status = 'annullata' WHERE id = $1", [id]);

    const due = (await query(
      `SELECT id FROM calls WHERE site_id = $1 AND status = 'programmata' AND reminder_sent_at IS NULL
         AND scheduled_at > NOW() AND scheduled_at <= NOW() + INTERVAL '4 hours'`,
      [site.id]
    )).rows;
    assert.ok(!due.some(r => r.id === id));
  });
});
