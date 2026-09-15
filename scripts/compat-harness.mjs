#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// compat-harness — dimostrazione di parità wire-level del layer clone API.
// Fa partire il VERO server (src/index.js) e guida flussi completi da
// integrazione esterna: auth entrambi i dialetti, CRUD core, calendari,
// forms/surveys, campagne, conversazioni SMS, agency, OAuth, webhook OUT.
// Exit code 0 = tutti gli scenari verdi. Vedi docs/API_CLONE_MASTER_PLAN.md §7.2.
//
// Uso:
//   DATABASE_URL='postgres://...' PORT=3999 node scripts/compat-harness.mjs
// ─────────────────────────────────────────────────────────────────────────

import { spawn } from "child_process";
import crypto from "crypto";
import http from "http";

const PORT = parseInt(process.env.HARNESS_PORT || "3999", 10);
const API_DOMAIN = "apicrm.harness.local";
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name} ${detail}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Richiesta HTTP con header Host personalizzato: esercita il VERO routing
// del vhost API dedicato (middleware/api-host.js), non un bypass.
function req(method, path, { host = API_DOMAIN, headers = {}, body = null, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const r = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          Host: host,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (raw) return resolve({ status: res.statusCode, text, headers: res.headers });
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = null;
          }
          resolve({ status: res.statusCode, data, text, headers: res.headers });
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const randHex = (n) => crypto.randomBytes(n).toString("hex");

async function waitForServer(child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await new Promise((resolve, reject) => {
        const rq = http.get(`${BASE}/health`, (res) => {
          res.resume();
          resolve(res.statusCode);
        });
        rq.on("error", reject);
        rq.setTimeout(1500, () => {
          rq.destroy();
          reject(new Error("timeout"));
        });
      });
      if (r === 200) return;
    } catch {
      /* non ancora pronto */
    }
    await sleep(400);
    if (child.exitCode !== null) throw new Error(`server morto con exit ${child.exitCode}`);
  }
  throw new Error("server non pronto entro il timeout");
}

