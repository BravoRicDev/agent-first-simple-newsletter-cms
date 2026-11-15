import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ejs from "ejs";
import { closeDb } from "./helpers.js";

// Regressione: views/admin/editorial/index.ejs usava la variabile `query`, che il
// router non passa -> ReferenceError -> 500 su /admin/editorial. Qui ogni vista
// nuova viene compilata e renderizzata con i locali che il router passa davvero.
describe("viste admin nuove: render con i locali del router", () => {
  after(async () => { await closeDb(); });
  const t = (k) => k;
  const base = { t, site: { id: 1, name: "S" }, selectedSiteId: 1, user: { role: "admin", sub: 1 }, csrfToken: "x" };

  test("editorial/index con e senza filtro", async () => {
    const locals = { ...base, items: [], status: "", statuses: ["draft", "in_review", "approved", "rejected"], enabled: true };
    const html = await ejs.renderFile("views/admin/editorial/index.ejs", locals);
    assert.ok(html.length > 100);
    const filtered = await ejs.renderFile("views/admin/editorial/index.ejs", { ...locals, status: "in_review" });
    assert.match(filtered, /selected/);
  });

  test("tutte le viste nuove compilano", () => {
    for (const f of ["views/admin/editorial/index.ejs", "views/admin/releases/index.ejs", "views/admin/releases/show.ejs", "views/admin/security/index.ejs", "views/admin/security/sso.ejs", "views/auth/login.ejs", "views/auth/verify.ejs"]) {
      assert.doesNotThrow(() => ejs.compile(fs.readFileSync(f, "utf8"), { filename: f }), f);
    }
  });
});
