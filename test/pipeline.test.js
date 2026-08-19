import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestSite, closeDb } from "./helpers.js";
import { upsertContact, setContactStage, setContactFields, getPipelineBoard } from "../src/services/contacts.js";

describe("pipeline vendite: stadi, valore stimato, board", () => {
  let site;

  before(async () => { site = await createTestSite("Pipeline Test"); });
  after(async () => { await closeDb(); });

  test("un contatto senza stadio finisce nel bucket 'da assegnare'", async () => {
    await upsertContact(site.id, "senza-stadio@example.test");
    const board = await getPipelineBoard(site.id);
    assert.ok(board[""].some(c => c.email === "senza-stadio@example.test"));
  });

  test("spostare un contatto tra stadi lo sposta nel bucket giusto", async () => {
    await upsertContact(site.id, "lead1@example.test");
    await setContactStage(site.id, "lead1@example.test", "lead");

    let board = await getPipelineBoard(site.id);
    assert.ok(board.lead.some(c => c.email === "lead1@example.test"));

    await setContactStage(site.id, "lead1@example.test", "proposta_inviata");
    board = await getPipelineBoard(site.id);
    assert.ok(!board.lead.some(c => c.email === "lead1@example.test"), "non deve più essere in 'lead'");
    assert.ok(board.proposta_inviata.some(c => c.email === "lead1@example.test"));
  });

  test("il valore stimato viene salvato e sommato per stadio", async () => {
    await upsertContact(site.id, "vip1@example.test");
    await setContactFields(site.id, "vip1@example.test", { tags: ["vip"], status: "vinto", notes: "", value_estimate: 1500.5 });
    await upsertContact(site.id, "vip2@example.test");
    await setContactFields(site.id, "vip2@example.test", { tags: [], status: "vinto", notes: "", value_estimate: 500 });

    const board = await getPipelineBoard(site.id);
    const won = board.vinto.filter(c => ["vip1@example.test", "vip2@example.test"].includes(c.email));
    const total = won.reduce((sum, c) => sum + parseFloat(c.value_estimate || 0), 0);
    assert.equal(total, 2000.5);
  });
});