async function main() {
  // ── Setup DB diretto (fuori dal perimetro HTTP): tenant + credenziali ──
  const dbmod = await import("../src/db.js");
  const { query } = dbmod;
  // idempotenza: rimuovi residui di run precedenti
  await query("DELETE FROM sites WHERE api_domain = $1", [API_DOMAIN]);
  const siteDomain = `harness-${randHex(4)}.example.test`;
  const s = await query(
    "INSERT INTO sites (name, domain, api_domain) VALUES ($1,$2,$3) RETURNING id",
    ["Harness Site", siteDomain, API_DOMAIN]
  );
  const siteId = s.rows[0].id;
  const siteKeyRaw = "sitekey_" + randHex(24);
  await query(
    "INSERT INTO site_api_keys (site_id,name,token_hash,token_prefix,active) VALUES ($1,'harness',$2,$3,true)",
    [siteId, sha256(siteKeyRaw), siteKeyRaw.slice(0, 12)]
  );
  const u = await query(
    "INSERT INTO users (site_id,email,name,role,status,token_version) VALUES ($1,$2,'Harness User','admin','active',1) RETURNING id",
    [siteId, `harness-${randHex(3)}@example.test`]
  );
  const userId = u.rows[0].id;
  const agtokRaw = "agtok_" + randHex(32);
  await query(
    "INSERT INTO api_tokens (user_id,name,token_hash,token_prefix,expires_at,scopes) VALUES ($1,'harness',$2,$3,NOW()+interval '1 day',$4)",
    [userId, sha256(agtokRaw), agtokRaw.slice(0, 14), ["read", "write"]]
  );

  // Webhook OUT in formato target verso un catturatore locale
  let captured = [];
  const capServer = http.createServer((rq, rs) => {
    const ch = [];
    rq.on("data", (c) => ch.push(c));
    rq.on("end", () => {
      try {
        captured.push(JSON.parse(Buffer.concat(ch).toString()));
      } catch {
        captured.push({});
      }
      rs.writeHead(200);
      rs.end();
    });
  });
  await new Promise((r) => capServer.listen(0, "127.0.0.1", r));
  const capPort = capServer.address().port;
  await query(
    "INSERT INTO webhooks (site_id,name,direction,url,secret,events,payload_format) VALUES ($1,'harness-out','out',$2,'harnesssecret',$3,'target')",
    [siteId, `http://127.0.0.1:${capPort}/hook`, JSON.stringify(["contact_created", "tag_added"])]
  );

  // ── Avvio del VERO server ───────────────────────────────────────────────
  const child = spawn(process.execPath, ["src/index.js"], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL, PORT: String(PORT) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", () => {});
  await waitForServer(child);

  const H = { Authorization: `Bearer ${siteKeyRaw}` };
  const q = (p, extra = "") => `${p}${p.includes("?") ? "&" : "?"}locationId=${siteId}${extra}`;
  let contactId, oppId, pipelineId;

  console.log("\n== 1. Vhost + health ==");
  {
    const r = await req("GET", "/health");
    check("GET /health sul vhost apicrm → 200 {status}", r.status === 200 && r.data?.status === "ok");
    const other = await req("GET", "/health", { host: siteDomain });
    check("stesso path su dominio NON-API → NON risponde come API", !(other.status === 200 && other.data?.status === "ok"));
  }

  console.log("\n== 2. Auth: dialetto legacy, moderno, errori ==");
  {
    const legacy = await req("GET", "/contacts/", { headers: H }); // NB: Location-Id assente qui
    const legacyWithLoc = await req("GET", `/contacts/`, { headers: { ...H, "Location-Id": String(siteId) } });
    check("legacy: Location-Id header + Bearer sitekey → 200", legacyWithLoc.status === 200);
    check("legacy senza Location-Id → errore", legacy.status >= 400);
    const modern = await req("GET", q("/contacts/"), { headers: { ...H, Version: "2021-07-28" } });
    check("moderno: Bearer + locationId + Version → 200", modern.status === 200);
    const modernNoVer = await req("GET", q("/contacts/"), { headers: H });
    check("moderno senza Version → default supportata → 200", modernNoVer.status === 200);
    const badVer = await req("GET", q("/contacts/"), { headers: { ...H, Version: "1999-01-01" } });
    check("Version non supportata → 400", badVer.status === 400);
    const noAuth = await req("GET", q("/contacts/"));
    check("senza credenziali → 401 {statusCode,message}", noAuth.status === 401 && noAuth.data?.statusCode === 401);
    const nf = await req("GET", q("/endpoint-inesistente"), { headers: H });
    check("path sconosciuto sul vhost → 404 JSON", nf.status === 404 && typeof nf.data?.statusCode === "number");
  }

  console.log("\n== 3. Contacts lifecycle (create→get→put→note→task→tag) ==");
  {
    const email = `lead-${randHex(3)}@example.test`;
    const c = await req("POST", q("/contacts/"), { headers: H, body: { firstName: "Mario", lastName: "Rossi", email, phone: "+393001234567", tags: ["prospect"] } });
    check("POST /contacts → 201 {contact.id uuid}", c.status === 201 && /^[0-9a-f-]{36}$/.test(c.data?.contact?.id || ""));
    check("shape contatto: dateAdded/dateUpdated/locationId", !!c.data.contact.dateAdded && !!c.data.contact.locationId);
    contactId = c.data.contact.id;
    const g = await req("GET", q(`/contacts/${contactId}`), { headers: H });
    check("GET /contacts/{uuid} → 200 stesso id", g.status === 200 && g.data.contact.id === contactId);
    const p = await req("PUT", q(`/contacts/${contactId}`), { headers: H, body: { companyName: "ACME" } });
    check("PUT parziale → 200 companyName", p.status === 200 && p.data.contact.companyName === "ACME");
    const n = await req("POST", q(`/contacts/${contactId}/notes/`), { headers: H, body: { body: "Primo contatto" } });
    check("POST note → 201 {note.body,dateAdded}", n.status === 201 && n.data.note?.body === "Primo contatto");
    const t = await req("POST", q(`/contacts/${contactId}/tasks/`), { headers: H, body: { title: "Chiamare", completed: false } });
    check("POST task → 201 {task.completed:false}", t.status === 201 && t.data.task?.completed === false);
    const tg = await req("GET", q(`/tags/`), { headers: H });
    check("GET /tags (registro) → 200 array", tg.status === 200 && Array.isArray(tg.data?.tags));
  }

  console.log("\n== 4. Opportunities + pipelines ==");
  {
    const pl = await req("POST", q("/pipelines/"), { headers: H, body: { name: "Ventas", stages: [{ name: "Nuovo" }, { name: "Offerta" }] } });
    check("POST /pipelines → 201 stages[{id,name}]", pl.status === 201 && pl.data.pipeline?.stages?.length === 2);
    pipelineId = pl.data.pipeline.id;
    const stageId = pl.data.pipeline.stages[0].id;
    const o = await req("POST", q("/opportunities/"), { headers: H, body: { name: "Deal ACME", contactId, pipelineId, pipelineStageId: stageId, monetaryValue: 5000, status: "open" } });
    check("POST /opportunities → 201 monetaryValue/pipelineStageId", o.status === 201 && o.data.opportunity?.monetaryValue === 5000 && !!o.data.opportunity?.pipelineStageId);
    oppId = o.data.opportunity.id;
    const st = await req("PUT", q(`/opportunities/${oppId}/status`), { headers: H, body: { status: "won" } });
    check("PUT status won → lastStatusChange valorizzato", st.status === 200 && !!st.data.opportunity?.lastStatusChange);
  }

  console.log("\n== 5. Calendars/appointments/free-slots ==");
  {
    const cal = await req("POST", q("/calendars/"), { headers: H, body: { name: "Consulenza" } });
    check("POST /calendars → 201 isActive+slug", cal.status === 201 && cal.data.calendar?.isActive === true && !!cal.data.calendar?.slug);
    const calId = cal.data.calendar.id;
    const fs = await req("GET", q(`/calendars/${calId}/free-slots/`) + `&startDate=2026-09-01&endDate=2026-09-03`, { headers: H });
    check("free-slots → shape per-data slotIntervals", fs.status === 200 && fs.data.slots && Object.values(fs.data.slots).every((d) => Array.isArray(d)));
    const ev = await req("POST", q("/calendars/events/appointments"), { headers: H, body: { calendarId: calId, title: "Call ACME", startTime: "2026-09-02T09:00:00.000Z", endTime: "2026-09-02T09:30:00.000Z", email: `acme-${randHex(2)}@example.test` } });
    check("POST appointment → 201 status confirmed", ev.status === 201 && ["confirmed", "new"].includes(ev.data.event?.status));
  }

  console.log("\n== 6. Forms/Submissions + Surveys ==");
  {
    const f = await req("POST", q("/forms/"), { headers: H, body: { name: "Modulo Lead" } });
    check("POST /forms → 201 {form.id uuid}", f.status === 201 && /^[0-9a-f-]{36}$/.test(f.data?.form?.id || ""));
    const sv = await req("POST", q("/surveys/"), { headers: H, body: { name: "Sondaggio", questions: [{ type: "TEXT", label: "Feedback", required: true }] } });
    check("POST /surveys → 201 con questions[]", sv.status === 201 && sv.data.survey?.questions?.length === 1);
    const sub = await req("POST", q(`/surveys/${sv.data.survey.id}/submissions/`), { headers: H, body: { email: `resp-${randHex(2)}@example.test`, answers: { feedback: "ottimo" } } });
    check("POST submission → 201 answers", sub.status === 201 && !!sub.data.submission?.answers);
  }

  console.log("\n== 7. Campaigns/Templates ==");
  {
    const tpl = await req("POST", q("/templates/"), { headers: H, body: { name: "Newsletter", type: "Email", subject: "Ciao", bodyHtml: "<p>Ciao {{name}}</p>" } });
    check("POST /templates Email → 201 type normalizzato", tpl.status === 201 && tpl.data.template?.type === "Email");
    const camp = await req("POST", q("/campaigns/"), { headers: H, body: { name: "Lancio", subject: "Oggetto", content: "<p>Testo</p>" } });
    check("POST /campaigns → 201 draft", camp.status === 201 && camp.data.campaign?.status === "draft");
    const sched = await req("PUT", q(`/campaigns/${camp.data.campaign.id}/schedule`), { headers: H, body: { scheduledAt: new Date(Date.now() + 86400000).toISOString() } });
    check("PUT schedule → status scheduled+scheduledAt", sched.status === 200 && sched.data.campaign?.status === "scheduled");
  }

  console.log("\n== 8. Conversazioni SMS (provider mock) ==");
  {
    const m = await req("POST", q("/conversations/messages"), { headers: H, body: { type: "SMS", contactId, message: "Ciao dal harness" } });
    check("POST /conversations/messages SMS → 201 outbound", m.status === 201 && m.data.message?.direction === "outbound" && m.data.message?.type === "SMS");
    const list = await req("GET", q("/conversations?type=SMS"), { headers: H });
    const conv = list.data?.conversations?.conversation || [];
    check("lista thread nesting target + unreadCount/starred", list.status === 200 && Array.isArray(conv) && conv.every((x) => "unreadCount" in x && "starred" in x));
  }

  console.log("\n== 9. Agency: locations/users/teams ==");
  {
    const loc = await req("POST", q("/locations/"), { headers: H, body: { name: "Filiale Nord" } });
    check("POST /locations → 201 locationId presente", loc.status === 201 && !!loc.data.location?.locationId);
    const usr = await req("POST", q("/users/"), { headers: H, body: { firstName: "Anna", lastName: "Bianchi", email: `anna-${randHex(2)}@example.test`, roles: ["collaboratore"] } });
    check("POST /users → 201 roles", usr.status === 201 && Array.isArray(usr.data.user?.roles));
    const team = await req("POST", q("/teams/"), { headers: H, body: { name: "Sales", members: [{ userId: usr.data.user.id, role: "member" }] } });
    check("POST /teams con member → 201", team.status === 201 && team.data.team?.members?.length === 1);
  }

  console.log("\n== 10. OAuth provider (authorization code completo) ==");
  {
    const appReg = await req("POST", q("/oauth/apps"), { headers: H, body: { name: "App Esterna", redirectUris: ["https://partner.example/cb"], scopes: ["contacts.readonly"] } });
    check("POST /oauth/apps → clientSecret una tantum", appReg.status === 201 && !!appReg.data.app?.clientSecret);
    const { clientId, clientSecret } = appReg.data.app;
    const dec = await req("POST", "/oauth/authorize/decision", { host: API_DOMAIN, headers: { Authorization: `Bearer ${agtokRaw}` }, body: { client_id: clientId, redirect_uri: "https://partner.example/cb", scope: "contacts.readonly", state: "s1", decision: "approve" }, raw: false });
    // decision fa 302: http.request segue? No, http.request NON segue redirect → status 302 atteso
    const decRaw = dec.status === 302 ? dec : await req("POST", "/oauth/authorize/decision", { headers: { Authorization: `Bearer ${agtokRaw}` }, body: { client_id: clientId, redirect_uri: "https://partner.example/cb", scope: "contacts.readonly", state: "s1", decision: "approve" }, raw: true });
    const loc = decRaw.headers?.location || "";
    const code = new URL(loc, "https://x.example").searchParams.get("code");
    check("decision approve → 302 con code", decRaw.status === 302 && !!code);
    const tokRes = await new Promise((resolve, reject) => {
      const payload = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, client_secret: clientSecret, redirect_uri: "https://partner.example/cb" }).toString();
      const rq = http.request(`${BASE}/oauth/token`, { method: "POST", headers: { Host: API_DOMAIN, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
        const ch = [];
        res.on("data", (c) => ch.push(c));
        res.on("end", () => resolve({ status: res.statusCode, data: (() => { try { return JSON.parse(Buffer.concat(ch).toString()); } catch { return null; } })() }));
      });
      rq.on("error", reject);
      rq.write(payload);
      rq.end();
    });
    check("token exchange → access_token+refresh_token", tokRes.status === 200 && !!tokRes.data?.access_token && !!tokRes.data?.refresh_token);
    const ui = await req("GET", "/oauth/userinfo", { headers: { Authorization: `Bearer ${tokRes.data.access_token}` } });
    check("userinfo con Bearer oat_ → sub/email/locationId", ui.status === 200 && !!ui.data?.sub && !!ui.data?.locationId);
    const refRes = await new Promise((resolve, reject) => {
      const payload = new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokRes.data.refresh_token, client_id: clientId, client_secret: clientSecret }).toString();
      const rq = http.request(`${BASE}/oauth/token`, { method: "POST", headers: { Host: API_DOMAIN, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) } }, (res) => {
        const ch = [];
        res.on("data", (c) => ch.push(c));
        res.on("end", () => resolve({ status: res.statusCode }));
      });
      rq.on("error", reject);
      rq.write(payload);
      rq.end();
    });
    check("refresh_token grant → rotazione 200", refRes.status === 200);
  }

  console.log("\n== 11. Webhook OUT formato target ==");
  {
    // emetti un evento: aggiungi un tag al contatto (trigger tag_added)
    captured = [];
    await req("PUT", q(`/contacts/${contactId}`), { headers: H, body: { tags: ["prospect", "vip"] } });
    // Flush diretto invece di aspettare il tick automatico del server
    // spawnato: la SSRF protection (src/services/ssrf.js) blocca di default
    // qualunque target privato/loopback, quindi il tick REALE del server
    // (nessun allowPrivate, giustamente — è codice di produzione) non
    // consegnerà MAI un webhook verso il capture server locale
    // dell'harness (127.0.0.1) — bug trovato nell'harness stesso, non nel
    // codice di produzione: "Indirizzo IP non consentito: 127.0.0.1" in
    // webhook_deliveries.last_error, l'evento veniva accodato correttamente
    // ma non consegnato mai, e il vecchio attendi-il-tick andava sempre in
    // timeout dopo 70s indipendentemente da qualunque fix applicativo.
    // deliverPending({allowPrivate:true}) è pensato apposta per questo caso
    // (commento in webhooks.js: "SOLO per test con server locali") — lo
    // chiamiamo qui, nel processo dell'harness (stesso DB del server
    // spawnato), invece di introdurre un bypass env-based nel codice di
    // produzione che sarebbe un rischio di sicurezza se mai abilitato per
    // sbaglio in produzione.
    const { deliverPending } = await import("../src/services/webhooks.js");
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !captured.length) {
      await deliverPending(50, { allowPrivate: true });
      if (!captured.length) await sleep(500);
    }
    const hit = captured.find((b) => b.type === "ContactTagAdded" || b.type === "ContactUpdate");
    check("webhook target ricevuto flat {type,eventName,locationId,...}", !!hit && !!hit.type && !!hit.eventName && typeof hit.locationId === "string" && hit.locationId.length > 0);
  }

  // ── Esito ───────────────────────────────────────────────────────────────
  console.log(`\n═══ RISULTATO: ${passed} pass / ${failed} fail ═══`);
  if (failures.length) {
    console.log("Scenari falliti:");
    for (const f of failures) console.log(" - " + f);
  }
  capServer.close();
  child.kill("SIGTERM");
  if (typeof dbmod.closeDb === "function") await dbmod.closeDb().catch(() => {});
  else if (dbmod.pool) await dbmod.pool.end().catch(() => {});
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}

main().catch((err) => {
  console.error("HARNESS ERROR:", err.message);
  process.exit(1);
});
