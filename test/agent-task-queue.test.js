import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, closeDb } from "./helpers.js";
import { enqueueTask, retireExhausted, claimTasks, completeTask } from "../src/services/agent-task-queue.js";

// Migrazione pg_advisory_lock -> FOR UPDATE SKIP LOCKED (v2, tick.js):
// verifica diretta della coda `agent_tasks` usata al posto del lock globale
// 72800123. L'invariante da provare è quella richiesta dalla migrazione: due
// claim concorrenti sulla stessa riga non la prendono mai entrambi.
describe("agent-task-queue: coda task per il tick (FOR UPDATE SKIP LOCKED)", () => {
  let site;

  before(async () => {
    site = await createTestSite("Task Queue Test");
  });

  after(async () => { await closeDb(); });

  test("enqueueTask è idempotente per (kind, site_id) mentre pending", async () => {
    await query("DELETE FROM agent_tasks WHERE kind = 'decay' AND site_id = $1", [site.id]);
    await enqueueTask("decay", site.id);
    await enqueueTask("decay", site.id);
    const rows = (await query(
      "SELECT COUNT(*)::int AS n FROM agent_tasks WHERE kind = 'decay' AND site_id = $1 AND status = 'pending'",
      [site.id]
    )).rows[0];
    assert.equal(rows.n, 1, "un solo accodamento pending, il secondo va in ON CONFLICT DO NOTHING");
  });

  test("dopo completeTask, un nuovo enqueueTask crea una nuova riga (non blocca per sempre)", async () => {
    await query("DELETE FROM agent_tasks WHERE kind = 'segment_refresh' AND site_id = $1", [site.id]);
    await enqueueTask("segment_refresh", site.id);
    const [claimed] = await claimTasks("segment_refresh", site.id, 10);
    await completeTask(claimed.id);
    await enqueueTask("segment_refresh", site.id);
    const rows = (await query(
      "SELECT COUNT(*)::int AS n FROM agent_tasks WHERE kind = 'segment_refresh' AND site_id = $1",
      [site.id]
    )).rows[0];
    assert.equal(rows.n, 2, "riga precedente 'done' + nuova riga 'pending'");
  });

  test("claim concorrente sullo STESSO sito: due chiamate parallele non prendono mai la stessa riga", async () => {
    await query("DELETE FROM agent_tasks WHERE kind = 'workflow_delayed' AND site_id = $1", [site.id]);
    await enqueueTask("workflow_delayed", site.id);

    const [claimA, claimB] = await Promise.all([
      claimTasks("workflow_delayed", site.id, 10),
      claimTasks("workflow_delayed", site.id, 10),
    ]);
    const idsA = claimA.map((r) => r.id);
    const idsB = claimB.map((r) => r.id);
    const overlap = idsA.filter((id) => idsB.includes(id));
    assert.equal(overlap.length, 0, "nessuna riga presa da entrambi i claim concorrenti");
    assert.equal(idsA.length + idsB.length, 1, "un solo task era pending per questo sito, preso da uno solo dei due claim");
  });

  test("claim scoped per sito: il task di un sito non viene mai preso dal claim di un altro sito", async () => {
    const otherSite = await createTestSite("Task Queue Test 2");
    await query("DELETE FROM agent_tasks WHERE kind = 'workflow_delayed' AND site_id IN ($1, $2)", [site.id, otherSite.id]);
    await enqueueTask("workflow_delayed", site.id);
    await enqueueTask("workflow_delayed", otherSite.id);

    // Bug corretto in verifica isolata: un claim non scoped per sito poteva
    // prendere il task di un sito diverso da quello del chiamante,
    // sovrascrivendone il risultato (visto in test/onda2-scoring-decay
    // sotto suite completa: due siti in decay nella stessa finestra).
    const claimForSite = await claimTasks("workflow_delayed", site.id, 10);
    assert.equal(claimForSite.length, 1);
    assert.equal(claimForSite[0].site_id, site.id, "il claim scoped su site.id non deve mai restituire il task di otherSite");

    const claimForOtherSite = await claimTasks("workflow_delayed", otherSite.id, 10);
    assert.equal(claimForOtherSite.length, 1);
    assert.equal(claimForOtherSite[0].site_id, otherSite.id);
  });

  test("completeTask con errore marca 'failed' e la riga non viene più riclaim-ata", async () => {
    await query("DELETE FROM agent_tasks WHERE kind = 'decay' AND site_id = $1", [site.id]);
    await enqueueTask("decay", site.id);
    const [claimed] = await claimTasks("decay", site.id, 10);
    await completeTask(claimed.id, { error: "boom" });
    const row = (await query("SELECT status, last_error FROM agent_tasks WHERE id = $1", [claimed.id])).rows[0];
    assert.equal(row.status, "failed");
    assert.equal(row.last_error, "boom");
    const reclaim = await claimTasks("decay", site.id, 10);
    assert.equal(reclaim.find((r) => r.id === claimed.id), undefined, "una riga 'failed' non torna disponibile per il claim");
  });

  test("retireExhausted recupera una riga 'claimed' rimasta orfana oltre la soglia", async () => {
    await query("DELETE FROM agent_tasks WHERE kind = 'decay' AND site_id = $1", [site.id]);
    await enqueueTask("decay", site.id);
    const [claimed] = await claimTasks("decay", site.id, 10);
    // Simula un worker morto: claimed_at "vecchio" oltre la soglia di 10min.
    await query(
      "UPDATE agent_tasks SET claimed_at = NOW() - INTERVAL '11 minutes' WHERE id = $1",
      [claimed.id]
    );
    await retireExhausted();
    const row = (await query("SELECT status FROM agent_tasks WHERE id = $1", [claimed.id])).rows[0];
    assert.equal(row.status, "pending", "riga orfana riportata a pending dal reaper");
  });
});
