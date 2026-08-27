// ─────────────────────────────────────────────────────────────────────────
// Mock del CRM sorgente per i test source-sync: implementa gli endpoint con
// paginazione limit/startAfterId e shape {<key>:[...], meta:{nextPage}}.
// Uso:
//   const mock = await createMockSource(fixture);
//   ... mock.url come base_url nella config ...
//   await mock.close();
// ─────────────────────────────────────────────────────────────────────────

import http from "http";

export function paginateItems(items, params) {
  const limit = Math.min(100, parseInt(params.limit || "100", 10));
  let list = items;
  if (params.startAfterId) {
    const idx = items.findIndex((x) => x.id === params.startAfterId);
    if (idx >= 0) list = items.slice(idx + 1);
  }
  const page = list.slice(0, limit);
  const nextItem = list[limit];
  return { page, nextPage: nextItem ? nextItem.id : null };
}

export function listResponse(key, items, params) {
  const { page, nextPage } = paginateItems(items, params);
  return {
    [key]: page,
    meta: { total: items.length, nextPage },
  };
}

export async function createMockSource(fixture, { onCall } = {}) {
  const calls = [];

  function send(res, key, items, q) {
    const body = listResponse(key, items, q);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://mock");
    const q = Object.fromEntries(u.searchParams.entries());
    const path = u.pathname.replace(/\/+$/, "");
    if (onCall) onCall(path, q);
    calls.push({ path: u.pathname, q });

    const ok = (obj) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // ── liste globali ──
    if (path === "/users") return send(res, "users", fixture.users || [], q);
    // GET /users/search (doc CRM sorgente 2021-07-28): paginazione skip/limit,
    // risposta { users, count } — niente meta/nextPage.
    if (path === "/users/search") {
      const all = fixture.users || [];
      const skip = parseInt(q.skip || "0", 10);
      const limit = parseInt(q.limit || "100", 10);
      return ok({ users: all.slice(skip, skip + limit), count: all.length });
    }
    // GET /locations/{locationId}/customFields (verificato dal vivo,
    // 2026-08-26): UNA chiamata restituisce contact+opportunity insieme,
    // ciascuno con "model". L'endpoint legacy /custom-fields/object-key/*
    // risponde 400 sull'API reale, non va più chiamato.
    const lcf = path.match(/^\/locations\/([^/]+)\/customFields$/);
    if (lcf) {
      const contactFields = (fixture.customFieldsContact || []).map((f) => ({ ...f, model: "contact" }));
      const oppFields = (fixture.customFieldsOpportunity || []).map((f) => ({ ...f, model: "opportunity" }));
      return ok({ customFields: [...contactFields, ...oppFields] });
    }
    // GET /locations/{locationId}/tags (doc CRM sorgente 2021-07-28): la risposta è
    // { tags: [...] } — NESSUN campo color/dateAdded/dateUpdated. locationId
    // è nel path, non in query (il client aggiunge comunque il query param
    // locationId su ogni chiamata, ma l'endpoint lo vuole nel path).
    const ltags = path.match(/^\/locations\/([^/]+)\/tags$/);
    if (ltags) return send(res, "tags", fixture.tags || [], q);
    if (path === "/opportunities/pipelines")
      return ok({ pipelines: fixture.pipelines || [] });
    if (path === "/calendars") return send(res, "calendars", fixture.calendars || [], q);
    if (path === "/contacts") return send(res, "contacts", fixture.contacts || [], q);
    if (path === "/forms") return send(res, "forms", fixture.forms || [], q);
    // GET /forms/submissions (doc CRM sorgente 2021-07-28): risposta
    // { submissions: [...], meta: { total, currentPage, nextPage, prevPage } }.
    // Paginazione per NUMERO DI PAGINA (param "page"), meta.nextPage è il
    // numero della pagina successiva (o null). Il mock onora page/limit.
    if (path === "/forms/submissions") {
      const all = fixture.formSubmissions || [];
      const page = parseInt(q.page || "1", 10);
      const limit = Math.min(100, parseInt(q.limit || "100", 10));
      const start = (page - 1) * limit;
      const pageItems = all.slice(start, start + limit);
      const nextPage = start + limit < all.length ? page + 1 : null;
      return ok({
        submissions: pageItems,
        meta: {
          total: all.length,
          currentPage: page,
          nextPage,
          prevPage: page > 1 ? page - 1 : null,
        },
      });
    }
    // GET /surveys/ (doc CRM sorgente 2021-07-28): { surveys, total }, paginazione
    // skip/limit (limit MAX 50). L'oggetto survey della lista ha id/name/
    // locationId.
    if (path === "/surveys") {
      const all = fixture.surveys || [];
      const skip = parseInt(q.skip || "0", 10);
      const limit = Math.min(50, parseInt(q.limit || "50", 10));
      return ok({ surveys: all.slice(skip, skip + limit), total: all.length });
    }
    // GET /surveys/submissions (doc CRM sorgente 2021-07-28): { submissions, meta },
    // paginazione page/limit (limit MAX 100), meta.nextPage = numero pagina.
    if (path === "/surveys/submissions") {
      const all = fixture.surveySubmissions || [];
      const page = parseInt(q.page || "1", 10);
      const limit = Math.min(100, parseInt(q.limit || "20", 10));
      const start = (page - 1) * limit;
      const pageItems = all.slice(start, start + limit);
      const nextPage = start + limit < all.length ? page + 1 : null;
      return ok({
        submissions: pageItems,
        meta: {
          total: all.length,
          currentPage: page,
          nextPage,
          prevPage: page > 1 ? page - 1 : null,
        },
      });
    }
    if (path === "/campaigns") return send(res, "campaigns", fixture.campaigns || [], q);
    // Email templates (doc CRM sorgente 2021-07-28): GET /emails/builder — il path
    // "/templates" non esiste in questa versione API. La risposta reale non
    // ha wrapper "templates" garantito; il mock lo mantiene così il mapper
    // può esercitare il fallback ?.templates.
    if (path === "/emails/builder") return send(res, "templates", fixture.emailTemplates || [], q);
    if (path === "/invoices") return send(res, "invoices", fixture.invoices || [], q);
    if (path === "/products") return send(res, "products", fixture.products || [], q);
    if (path === "/payments") return send(res, "payments", fixture.payments || [], q);

    // ── per-contatto ──
    const cm = path.match(/^\/contacts\/([^/]+)$/);
    if (cm) {
      const c = (fixture.contacts || []).find((x) => x.id === cm[1]);
      if (!c) {
        res.writeHead(404);
        return res.end("{}");
      }
      return ok({ contact: c });
    }
    const cn = path.match(/^\/contacts\/([^/]+)\/notes$/);
    if (cn) {
      const c = (fixture.contacts || []).find((x) => x.id === cn[1]);
      return ok({ notes: c?.notes || [] });
    }
    const ct = path.match(/^\/contacts\/([^/]+)\/tasks$/);
    if (ct) {
      const c = (fixture.contacts || []).find((x) => x.id === ct[1]);
      return ok({ tasks: c?.tasks || [] });
    }
    const ca = path.match(/^\/contacts\/([^/]+)\/appointments$/);
    if (ca) {
      const c = (fixture.contacts || []).find((x) => x.id === ca[1]);
      return ok({ events: c?.appointments || [] });
    }
    // opportunities search per contatto — doc CRM sorgente 2021-07-28: contact_id/
    // location_id in snake_case (a differenza di /contacts, camelCase).
    if (path === "/opportunities/search") {
      const c = (fixture.contacts || []).find((x) => x.id === q.contact_id);
      const opps = (c?.opportunities || []).map((o) => ({
        ...o,
        contactId: q.contact_id,
      }));
      return ok({ opportunities: opps, meta: { total: opps.length, nextPage: null } });
    }
    // conversazioni per contatto (+messaggi annidati nel fixture)
    // Doc CRM sorgente 2021-07-28 (Search Conversations): GET /conversations/search,
    // risposta { conversations: [...] } (array piatto, non {conversation}).
    if (path === "/conversations/search" && q.contactId) {
      const convs = (fixture.contacts || []).find((x) => x.id === q.contactId)?.conversations || [];
      return ok({ conversations: convs.map(({ messages, ...rest }) => rest) });
    }
    // Doc CRM sorgente 2021-07-28 (Get Messages): risposta
    // { messages: { lastMessageId, nextPage, messages: [...] } }.
    const cvm = path.match(/^\/conversations\/([^/]+)\/messages$/);
    if (cvm) {
      for (const c of fixture.contacts || []) {
        for (const conv of c.conversations || []) {
          if (conv.id === cvm[1]) return ok({ messages: { messages: conv.messages || [] } });
        }
      }
      return ok({ messages: { messages: [] } });
    }

    res.writeHead(404);
    res.end("{}");
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () => new Promise((r) => server.close(r)),
  };
}
