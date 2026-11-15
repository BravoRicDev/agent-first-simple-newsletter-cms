import { test, describe } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { jwtExpiryToMs, signSessionToken, setSessionCookie, issueLoginResponse } from "../src/services/session.js";

describe("session service", () => {
  const user = { id: 5, email: "a@b", name: "n", role: "admin", site_id: 1, token_version: 3 };

  test("signSessionToken carries exactly the expected claims", () => {
    const token = signSessionToken(user);
    const claims = jwt.verify(token, config.jwtSecret);
    assert.deepEqual(Object.keys(claims).sort(), ["email", "exp", "iat", "name", "role", "site_id", "sub", "token_version"]);
    assert.equal(claims.sub, 5);
    assert.equal(claims.token_version, 3);
    assert.equal(claims.role, "admin");
  });

  test("jwtExpiryToMs parses units and falls back to 24h", () => {
    assert.equal(jwtExpiryToMs("24h"), 86400000);
    assert.equal(jwtExpiryToMs("7d"), 7 * 86400000);
    assert.equal(jwtExpiryToMs("90m"), 90 * 60000);
    assert.equal(jwtExpiryToMs("600"), 600000);
    assert.equal(jwtExpiryToMs("garbage!"), 86400000);
    assert.equal(jwtExpiryToMs(undefined), 86400000);
  });

  test("setSessionCookie sets the token cookie with safe options", () => {
    const calls = [];
    const res = { cookie: (...args) => calls.push(args) };
    setSessionCookie(res, "tok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "token");
    assert.equal(calls[0][1], "tok");
    assert.equal(calls[0][2].httpOnly, true);
    assert.equal(calls[0][2].sameSite, "lax");
    assert.equal(calls[0][2].path, "/");
  });

  test("issueLoginResponse sets cookie and returns the historic payload", async () => {
    const cookies = [];
    let body = null;
    const res = { cookie: (...a) => cookies.push(a), json: (b) => { body = b; return b; } };
    await issueLoginResponse(res, user, undefined);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0][0], "token");
    assert.deepEqual(body, {
      user: { id: 5, email: "a@b", name: "n", role: "admin", site_id: 1 },
      redirect_to: null,
    });
  });
});
