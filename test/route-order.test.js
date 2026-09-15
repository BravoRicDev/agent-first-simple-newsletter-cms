import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Regressione di un bug reale: il catch-all del sito pubblico
// (publicCatchAllRouter, "/*" in routes/serve.js) risolve QUALUNQUE path come
// pagina del sito e non chiama mai next(). Montato insieme alle altre route
// di serve.js — cioè prima di calls/newsletter/forms — inghiottiva ogni GET
// pubblica registrata dopo: conferma e disiscrizione newsletter, pixel di
// tracciamento aperture, pagina di prenotazione chiamate, tutte ridotte a un
// redirect alla homepage.
//
// Verifica statica sul sorgente invece che sull'app avviata: src/index.js
// chiama start() al caricamento (apre la porta e fa partire lo scheduler),
// quindi non è importabile in un test senza effetti collaterali. Quello che
// conta qui è comunque l'ordine di montaggio, che è testuale.
describe("ordine di montaggio delle route in src/index.js", () => {
  const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

  test("il catch-all del sito pubblico è montato dopo tutti gli altri router", () => {
    const catchAllIndex = source.indexOf("app.use(publicCatchAllRouter)");
    assert.ok(catchAllIndex > 0, "publicCatchAllRouter deve essere montato in index.js");

    const otherMounts = [...source.matchAll(/app\.use\((\w+Routes)\)/g)];
    assert.ok(otherMounts.length > 5, "sanity check: dovrebbero esserci parecchi router montati");

    for (const match of otherMounts) {
      assert.ok(
        match.index < catchAllIndex,
        `${match[1]} è montato DOPO il catch-all pubblico: le sue GET pubbliche verrebbero inghiottite e ridotte a un redirect alla homepage`
      );
    }
  });

  test("il catch-all non è più montato dentro il router serve.js insieme alle route specifiche", () => {
    const serveSource = fs.readFileSync(new URL("../src/routes/serve.js", import.meta.url), "utf8");
    assert.ok(
      !/\brouter\.get\("\/\*"/.test(serveSource),
      'il catch-all "/*" non deve stare sul router principale di serve.js (che viene montato presto), ma sul router dedicato montato per ultimo'
    );
    assert.ok(
      /publicCatchAllRouter\.get\("\/\*"/.test(serveSource),
      "il catch-all deve stare su publicCatchAllRouter"
    );
  });
});
