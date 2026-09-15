import { test } from "node:test";
import assert from "node:assert";

// Funzione pura: determina se un iscritto deve essere considerato ingaggiato.
// sendHistory: array ordinato DESC di booleani (true = aperto, false = non aperto)
// threshold: numero di ultimi invii da controllare (N)
// Ritorna: true se l'iscritto NON va soppresso, false se va soppresso.
//
// Semantica:
// - Se len(history) < threshold → true (storico insufficiente, non sopprimere)
// - Se len(history) >= threshold:
//   - Prendi i primi (ultimi) threshold elementi: history[0:threshold]
//   - Se almeno uno è true (aperto) → true (ingaggiato, non sopprimere)
//   - Se tutti sono false (nessuno aperto) → false (inattivo, sopprimere)
export function isEngaged(sendHistory, threshold) {
  if (threshold <= 0) return true;
  if (sendHistory.length < threshold) return true;

  const recentSends = sendHistory.slice(0, threshold);
  return recentSends.some((opened) => opened === true);
}

test("isEngaged: soglia 0 → sempre true", () => {
  assert.strictEqual(isEngaged([], 0), true);
  assert.strictEqual(isEngaged([false, false], 0), true);
  assert.strictEqual(isEngaged([true], 0), true);
});

test("isEngaged: storico vuoto → true", () => {
  assert.strictEqual(isEngaged([], 5), true);
});

test("isEngaged: storico insufficiente → true", () => {
  assert.strictEqual(isEngaged([false], 5), true);
  assert.strictEqual(isEngaged([false, false, false], 5), true);
  assert.strictEqual(isEngaged([true, false], 5), true);
});

test("isEngaged: esattamente N invii, tutti non aperti → false", () => {
  assert.strictEqual(isEngaged([false, false, false], 3), false);
});

test("isEngaged: esattamente N invii, almeno uno aperto → true", () => {
  assert.strictEqual(isEngaged([true, false, false], 3), true);
  assert.strictEqual(isEngaged([false, true, false], 3), true);
  assert.strictEqual(isEngaged([false, false, true], 3), true);
});

test("isEngaged: più di N invii, ultimi N tutti non aperti → false", () => {
  assert.strictEqual(isEngaged([false, false, false, true, true], 3), false);
});

test("isEngaged: più di N invii, almeno uno nei recenti aperti → true", () => {
  assert.strictEqual(isEngaged([true, false, false, false, false], 3), true);
  assert.strictEqual(isEngaged([false, true, false, false, false], 3), true);
  assert.strictEqual(isEngaged([false, false, true, true, false], 3), true);
});

test("isEngaged: tutti aperti → sempre true", () => {
  assert.strictEqual(isEngaged([true, true, true], 3), true);
  assert.strictEqual(isEngaged([true], 3), true);
});

test("isEngaged: lungo storico, apertura vecchia non conta", () => {
  const longHistory = [false, false, false, false, false, true]; // apertura all'indice 5, fuori dai recenti N=3
  assert.strictEqual(isEngaged(longHistory, 3), false);
});
