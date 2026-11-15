import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { uniqueDomain } from "./helpers.js";
import { createApiToken } from "../src/services/api-tokens.js";

export function noSmtp() { config.smtpHost = ""; }

export async function startApp({ routers = [], before = null, views = false } = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { res.locals.t = (k) => k; res.locals.lang = "en"; next(); });
  if (views) { app.set("view engine", "ejs"); app.set("views", new URL("../views", import.meta.url).pathname); }
  if (before) before(app);
  for (const r of routers) app.use(r);
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { app, server, baseUrl, close: () => { server.closeAllConnections?.(); server.close(); } };
}

export function httpReq(baseUrl, path, { method = "GET", host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const h = { ...headers };
    if (host) h.Host = host;
    let payload = body;
    if (body !== undefined && typeof body !== "string" && !Buffer.isBuffer(body)) {
      payload = JSON.stringify(body);
      if (!h["Content-Type"]) h["Content-Type"] = "application/json";
    }
    if (payload !== undefined) h["Content-Length"] = Buffer.byteLength(payload);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buffer, text: buffer.toString("utf8"), json: () => JSON.parse(buffer.toString("utf8")) });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function addDomain(siteId, domain = uniqueDomain("ext")) {
  await query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [siteId, domain]);
  return domain;
}

export async function sessionCookie(userId) {
  const u = (await query("SELECT id,email,name,role,site_id,token_version FROM users WHERE id = $1", [userId])).rows[0];
  const t = jwt.sign({ sub: u.id, email: u.email, name: u.name, role: u.role, site_id: u.site_id, token_version: u.token_version }, config.jwtSecret, { expiresIn: "1h", algorithm: "HS256" });
  return `token=${t}`;
}

export async function apiToken(userId, scopes = ["read", "write"]) {
  return (await createApiToken(userId, "ext-test", 30, scopes)).token;
}

export async function makeCategory(siteId, name = "Cat", slug = `cat-${crypto.randomBytes(3).toString("hex")}`) {
  return (await query("INSERT INTO categories (site_id, name, slug) VALUES ($1,$2,$3) RETURNING *", [siteId, name, slug])).rows[0];
}

export async function makePage(siteId, o = {}) {
  const r = await query(
    `INSERT INTO pages (site_id,url_path,title,content,layout_mode,published,post_type,category_id,published_at,excerpt)
     VALUES ($1,$2,$3,$4,'wrapped',$5,$6,$7,$8,$9) RETURNING id`,
    [siteId, o.url_path || `/p-${crypto.randomBytes(4).toString("hex")}`, o.title ?? "Title", o.content ?? "<p>body</p>",
     o.published ?? true, o.post_type ?? "page", o.category_id ?? null, o.published_at ?? null, o.excerpt ?? ""]
  );
  const id = r.rows[0].id;
  for (const [k, v] of Object.entries(o.extra || {})) {
    if (!/^[a-z_]+$/.test(k)) throw new Error("bad column " + k);
    await query(`UPDATE pages SET ${k} = $1 WHERE id = $2`, [v, id]);
  }
  return (await query("SELECT * FROM pages WHERE id = $1", [id])).rows[0];
}
