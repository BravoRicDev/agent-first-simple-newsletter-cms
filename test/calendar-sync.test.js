import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Router } from "express";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAgent } from "../src/routes/agent-helpers.js";
import { registerCalendarSyncRoutes } from "../src/routes/agent-calendar-sync.js";

// Feature 37 — Sync calendario bidirezionale (calls ↔ Google Calendar).
// Niente import di agentRouter: il modulo route viene montato su un router
// locale con requireAuth + requireAgent, come prescritto per i moduli
// registrati dal router padre. Nei test non c'è OAuth configurato (la
// tabella oauth_connections potrebbe non esistere nemmeno): syncNow deve
// fallire in modo pulito con { error: 'OAuth non configurato: ...' },
// registrare un log con status 'error' e NON fare nessuna chiamata a Google.
describe("crm: sync calendario bidirezionale", () => {
  let site, user, server, baseUrl, token;

  before(async () => {
    site = await createTestSite("CRM Calendar Sync Test");
    user = await createTestUser(site.id, "admin");
    const created = await createApiToken(user.id, "crm calendar sync", 30);
    token = created.token;

    const r = Router();
    r.use("/api/agent", requireAuth, requireAgent);
    registerCalendarSyncRoutes(r);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { res.locals.t = (k) => k; next(); });
    app.use(r);
    app.use((err, req, res, next) => {
      res.status(500).json({ error: err.message, stack: err.stack });
    });
    await new Promise(resolve => {
      server = app.listen(0, () => { baseUrl = `http://localhost:${server.address().port}`; resolve(); });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const configsUrl = (extra = "") => `${baseUrl}/api/agent/sites/${site.id}/calendar-sync-configs${extra}`;

  function postConfig(body) {
    return fetch(configsUrl(), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("CRUD config: create → list → update → delete → 404", async () => {
    // Create con default (direction both, calendar primary, mapping {}).
    const created = await postConfig({ oauth_connection_id: null });
    assert.equal(created.status, 200);
    const { config } = await created.json();
    assert.ok(config.id, "config creata con id");
    assert.equal(config.site_id, site.id);
    assert.equal(config.direction, "both");
    assert.equal(config.calendar_id, "primary");
    assert.deepEqual(config.mapping, {});
    assert.equal(config.active, true);
    assert.equal(config.oauth_connection_id, null);

    // List: la config è presente.
    const listRes = await fetch(configsUrl(), { headers: auth() });
    assert.equal(listRes.status, 200);
    const { configs } = await listRes.json();
    assert.ok(Array.isArray(configs));
    assert.ok(configs.some(c => c.id === config.id), "config presente nella lista");

    // Update: direzione, calendario, mapping e collegamento OAuth.
    const put = await fetch(configsUrl(`/${config.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        direction: "out",
        calendar_id: "secondario",
        mapping: { call_status_to_event: "busy", event_to_call_status: "programmata" },
        oauth_connection_id: 42,
        active: false,
      }),
    });
    assert.equal(put.status, 200);
    const { config: updated } = await put.json();
    assert.equal(updated.id, config.id, "stessa riga");
    assert.equal(updated.direction, "out");
    assert.equal(updated.calendar_id, "secondario");
    assert.equal(updated.mapping.call_status_to_event, "busy");
    assert.equal(updated.oauth_connection_id, 42);
    assert.equal(updated.active, false);

    // Delete → 200 con id; seconda delete → 404.
    const del = await fetch(configsUrl(`/${config.id}`), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).deleted, config.id);

    const again = await fetch(configsUrl(`/${config.id}`), { method: "DELETE", headers: auth() });
    assert.equal(again.status, 404);

    const rows = (await query(
      "SELECT COUNT(*)::int AS c FROM calendar_sync_configs WHERE id = $1 AND site_id = $2",
      [config.id, site.id]
    )).rows[0];
    assert.equal(rows.c, 0, "riga eliminata dal DB");
  });

  test("syncNow senza connessione OAuth → errore pulito + log status error", async () => {
    // Config senza oauth_connection_id (caso default).
    const created = await postConfig({ direction: "both" });
    const { config } = await created.json();

    const sync = await fetch(configsUrl(`/${config.id}/sync`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(sync.status, 200);
    const body = await sync.json();
    assert.equal(body.error, "OAuth non configurato: collega prima un account Google (feature 36)");

    // Log registrato con status 'error' e lo stesso messaggio.
    const rows = (await query(
      `SELECT direction, kind, count, status, error FROM calendar_sync_log
        WHERE site_id = $1 AND config_id = $2 ORDER BY id DESC LIMIT 1`,
      [site.id, config.id]
    )).rows[0];
    assert.ok(rows, "riga di log registrata");
    assert.equal(rows.status, "error");
    assert.equal(rows.error, "OAuth non configurato: collega prima un account Google (feature 36)");
    assert.equal(rows.count, 0);

    // Config con oauth_connection_id inesistente: stesso fallimento pulito
    // (nessuna connessione attiva → mai nessuna chiamata verso Google).
    const created2 = await postConfig({ direction: "out", oauth_connection_id: 999999 });
    const { config: config2 } = await created2.json();
    const sync2 = await fetch(configsUrl(`/${config2.id}/sync`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(sync2.status, 200);
    assert.equal((await sync2.json()).error, "OAuth non configurato: collega prima un account Google (feature 36)");

    // last_sync_at NON deve essere stato aggiornato (nessun sync andato a buon fine).
    const cfg = (await query(
      "SELECT last_sync_at FROM calendar_sync_configs WHERE id = $1",
      [config2.id]
    )).rows[0];
    assert.equal(cfg.last_sync_at, null);
  });

  test("listLogs: i log dell'errore OAuth sono visibili via API", async () => {
    const created = await postConfig({ direction: "in" });
    const { config } = await created.json();

    // Due sync falliti → due log con status error.
    for (let i = 0; i < 2; i++) {
      const sync = await fetch(configsUrl(`/${config.id}/sync`), {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: "{}",
      });
      assert.equal(sync.status, 200);
      assert.equal((await sync.json()).error, "OAuth non configurato: collega prima un account Google (feature 36)");
    }

    const logRes = await fetch(configsUrl(`/${config.id}/log?limit=10`), { headers: auth() });
    assert.equal(logRes.status, 200);
    const { logs } = await logRes.json();
    assert.ok(Array.isArray(logs));
    const errorLogs = logs.filter(l => l.status === "error"
      && l.error === "OAuth non configurato: collega prima un account Google (feature 36)");
    assert.equal(errorLogs.length, 2, "due log di errore registrati");
    assert.equal(errorLogs[0].direction, "in");
    assert.equal(errorLogs[0].kind, "pull");
    assert.equal(errorLogs[0].count, 0);
  });

  test("direction non valida → 400 (create e update)", async () => {
    const bad = await postConfig({ direction: "sideways" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "Direzione non valida: usare 'both', 'in' o 'out'");

    // Update con direction invalida sulla stessa config valida → 400.
    const created = await postConfig({ direction: "both" });
    const { config } = await created.json();
    const badPut = await fetch(configsUrl(`/${config.id}`), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "laterale" }),
    });
    assert.equal(badPut.status, 400);

    // Il sync con override direction invalido → 400.
    const badSync = await fetch(configsUrl(`/${config.id}/sync`), {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "diagonale" }),
    });
    assert.equal(badSync.status, 400);
  });

  test("config inesistente → 404 (update, delete, sync, log)", async () => {
    const put = await fetch(configsUrl("/999999"), {
      method: "PUT",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "out" }),
    });
    assert.equal(put.status, 404);
    assert.equal((await put.json()).error, "Configurazione non trovata");

    const del = await fetch(configsUrl("/999999"), { method: "DELETE", headers: auth() });
    assert.equal(del.status, 404);

    const sync = await fetch(configsUrl("/999999/sync"), {
      method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(sync.status, 404);

    const log = await fetch(configsUrl("/999999/log"), { headers: auth() });
    assert.equal(log.status, 404);
  });

  test("accesso ad altro sito → 403", async () => {
    const res = await fetch(`${baseUrl}/api/agent/sites/999999/calendar-sync-configs`, { headers: auth() });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "Accesso negato");
  });
});
