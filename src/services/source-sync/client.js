import { query } from "../../db.js";
import { decryptSecret } from "../crypto.js";
import { logger } from "../logger.js";

// ─────────────────────────────────────────────────────────────────────────
// Client HTTP verso il CRM sorgente (docs/SOURCE_SYNC_PLAN.md §Budget API).
// - Auth: Bearer token decifrato + header Version
// - Throttle: spaziatura minima tra richieste (token-bucket semplificato)
// - Budget giornaliero S4: contatore persistito su source_sync_config;
//   superato il tetto (quota×budget_percent/100) → SourceBudgetError
// - Backoff su 429 rispettando Retry-After
// - SSRF: base_url è validato al save time in admin-import.js + agent-source-sync.js
//   (solo http/https, hostname valido) — client.js assume base_url fidato.
// ─────────────────────────────────────────────────────────────────────────

export class SourceBudgetError extends Error {
  constructor(callsToday, budgetMax) {
    super(`Budget API giornaliero esaurito (${callsToday}/${budgetMax})`);
    this.name = "SourceBudgetError";
    this.budgetExhausted = true;
  }
}

export class SourceHttpError extends Error {
  constructor(status, message, retryAfterMs = null) {
    super(`Sorgente ${status}: ${message}`);
    this.name = "SourceHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const VERSION_HEADER = "2021-07-28";

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export async function loadConfig(siteId) {
  const r = await query("SELECT * FROM source_sync_config WHERE site_id = $1", [siteId]);
  const row = r.rows[0];
  if (!row) return null;
  let token = null;
  if (row.token_enc) {
    try {
      token = decryptSecret(row.token_enc);
    } catch (err) {
      logger.error(`source-sync: decrypt token fallito site ${siteId}: ${err.message}`);
      token = null;
    }
  }
  return { ...row, token };
}

async function consumeBudget(siteId, cfg) {
  const budgetMax = Math.floor((cfg.daily_quota * cfg.budget_percent) / 100);
  // Reset contatore se è cambiato il giorno UTC
  const fresh = await query(
    `UPDATE source_sync_config
       SET calls_count = CASE WHEN calls_date IS DISTINCT FROM ((NOW() AT TIME ZONE 'UTC')::date) THEN 0 ELSE calls_count END + 1,
           calls_date = (NOW() AT TIME ZONE 'UTC')::date
     WHERE site_id = $1
     RETURNING calls_count`,
    [siteId]
  );
  const count = fresh.rows[0]?.calls_count || 0;
  // Incrementa PRIMA del check: se budgetMax=30 e count=29, incrementa a 30 (OK).
  // Prossima richiesta con count=31 fallirà. Comportamento accettabile: permette
  // raggiungimento del tetto, ma blocca appena superato.
  if (count > budgetMax) {
    throw new SourceBudgetError(count, budgetMax);
  }
  return { count, budgetMax };
}

export function createSourceClient(cfg) {
  if (!cfg?.base_url || !cfg?.token) {
    throw new Error("Source sync non configurato (base_url/token mancanti)");
  }
  const base = String(cfg.base_url).replace(/\/+$/, "");
  const minIntervalMs = Math.max(50, Math.floor(1000 / Math.max(1, cfg.throttle_rps || 8)));
  let lastCallAt = 0;

  async function throttle() {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait + Math.floor(Math.random() * 25));
    lastCallAt = Date.now();
  }

  async function request(path, { params = {}, method = "GET", body = null } = {}) {
    await throttle();
    await consumeBudget(cfg.site_id, cfg);

    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    // CRM sorgente (API attuale l'endpoint API del CRM sorgente) richiede locationId su
    // ogni chiamata: lo passiamo come query param camelCase (mai "location_id",
    // rifiutato con 422 "property location_id should not exist").
    if (cfg.location_id) {
      if (!url.searchParams.has("locationId")) url.searchParams.set("locationId", String(cfg.location_id));
    }

    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Version: VERSION_HEADER,
          Accept: "application/json",
          ...(body !== null && body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cfg.location_id ? { "Location-Id": String(cfg.location_id) } : {}),
        },
        body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 429 && attempt <= 5) {
        const retryAfter = parseInt(res.headers.get("retry-after") || "", 10);
        const waitMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : Math.min(30000, 1000 * 2 ** attempt);
        logger.warn(`source-sync: 429 dal sorgente, attesa ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new SourceHttpError(res.status, text.slice(0, 300));
      }
      return res.json();
    }
  }

  async function get(path, params = {}) {
    const data = await request(path, { params });
    if (data?.items) return data.items;
    // Se non c'è 'items', prova a estrarre usando pathToKey (per risposte come {users:[...]})
    const key = pathToKey(path);
    return Array.isArray(data) ? data : (data?.[key] ?? data);
  }

  /**
   * Paginazione generica: limit=100. Tre strategie di cursore, in ordine:
   *
   * 1. options.cursorFrom(lastItem) — quando fornita, il cursore per la
   *    pagina successiva è calcolato dall'ULTIMO elemento della pagina
   *    corrente (query params startAfterId/startAfter). Verificato sulla
   *    doc ufficiale CRM sorgente (2021-07-28) per GET /contacts/: quell'endpoint
   *    NON restituisce alcun campo "meta" (solo { contacts, count }) — il
   *    client deve ricavare il cursore da solo, non leggerlo dalla
   *    risposta. Usare questa strategia per ogni risorsa di cui si è
   *    verificata la doc reale (vedi mappers/contacts.js).
   * 2. meta.startAfterId (+ meta.startAfter) nella risposta — fallback per
   *    endpoint non ancora verificati che potrebbero seguire un formato
   *    "cursore nella risposta" più comune altrove nell'API CRM sorgente v2.
   * 3. meta.nextPage/next_page (URL completo o id nudo) — comportamento
   *    storico di questo client, mantenuto per endpoint non ancora
   *    verificati. ATTENZIONE: su GET /contacts/ questo campo, quando
   *    presente, è risultato essere un NUMERO DI PAGINA (es. "2") non un
   *    cursore — usarlo come startAfterId causava un ciclo infinito
   *    rilevato in produzione. Non usare per risorse verificate: usare (1).
   *
   * Chiama onPage(items) per ogni pagina. Ritorna { fetched, pages }.
   * Loop guard: max 10000 pagine + Set dei cursori visti per rilevare cicli
   * (composito startAfterId+startAfter, non il solo id: un id ripetuto con
   * startAfter diverso NON è un ciclo).
   */
  async function paginate(path, params = {}, onPage, options = {}) {
    const { cursorFrom } = options;
    const MAX_PAGES = 10000;
    const seenCursors = new Set();
    let fetched = 0;
    let pages = 0;
    let cursor = null; // { startAfterId, startAfter? }
    for (;;) {
      if (pages >= MAX_PAGES) {
        logger.warn(`source-sync: paginate raggiunto MAX_PAGES=${MAX_PAGES} per ${path}`);
        break;
      }
      const cursorKey = cursor ? `${cursor.startAfterId}:${cursor.startAfter ?? ""}` : null;
      if (cursorKey && seenCursors.has(cursorKey)) {
        logger.warn(`source-sync: paginate rilevato ciclo (cursor ripetuto: ${cursorKey})`);
        break;
      }
      if (cursorKey) seenCursors.add(cursorKey);

      const pageParams = { ...params, limit: 100 };
      if (cursor) {
        pageParams.startAfterId = cursor.startAfterId;
        if (cursor.startAfter !== undefined && cursor.startAfter !== null) pageParams.startAfter = cursor.startAfter;
      }
      const res = await request(path, { params: pageParams });
      const items = Array.isArray(res) ? res : res?.[pathToKey(path)] || [];
      if (!Array.isArray(items) || items.length === 0) break;
      pages++;
      fetched += items.length;
      if (onPage) await onPage(items);

      // count/meta.total, quando presenti, evitano una chiamata di pagina
      // in più quando sappiamo già di aver preso tutto (GET /contacts/
      // documenta "count" come totale complessivo, non size di pagina).
      const total = Number.isFinite(res?.count) ? res.count : (Number.isFinite(res?.meta?.total) ? res.meta.total : null);
      if (total !== null && fetched >= total) break;

      if (items.length < 100) break; // pagina non piena: non ce n'è un'altra

      if (cursorFrom) {
        const next = cursorFrom(items[items.length - 1]);
        if (!next?.startAfterId) break;
        cursor = next;
        continue;
      }

      const meta = res?.meta || {};
      if (meta.startAfterId) {
        cursor = { startAfterId: meta.startAfterId, startAfter: meta.startAfter };
        continue;
      }

      let next = meta.nextPage || meta.next_page || null;
      if (!next) break;
      if (String(next).includes("startAfterId=")) {
        try {
          next = new URL(next, base).searchParams.get("startAfterId");
        } catch {
          /* id già nudo */
        }
      }
      if (!next) break;
      cursor = { startAfterId: next };
    }
    return { fetched, pages };
  }

  /**
   * Paginazione a offset (skip/limit) per endpoint che non usano cursore —
   * es. GET /users/search (doc CRM sorgente 2021-07-28: skip/limit, risposta
   * { users, count } dove count è il totale complessivo). Chiama onPage
   * per ogni pagina, si ferma quando una pagina torna vuota o quando
   * fetched >= count/meta.total (se presente). Stesso MAX_PAGES guard di
   * paginate() per sicurezza.
   */
  async function paginateOffset(path, params = {}, onPage) {
    const MAX_PAGES = 10000;
    const limit = 100;
    let fetched = 0;
    let pages = 0;
    let skip = 0;
    for (;;) {
      if (pages >= MAX_PAGES) {
        logger.warn(`source-sync: paginateOffset raggiunto MAX_PAGES=${MAX_PAGES} per ${path}`);
        break;
      }
      const res = await request(path, { params: { ...params, limit, skip } });
      const items = Array.isArray(res) ? res : res?.[pathToKey(path)] || [];
      if (!Array.isArray(items) || items.length === 0) break;
      pages++;
      fetched += items.length;
      if (onPage) await onPage(items);

      const total = Number.isFinite(res?.count) ? res.count : (Number.isFinite(res?.meta?.total) ? res.meta.total : null);
      if (total !== null && fetched >= total) break;
      if (items.length < limit) break;

      skip += limit;
    }
    return { fetched, pages };
  }

  // write(): metodo HTTP (POST/PUT/DELETE) con body JSON per il PUSH verso
  // il CRM sorgente (sync bidirezionale). Stesse auth/throttle/budget.
  async function write(method, path, body = {}, params = {}) {
    return request(path, { method, params, body });
  }

  return { get, paginate, paginateOffset, raw: request, write };
}

function pathToKey(path) {
  // "/contacts/" → "contacts"; "/opportunities/search" → "opportunities"
  const clean = path.replace(/^\//, "").replace(/\/+$/, "");
  return clean.split("/")[0];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
