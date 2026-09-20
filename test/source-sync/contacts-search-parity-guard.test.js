import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSyncEquivalentSearch } from "../../src/routes/api-clone/contacts.js";

// POST /contacts/search accetta filtri arbitrari (query/tag/email/filters/
// page/sort) che il clone applica sui propri dati locali: non c'è modo di
// replicare 1:1 una chiamata a GHL per una ricerca filtrata/ordinata a
// piacere. La shadow-verifica (services/ghl-parity.js) deve scattare SOLO
// quando la richiesta è nella stessa identica forma già usata dal sync
// periodico (mappers/contacts.js) — altrimenti confronteremmo pagine diverse
// per costruzione, producendo mismatch falsi non dovuti a un vero bug.
describe("isSyncEquivalentSearch — guardia per la shadow-verifica di POST /contacts/search", () => {
  const base = { sort: [{ field: "dateUpdated", direction: "desc" }] };

  test("forma sync-equivalente (nessun filtro, sort dateUpdated desc) -> true", () => {
    assert.equal(isSyncEquivalentSearch({ ...base }), true);
  });

  test("con query di testo -> false", () => {
    assert.equal(isSyncEquivalentSearch({ ...base, query: "mario" }), false);
  });

  test("con filtro tag -> false", () => {
    assert.equal(isSyncEquivalentSearch({ ...base, tag: "vip" }), false);
  });

  test("con filtro email -> false", () => {
    assert.equal(isSyncEquivalentSearch({ ...base, email: "a@b.com" }), false);
  });

  test("con array filters non vuoto -> false", () => {
    assert.equal(isSyncEquivalentSearch({ ...base, filters: [{ field: "tag", operator: "eq", value: "vip" }] }), false);
  });

  test("con page (paginazione offset) -> false", () => {
    assert.equal(isSyncEquivalentSearch({ ...base, page: 2 }), false);
  });

  test("con startAfterId -> false", () => {
    assert.equal(isSyncEquivalentSearch({ ...base, startAfterId: "abc" }), false);
  });

  test("senza sort -> false (nessun ordinamento esplicito dateUpdated desc)", () => {
    assert.equal(isSyncEquivalentSearch({}), false);
  });

  test("sort su campo diverso da dateUpdated -> false", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateAdded", direction: "desc" }] }), false);
  });

  test("sort dateUpdated ma direction asc -> false", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateUpdated", direction: "asc" }] }), false);
  });

  test("sort con più di un campo -> false", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateUpdated", direction: "desc" }, { field: "dateAdded", direction: "asc" }] }), false);
  });
});
