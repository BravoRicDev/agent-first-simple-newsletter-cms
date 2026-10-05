import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import http from "node:http";
import { safeFetch } from "../src/services/ssrf.js";

// ───────────────────────────────────────────────────────────────────────────
// TASK C — SSRF DNS rebinding.
//
// safeFetch() validava l'host con dns.lookup e poi lasciava che fetch()
// risolvesse di NUOVO il nome: un server DNS sotto controllo poteva
// rispondere con un IP pubblico al primo giro (quello validato) e con
// 127.0.0.1 al secondo (quello realmente connesso). Il controllo passava,
// la richiesta finiva sull'host interno.
//
// La richiesta ora viene eseguita con node:http/https e un lookup custom
// che restituisce SOLO l'IP già validato, più un controllo di
// socket.remoteAddress al momento del connect.
//
// Nessun DB, nessuna rete: server http locale su 127.0.0.1 + mock di
// dns.promises.lookup.
// ───────────────────────────────────────────────────────────────────────────

let server;
let port;
let hits = 0;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      hits++;
      const body = JSON.stringify({ ok: true, path: req.url, method: req.method });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
}

before(async () => {
  await startServer();
});

after(async () => {
  mock.restoreAll();
  if (server) await new Promise((r) => server.close(r));
});

test("safeFetch con allowPrivate=true verso server locale funziona (regressione)", async () => {
  hits = 0;
  const res = await safeFetch(`http://127.0.0.1:${port}/ok`, { allowPrivate: true });
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.path, "/ok");
  assert.equal(hits, 1);
});

test("safeFetch verso IP privato senza allowPrivate viene rifiutato", async () => {
  hits = 0;
  await assert.rejects(
    () => safeFetch(`http://127.0.0.1:${port}/`),
    /Indirizzo IP non consentito/
  );
  assert.equal(hits, 0);
});

test("DNS rebinding: la connessione NON va a 127.0.0.1 dopo che il resolver è cambiato", async () => {
  hits = 0;
  let callCount = 0;
  // dns.promises.lookup è usato internamente da safeFetch tramite resolvePublicAddress.
  // Mock: primo giro (validazione) restituisce IP pubblico; ogni giro successivo
  // (cioè quello che farebbe fetch() se risolvesse di nuovo) restituisce 127.0.0.1.
  mock.method(dns.promises, "lookup", async () => {
    callCount++;
    if (callCount === 1) {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    return [{ address: "127.0.0.1", family: 4 }];
  });

  // safeFetch deve connettersi SOLO a 93.184.216.34 (non raggiungibile in test).
  // La promise può fallire per timeout/errore di rete: l'importante è che
  // il server locale su 127.0.0.1 non riceva nessuna richiesta.
  await assert.rejects(
    () => safeFetch(`http://rebind.test:${port}/secret`, {
      signal: AbortSignal.timeout(2000),
    }),
    // può essere abort timeout, errore di connessione, o errore SSRF
    () => true
  );

  assert.equal(hits, 0, "il server locale non deve essere raggiunto");
  mock.restoreAll();
});