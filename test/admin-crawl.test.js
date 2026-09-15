import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import config from "../src/config.js";
import { query } from "../src/db.js";
import { createTestSite, createTestUser, closeDb } from "./helpers.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

describe("Admin frontend runtime crawl", () => {
  let site, user, token, server, serverPort, serverProcess;
  const crawledPages = new Set();
  const pages500 = [];
  const pagesNot200 = [];

  before(async () => {
    // Crea site e superadmin user
    site = await createTestSite("Admin Crawl Test Site");
    user = await createTestUser(site.id, "superadmin");
    console.log(`[setup] Site created: id=${site.id}, domain=${site.domain}`);
    console.log(`[setup] User created: id=${user.id}, email=${user.email}, role=${user.role}`);

    // Firma JWT per la sessione
    const tokenVersion = 1;
    await query("UPDATE users SET token_version = $1 WHERE id = $2", [tokenVersion, user.id]);

    token = jwt.sign(
      { sub: user.id, token_version: tokenVersion, site_id: site.id },
      config.jwtSecret,
      { algorithm: "HS256", expiresIn: "24h" }
    );
    console.log(`[setup] JWT token created (length=${token.length})`);

    // Trova una porta libera
    serverPort = 3997;

    // Avvia il server come processo separato
    return new Promise((resolve, reject) => {
      serverProcess = spawn("node", [join(projectRoot, "src", "index.js")], {
        env: {
          ...process.env,
          PORT: String(serverPort),
          DATABASE_URL: process.env.DATABASE_URL,
          JWT_SECRET: process.env.JWT_SECRET,
          NODE_ENV: "test",
        },
        stdio: ["ignore", "inherit", "inherit"],
      });

      let startupTimeout = setTimeout(() => {
        serverProcess.kill();
        reject(new Error("Server startup timeout (30s)"));
      }, 30000);

      const onError = (err) => {
        clearTimeout(startupTimeout);
        console.error("[server:error]", err.message);
        reject(err);
      };

      serverProcess.on("error", onError);
      serverProcess.on("exit", (code) => {
        if (code !== 0) {
          clearTimeout(startupTimeout);
          reject(new Error(`Server exited with code ${code}`));
        }
      });

      // Aspetta un momento e poi fa health check (TCP only)
      const healthCheck = async () => {
        const net = await import("net");
        console.log("[test] Starting health check...");
        for (let i = 0; i < 30; i++) {
          const connected = await new Promise((resolve) => {
            const socket = net.createConnection({ port: serverPort, host: "127.0.0.1" });
            socket.setTimeout(2000);
            socket.on("connect", () => {
              socket.destroy();
              resolve(true);
            });
            socket.on("error", (err) => {
              socket.destroy();
              console.log(`[test] Health check attempt ${i+1}/30 failed:`, err.code || err.message);
              resolve(false);
            });
            socket.on("timeout", () => {
              socket.destroy();
              console.log(`[test] Health check attempt ${i+1}/30 timeout`);
              resolve(false);
            });
          });
          if (connected) {
            clearTimeout(startupTimeout);
            console.log("[test] Server is ready on port", serverPort);
            return;
          }
          if (i < 29) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
        throw new Error("Server health check failed after 30 attempts");
      };

      healthCheck().then(resolve).catch((err) => {
        clearTimeout(startupTimeout);
        reject(new Error(`${err.message}\nStderr: ${stderr}`));
      });
    });
  });

  after(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise(r => setTimeout(r, 500));
    }
    await closeDb();
  });

  async function fetchPage(path, method = "GET", body = null) {
    const url = `http://127.0.0.1:${serverPort}${path}`;
    const opts = {
      method,
      headers: {
        cookie: `token=${token}`,
        "User-Agent": "AdminCrawl/1.0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    };
    if (body) opts.body = new URLSearchParams(body).toString();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);
      const text = await res.text();
      return { status: res.status, body: text, headers: res.headers };
    } catch (err) {
      console.error(`[fetchPage error] ${path}: ${err.name} ${err.message}`);
      return { status: 0, error: err.message, body: "" };
    }
  }

  function extractLinks(html) {
    const links = new Set();
    const hrefRegex = /href=["']([^"']+)["']/g;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      const href = match[1];
      if (href.startsWith("/admin/") && !href.includes("#")) {
        // Normalizza ?site_id= e rimuovi query string complessa
        const [path, query] = href.split("?");
        links.add(path);
      }
    }
    return links;
  }

  async function crawl(path, maxPages = 40) {
    const queue = [path];
    let crawledCount = 0;

    while (queue.length > 0 && crawledCount < maxPages) {
      const currentPath = queue.shift();

      if (crawledPages.has(currentPath)) continue;
      crawledPages.add(currentPath);
      crawledCount++;

      console.log(`[Crawl ${crawledCount}] GET ${currentPath}`);

      const result = await fetchPage(currentPath);
      const { status, body } = result;

      if (status === 500) {
        pages500.push({ path: currentPath, body });
        console.error(`  ❌ 500 ERROR at ${currentPath}`);
      } else if (status >= 400) {
        pagesNot200.push({ path: currentPath, status });
        console.warn(`  ⚠️  ${status} at ${currentPath}`);
      } else if (status === 0) {
        console.warn(`  ⚠️  Fetch failed: ${result.error} at ${currentPath}`);
        pagesNot200.push({ path: currentPath, error: result.error });
      } else {
        console.log(`  ✓ ${status} ${currentPath}`);
      }

      // Estrai e accoda link
      if (status < 400 && body) {
        const newLinks = extractLinks(body);
        for (const link of newLinks) {
          if (!crawledPages.has(link)) {
            queue.push(link);
          }
        }
      }
    }

    console.log(`\nCrawled ${crawledCount} pages`);
    return { crawledCount, pages500, pagesNot200 };
  }

  test("crawl /admin/dashboard ricorsivamente", async () => {
    const result = await crawl("/admin/dashboard", 40);

    console.log("\n=== CRAWL SUMMARY ===");
    console.log(`Pages crawled: ${result.crawledCount}`);
    console.log(`500 errors found: ${result.pages500.length}`);
    console.log(`Other errors (4xx/5xx/connection): ${result.pagesNot200.length}`);

    if (result.pages500.length > 0) {
      console.log("\n❌ 500 ERRORS:");
      for (const { path, body } of result.pages500) {
        console.log(`\n  Path: ${path}`);
        // Estrai messaggio di errore da Express default error handler (se presente)
        const lines = body.split("\n").slice(0, 5);
        console.log(`  Body (first 5 lines):\n${lines.join("\n")}`);
      }
      assert.fail(`Found ${result.pages500.length} 500 errors during crawl`);
    }

    if (result.pagesNot200.length > 0) {
      console.log("\n⚠️  Non-200 responses:");
      for (const item of result.pagesNot200) {
        if (item.status === 302) {
          console.log(`  ${item.path} → 302 (redirect, may indicate auth issue)`);
        } else if (item.status === 404) {
          console.log(`  ${item.path} → 404 (not found/broken link)`);
        } else {
          console.log(`  ${item.path} → ${item.status || "connection error"}`);
        }
      }
    }

    assert.ok(result.crawledCount > 0, "Should have crawled at least 1 page");
    assert.equal(result.pages500.length, 0, "Should have no 500 errors");
  });

  test("POST /admin/import/config con CSRF token", async () => {
    // Recupera CSRF token dalla pagina GET /admin/import
    const getRes = await fetchPage("/admin/import");
    if (getRes.status === 200) {
      const csrfMatch = getRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : "";

      if (csrfToken) {
        const postRes = await fetchPage("/admin/import/config", "POST", {
          _csrf: csrfToken,
          sourceProvider: "test",
        });

        console.log(`POST /admin/import/config → ${postRes.status}`);
        assert.ok(postRes.status < 500, `Should not return 500, got ${postRes.status}`);
      } else {
        console.log("Could not extract CSRF token from /admin/import");
      }
    } else {
      console.log(`GET /admin/import returned ${getRes.status}, skipping CSRF test`);
    }
  });

  test("POST /admin/import/run?dry_run=on con CSRF token", async () => {
    const getRes = await fetchPage("/admin/import");
    if (getRes.status === 200) {
      const csrfMatch = getRes.body.match(/name="_csrf"\s+value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : "";

      if (csrfToken) {
        const postRes = await fetchPage("/admin/import/run?dry_run=on", "POST", {
          _csrf: csrfToken,
          dry_run: "on",
        });

        console.log(`POST /admin/import/run?dry_run=on → ${postRes.status}`);
        assert.ok(postRes.status < 500, `Should not return 500, got ${postRes.status}`);
      }
    }
  });
});
