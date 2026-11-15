import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { makePage, noSmtp } from "./ext-helpers.js";
import { query } from "../src/db.js";
import { createRelease, addItems, scheduleRelease } from "../src/services/releases.js";
import { runReleasesDue } from "../src/services/scheduled-releases.js";

const rnd = () => crypto.randomBytes(4).toString("hex");
const stateOf = async (id) => (await query("SELECT status, error FROM releases WHERE id = $1", [id])).rows[0];
const pubOf = async (id) => (await query("SELECT published FROM pages WHERE id = $1", [id])).rows[0].published;

describe("scheduled releases step", () => {
  let site, admin;

  before(async () => {
    noSmtp();
    site = await createTestSite("ScheduledReleases");
    admin = await createTestUser(site.id, "admin");
  });

  after(async () => { await closeDb(); });

  test("due release is executed, future untouched, stalled running marked failed, second run is a no-op", async () => {
    const page = await makePage(site.id, { published: false, title: `DUE-${rnd()}` });
    const due = await createRelease(site.id, { name: `due-${rnd()}` }, admin);
    await addItems(site.id, due.id, [{ page_id: page.id, action: "publish" }], admin);
    // bypass validazione: scheduled_at nel passato
    await query("UPDATE releases SET status = 'scheduled', scheduled_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [due.id]);

    const future = await createRelease(site.id, { name: `future-${rnd()}` }, admin);
    const futurePage = await makePage(site.id, { published: false, title: `FUT-${rnd()}` });
    await addItems(site.id, future.id, [{ page_id: futurePage.id, action: "publish" }], admin);
    await scheduleRelease(site.id, future.id, new Date(Date.now() + 3600_000), admin);

    const stalled = await createRelease(site.id, { name: `stalled-${rnd()}` }, admin);
    await query("UPDATE releases SET status = 'running', updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1", [stalled.id]);

    const first = await runReleasesDue();
    assert.equal(typeof first.due, "number");

    // stato finale nel DB (il tick reale dello scheduler puo' aver processato la riga per primo)
    assert.equal(await pubOf(page.id), true);
    assert.equal((await stateOf(due.id)).status, "done");
    assert.equal((await stateOf(future.id)).status, "scheduled");
    assert.deepEqual(await stateOf(stalled.id), { status: "failed", error: "stalled" });
    assert.equal(await pubOf(futurePage.id), false);

    const second = await runReleasesDue();
    assert.equal(second.error, undefined);
    assert.equal((await stateOf(due.id)).status, "done");
    assert.equal((await stateOf(future.id)).status, "scheduled");
    assert.equal(await pubOf(futurePage.id), false);
  });
});
