import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isSyncEquivalentSearch } from "../../src/routes/api-clone/contacts.js";

// POST /contacts/search accetta filtri arbitrari (query/tag/email/filters/
// page/sort) che il clone applica sui propri dati locali: non c'è modo di
// replicare 1:1 una chiamata a GHL per una ricerca filtrata/ordinata a
// piacere. La shadow-verifica (services/ghl-parity.js) deve scattare SOLO
// quando la richiesta è nella stessa identica forma già usata dal sync
// periodico (mappers/contacts.js) o osservata nel traffico reale (n8n) —
// altrimenti confronteremmo pagine diverse per costruzione, producendo
// mismatch falsi non dovuti a un vero bug.
describe("isSyncEquivalentSearch — guardia per la shadow-verifica di POST /contacts/search", () => {
  // ── Casi POSITIVI (replicabili 1:1) ────────────────────────────────────

  test("forma sync classica (nessun filtro, sort dateUpdated desc) -> true", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateUpdated", direction: "desc" }] }), true);
  });

  test("sort dateUpdated asc -> true", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateUpdated", direction: "asc" }] }), true);
  });

  test("sort dateAdded desc (caso n8n reale: nessun filtro) -> true", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateAdded", direction: "desc" }] }), true);
  });

  test("sort dateAdded asc -> true", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateAdded", direction: "asc" }] }), true);
  });

  test("page=2 con sort dateUpdated desc -> true (pagina 2 legittima)", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 2,
      sort: [{ field: "dateUpdated", direction: "desc" }],
    }), true);
  });

  test("page=83 con sort dateAdded desc (caso n8n reale sniffato) -> true", () => {
    assert.equal(isSyncEquivalentSearch({
      locationId: "loc-test",
      page: 83,
      pageLimit: 100,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), true);
  });

  test("page=1 con sort dateAdded desc -> true", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 1,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), true);
  });

  test("pageLimit non influenza il risultato (replicabile) -> true", () => {
    assert.equal(isSyncEquivalentSearch({
      pageLimit: 100,
      sort: [{ field: "dateUpdated", direction: "desc" }],
    }), true);
  });

  // ── Filtri locali: sempre esclusi ───────────────────────────────────────

  test("con query di testo -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      sort: [{ field: "dateUpdated", direction: "desc" }],
      query: "mario",
    }), false);
  });

  test("con filtro tag -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      sort: [{ field: "dateUpdated", direction: "desc" }],
      tag: "vip",
    }), false);
  });

  test("con filtro email -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      sort: [{ field: "dateUpdated", direction: "desc" }],
      email: "a@b.com",
    }), false);
  });

  test("con array filters non vuoto -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      sort: [{ field: "dateUpdated", direction: "desc" }],
      filters: [{ field: "tag", operator: "eq", value: "vip" }],
    }), false);
  });

  test("con startAfterId -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      sort: [{ field: "dateUpdated", direction: "desc" }],
      startAfterId: "abc",
    }), false);
  });

  // ── Filtri locali + sort/page validi → sempre esclusi ──────────────────

  test("sort dateAdded desc + query -> false (filtri restano esclusi)", () => {
    assert.equal(isSyncEquivalentSearch({
      query: "test",
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("sort dateUpdated asc + page=83 + email -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 83,
      email: "n8n@example.test",
      sort: [{ field: "dateUpdated", direction: "asc" }],
    }), false);
  });

  test("page=2 + filters non vuoto -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 2,
      filters: [{ field: "dateAdded", operator: "gte", value: "2026-01-01" }],
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("page=1 + startAfterId -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 1,
      startAfterId: "cursor-123",
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  // ── Sort non valido ────────────────────────────────────────────────────

  test("senza sort -> false (nessun ordinamento)", () => {
    assert.equal(isSyncEquivalentSearch({}), false);
  });

  test("sort su campo diverso (es. firstName) -> false", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "firstName", direction: "desc" }] }), false);
  });

  test("sort con più di un campo -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      sort: [
        { field: "dateUpdated", direction: "desc" },
        { field: "dateAdded", direction: "asc" },
      ],
    }), false);
  });

  test("sort con direction non valida (es. 'random') -> false", () => {
    assert.equal(isSyncEquivalentSearch({ sort: [{ field: "dateAdded", direction: "random" }] }), false);
  });

  // ── Page non valido ────────────────────────────────────────────────────

  test("page=0 -> false (deve restare escluso)", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 0,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("page negativo (-1) -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: -1,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("page non intero (1.5) -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: 1.5,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("page stringa '83' -> false (deve essere number)", () => {
    assert.equal(isSyncEquivalentSearch({
      page: "83",
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("page NaN -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: NaN,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });

  test("page Infinity -> false", () => {
    assert.equal(isSyncEquivalentSearch({
      page: Infinity,
      sort: [{ field: "dateAdded", direction: "desc" }],
    }), false);
  });
});
