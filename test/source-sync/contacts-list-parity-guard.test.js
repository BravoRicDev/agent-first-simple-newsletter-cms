import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSyncEquivalentContactsList } from "../../src/routes/api-clone/contacts.js";

// Guardia per la shadow-verifica di GET /contacts.
//
// La shadow-verifica di GET /contacts NON è ancora wireata nel router
// (vedi src/routes/api-clone/contacts.js — commenti in testa alla
// sezione "GET /contacts shadow-verifica"). Motivo principale:
// GHL GET /contacts NON supporta ordinamento ("GET /contacts/ NON
// supporta alcun ordinamento, solo paginazione per id di inserimento"
// — mappers/contacts.js), mentre il clone ordina per c.id DESC per
// cui le pagine NON coincidono → confronto non affidabile.
// Questi test verificano la guardia che determina QUANDO sarebbe
// possibile attivare la shadow-verifica.
//
// Regola: isSyncEquivalentContactsList(req.query) → true SOLO
// quando la richiesta è "pura": limit/startAfterId soli, senza
// query/tag/email/filters/page/sort.

describe("isSyncEquivalentContactsList — guardia per la shadow-verifica di GET /contacts", () => {
  test("forma pura (solo limit + startAfterId) -> true", () => {
    assert.equal(isSyncEquivalentContactsList({ limit: "20", startAfterId: "abc" }), true);
  });

  test("solo limit -> true", () => {
    assert.equal(isSyncEquivalentContactsList({ limit: "5" }), true);
  });

  test("query stringa -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ query: "mario" }), false);
  });

  test("tag -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ tag: "vip" }), false);
  });

  test("email -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ email: "a@b.com" }), false);
  });

  test("array filters non vuoto -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ filters: [{ field: "tag", operator: "eq", value: "vip" }] }), false);
  });

  test("page (paginazione offset) -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ page: "2" }), false);
  });

  test("sort esplicito -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ sort: "dateUpdated" }), false);
  });

  test("sort come array -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ sort: [{ field: "dateUpdated", direction: "desc" }] }), false);
  });

  test("query + sort -> false", () => {
    assert.equal(isSyncEquivalentContactsList({ query: "x", sort: "dateUpdated" }), false);
  });

  test("richiesta vuota (default) -> true", () => {
    assert.equal(isSyncEquivalentContactsList({}), true);
  });

  test("limit massimo + startAfterId -> true", () => {
    assert.equal(isSyncEquivalentContactsList({ limit: "100", startAfterId: "xyz" }), true);
  });

  test("startAfterId solo -> true", () => {
    assert.equal(isSyncEquivalentContactsList({ startAfterId: "abc" }), true);
  });
});
