import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import {
  validateVerdict, parseJsonContent,
  createRecording, reviewVerdict, weeklyCallMetrics, getRecording,
  callMetricsWeeklyHistory,
} from "../src/services/call-recordings.js";

// Feature: Registrazione + Valutazione Chiamate del Setter.
// - validateVerdict/parseJsonContent: logica pura (whitelist/anti-gaming)
// - createRecording/reviewVerdict/weeklyCallMetrics: flusso DB con scoping sito
describe("call-recordings: valutazione validità chiamate", () => {
  let site, site2, user;

  before(async () => {
    site = await createTestSite("Call Recordings Test");
    site2 = await createTestSite("Call Recordings Altro Sito");
    user = await createTestUser(site.id, "admin");
  });

  after(async () => {
    await closeDb();
  });

  // ── Logica pura: whitelist e anti-gaming ──────────────────────────────
  test("validateVerdict: accetta un verdetto valido 'si'", () => {
    const v = validateVerdict({
      valida: "si",
      motivo_cap_classico: "info_raccolte",
      criteri: {
        apertura_lead: "si",
        info_raccolte: ["problema", "budget"],
        parlato_con_decisore: "si",
        esito_conversazione: "info",
      },
      punteggio: 0.85,
      motivazione: "Il lead ha chiesto prezzi e tempi.",
    });
    assert.equal(v.valida, "si");
    assert.equal(v.motivo_cap_classico, "info_raccolte");
    assert.deepEqual(v.criteri.info_raccolte.sort(), ["budget", "problema"]);
    assert.equal(v.punteggio, 0.85);
  });

  test("validateVerdict: rifiuto secco → valida 'no' anche se il setter ha parlato", () => {
    const v = validateVerdict({
      valida: "no",
      motivo_cap_classico: "rifiuto_secco",
      criteri: { apertura_lead: "no", info_raccolte: [], parlato_con_decisore: "no", esito_conversazione: "rifiuto_secco" },
      punteggio: 0.1,
      motivazione: "Il lead ha detto 'no grazie non mi interessa'.",
    });
    assert.equal(v.valida, "no");
    assert.equal(v.motivo_cap_classico, "rifiuto_secco");
  });

  test("validateVerdict: valori fuori whitelist → ripiegati su 'dubbia'", () => {
    const v = validateVerdict({
      valida: "SI",            // maiuscolo non accettato
      motivo_cap_classico: "non-so", // fuori whitelist
      criteri: { apertura_lead: "forse", info_raccolte: ["hacker"], esito_conversazione: "chissà" },
      punteggio: 999,
      motivazione: "",
    });
    assert.equal(v.valida, "dubbia");       // valore non valido → ripiega
    assert.equal(v.motivo_cap_classico, "vuoto");
    assert.equal(v.punteggio, 1);           // clamp
    assert.equal(v.criteri.apertura_lead, undefined);
  });

  test("validateVerdict: verdetto malformato/assente → 'dubbia' (revisione umana)", () => {
    assert.equal(validateVerdict(null).valida, "dubbia");
    assert.equal(validateVerdict({}).valida, "dubbia");
    assert.equal(validateVerdict("stringa").valida, "dubbia");
  });

  test("parseJsonContent: estrae JSON da risposta con fence e testo attorno", () => {
    const raw = 'Ecco il verdetto:\n```json\n{"valida":"si","punteggio":0.9}\n```\nFine.';
    const p = parseJsonContent(raw);
    assert.equal(p.valida, "si");
    assert.equal(p.punteggio, 0.9);
  });

  // ── Flusso DB con scoping per sito ────────────────────────────────────
  test("createRecording + getRecording: scoping per sito", async () => {
    const rec = await createRecording(site.id, {
      opportunity_id: null,
      contact_email: "lead@test.it",
      contact_name: "Mario",
      setter_name: "Nikola",
      funnel_context: { pipeline_name: "Vivai" },
      audio_path: "calls/finto.mp3",
    });
    assert.ok(rec.id > 0);
    assert.equal(rec.contact_email, "lead@test.it");

    // leggibile dal sito corretto
    const found = await getRecording(site.id, rec.id);
    assert.ok(found);
    assert.equal(found.setter_name, "Nikola");

    // NON leggibile da un altro sito (scoping)
    const other = await getRecording(site2.id, rec.id);
    assert.equal(other, null);
  });

  test("weeklyCallMetrics: conteggia validi, dubbie e non valide", async () => {
    // crea 3 registrazioni valide + 1 no per il sito in questa settimana
    for (let i = 0; i < 3; i++) {
      const rec = await createRecording(site.id, {
        contact_email: `valid${i}@test.it`,
        setter_name: "Nikola",
        audio_path: `calls/v${i}.mp3`,
      });
      await query(
        `UPDATE call_recordings SET verdict = $3::jsonb, review_status='confermato', status='valutato' WHERE id=$1 AND site_id=$2`,
        [rec.id, site.id, JSON.stringify({ valida: "si", punteggio: 0.9 })]
      );
    }
    const noRec = await createRecording(site.id, {
      contact_email: "no@test.it", setter_name: "Nikola", audio_path: "calls/no.mp3",
    });
    await query(
      `UPDATE call_recordings SET verdict=$3::jsonb, review_status='confermato', status='valutato' WHERE id=$1 AND site_id=$2`,
      [noRec.id, site.id, JSON.stringify({ valida: "no", punteggio: 0.1 })]
    );

    const report = await weeklyCallMetrics(site.id, { from: new Date(Date.now() - 86400000) });
    assert.ok(report.validi >= 3);
    assert.ok(report.non_valide >= 1);
    assert.ok(report.totale >= 4);
    // tasso di validità: ~3/4 = 75%
    assert.ok(report.tasso_validita > 0 && report.tasso_validita <= 100);
  });

  test("weeklyCallMetrics: conta solo i validi non scartati come intervista valida", async () => {
    const report = await weeklyCallMetrics(site.id, { from: new Date(Date.now() - 86400000) });
    assert.ok(report.validi >= 0);
    assert.ok(report.dubbie >= 0);
    assert.ok(report.non_valide >= 1);
  });

  test("callMetricsWeeklyHistory: ritorna una serie di settimane", async () => {
    const history = await callMetricsWeeklyHistory(site.id, { weeks: 4 });
    assert.ok(Array.isArray(history));
    assert.equal(history.length, 4);
    // ogni settimana ha i campi delle metriche
    for (const w of history) {
      assert.ok(typeof w.validi === "number");
      assert.ok(typeof w.tasso_validita === "number");
      assert.ok(typeof w.from === "string");
    }
  });

  test("reviewVerdict: revisione umana trasforma 'dubbia' → 'si', sincronizza e traccia il revisore (M4)", async () => {
    const rec = await createRecording(site.id, {
      contact_email: "rev@test.it",
      setter_name: "Nikola",
      audio_path: "calls/rev.mp3",
    });
    await query(
      `UPDATE call_recordings SET verdict=$3::jsonb, review_status='revisione', status='valutato' WHERE id=$1 AND site_id=$2`,
      [rec.id, site.id, JSON.stringify({ valida: "dubbia", punteggio: 0.5, motivazione: "Incertezza" })]
    );

    const updated = await reviewVerdict(site.id, rec.id, { valida: "si", reviewStatus: "confermato", authorName: "Mario Rossi" });
    assert.ok(updated);
    assert.equal(updated.verdict.valida, "si");
    assert.equal(updated.verdict.reviewed_by_human, true);
    // M4: identità reale del revisore, non nome fisso
    assert.equal(updated.verdict.reviewed_by, "Mario Rossi");
    assert.equal(updated.review_status, "confermato");
  });
});
