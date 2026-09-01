import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { generateAndSend, verify } from "../src/services/magic-link.js";
import { createApiToken, verifyApiToken } from "../src/services/api-tokens.js";
import { requireAuth } from "../src/middleware/auth.js";

// ─────────────────────────────────────────────────────────────────────────
// Autenticazione AGENTE — due percorsi:
//   1. TOKEN AGENTE longevo (agtok_...) creato dalla pagina /admin/agent:
//      Bearer token, nessun OTP (percorso semplice, consigliato).
//   2. FALLBACK OTP: /api/agent/verify-otp richiede email + token + otp;
//      il SOLO codice OTP (senza il token della magic-link) NON autentica.
// ─────────────────────────────────────────────────────────────────────────

describe("autenticazione agente: token semplice + fallback OTP", () => {
  let site, adminId, adminEmail;

  before(async () => {
    site = await createTestSite("Agent Auth Test");
    const owner = await createTestUser(site.id, "superadmin");
    adminId = owner.id;
    adminEmail = owner.email;
  });

  after(async () => { await closeDb(); });

  test("TOKEN AGENTE (agtok_…): funziona come Bearer via requireAuth → agent:true", async () => {
    const created = await createApiToken(adminId, "Agente Test", 120);
    assert.match(created.token, /^agtok_/, "prefisso agtok_");
    const apiUser = await verifyApiToken(created.token);
    assert.ok(apiUser, "token riconosciuto");
    assert.equal(apiUser.email, adminEmail);
    assert.equal(apiUser.agent, true, "token agente = agente");

    // Integrazione con requireAuth (stessa verifica dei token in /admin/api-tokens).
    const req = { headers: { authorization: `Bearer ${created.token}` }, cookies: {}, path: "/api/agent/me" };
    const res = { locals: {}, status: () => ({ json: () => {} }) };
    let nextCalled = false;
    await requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, "requireAuth accetta il token");
    assert.equal(req.user.agent, true);
  });

  test("FALLBACK OTP: il SOLO codice OTP (senza token) NON autentica", async () => {
    await generateAndSend(adminEmail);
    const row = (await query(
      "SELECT token, otp FROM magic_links ORDER BY id DESC LIMIT 1"
    )).rows[0];
    assert.ok(row, "magic link generata con token+OTP");
    // OTP valido ma con il token SBAGLIATO → null (il token è la seconda
    // chiave del 2FA: le istruzioni vecchie "solo OTP" erano sbagliate).
    const bad = await verify("000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000", row.otp);
    assert.equal(bad, null, "OTP da solo non autentica");
  });

  test("FALLBACK OTP: con email + token + otp → autenticazione valida", async () => {
    await generateAndSend(adminEmail);
    const row = (await query(
      "SELECT token, otp FROM magic_links ORDER BY id DESC LIMIT 1"
    )).rows[0];
    const user = await verify(row.token, row.otp);
    assert.ok(user, "verify(token, otp) valido");
    assert.equal(user.email, adminEmail);
  });
});