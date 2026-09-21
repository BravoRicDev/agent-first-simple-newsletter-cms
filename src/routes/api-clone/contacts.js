import { Router } from "express";
import crypto from "crypto";
import { sendError, sendList, getPaging, requireAnyId, getLocationId, buildMeta } from "./_helpers.js";
import {
  createContact, getContact, updateContact, deleteContact,
  listContacts, searchContacts, upsertContact, findDuplicates,
  getContactNotes, createContactNote, updateContactNote, deleteContactNote,
  getContactTasks, createContactTask, updateContactTask, deleteContactTask,
  getContactFollowers, addContactFollower, removeContactFollower,
  getContactAppointments, getContactEmailVerification,
  addContactTags, removeContactTags,
} from "../../services/contacts-clone.js";
import { recordComparison, isPassthroughActive, compareGhlSubset } from "../../services/ghl-parity.js";
import { logger } from "../../services/logger.js";

const router = Router();

const CONTACTS_SEARCH_PARITY_ENDPOINT = "POST /contacts/search";

// Shadow-verifica fire-and-forget (vedi services/ghl-parity.js), SOLO per la
// forma di richiesta che sappiamo replicare 1:1 contro sorgente.
//
// Ammessi (replicabili 1:1):
//   - sort: array esattamente 1 elemento {field: "dateAdded"|"dateUpdated",
//     direction: "asc"|"desc"} — entrambi i field/direction sono verificati
//     nel traffico reale di n8n e nel sync periodico.
//   - page (se presente): intero >= 1 (offset-style, supportato da GHL
//     sorgente — verificato dal vivo, n8n lo usa per scansioni paginate).
//
// Esclusi (filtri locali senza mapping GHL pulito, o non ancora verificati):
//   - query, tag, email, filters (array non vuoto), startAfterId.
//   - page < 1 o non intero.
//
// Esportata solo per test unitari mirati.
export function isSyncEquivalentSearch(body) {
  // Filtri locali: sempre motivo di esclusione.
  if (body.query || body.tag || body.email || body.startAfterId) return false;
  if (Array.isArray(body.filters) && body.filters.length > 0) return false;
  // page: ammesso solo se intero >= 1 (assente o non-finito → OK, escluso altrimenti).
  if (body.page != null && (!Number.isInteger(body.page) || body.page < 1)) return false;
  // sort: esattamente 1 elemento, field e direction in allowlist.
  const sort = body.sort;
  if (!Array.isArray(sort) || sort.length !== 1) return false;
  const { field, direction } = sort[0] || {};
  if (field !== "dateAdded" && field !== "dateUpdated") return false;
  if (direction !== "asc" && direction !== "desc") return false;
  return true;
}

function scheduleContactsSearchParityCheck(siteId, serializedContacts, searchBody) {
  isPassthroughActive(siteId, CONTACTS_SEARCH_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: CONTACTS_SEARCH_PARITY_ENDPOINT,
        clonePayload: serializedContacts,
        isEquivalent: (clone, ghl) => compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.contacts || p || [] }),
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          // Replica esattamente il body della richiesta reale: stesso
          // pageLimit, stesso sort (field+direction), stesso page (se
          // presente).  locationId viene dal config locale (la rotta lo
          // ignora, GHL lo usa internamente per il filtering location).
          // pageLimit CLAMPATO 1-100 come fa la rotta stessa (filters.limit):
          // il clone non restituisce mai più di 100 contatti per pagina, un
          // pageLimit più alto verso GHL produrrebbe un conteggio diverso e
          // un mismatch non dovuto a una vera divergenza.
          const rawLimit = parseInt(searchBody.pageLimit, 10) || 100;
          const body = {
            locationId: cfg.location_id,
            pageLimit: Math.min(Math.max(rawLimit, 1), 100),
          };
          if (Array.isArray(searchBody.sort)) body.sort = searchBody.sort;
          if (Number.isInteger(searchBody.page) && searchBody.page >= 1) body.page = searchBody.page;
          return client.raw("/contacts/search", {
            method: "POST",
            body,
            sendLocationId: false,
          });
        },
      });
    })
    .catch((err) => logger.error(`scheduleContactsSearchParityCheck fallita (site ${siteId}): ${err.message}`));
}

// ── GET /contacts shadow-verifica (NON WIREATA nel router) ──────────
//
// MOTIVO PER CUI NON È WIREEATA:
//
// 1. GHL GET /contacts NON supporta ordinamento (verificato dal vivo,
//    mappers/contacts.js: "GET /contacts/ NON supporta alcun ordinamento,
//    solo paginazione per id di inserimento"). Il clone ordina per
//    c.id DESC → pagine completamente diverse per ogni "pagina" con
//    lo stesso limit → compareGhlSubset confronta sottoinsiemi
//    disgiunti → mismatch garantito → confronto inaffidabile.
//
// 2. Nessuna richiesta reale su GET /contacts osservata dallo sniffer
//    di traffico (prime ~15 min): solo POST /contacts/search.
//    Wireare un endpoint fantasma sprecherebbe budget shadow per nulla.
//
// 3. Se il traffico reale dovesse confermare l'uso di GET /contacts,
//    il confronto diventerebbe affidabile SOLO se il clone passasse
//    a un ordine compatibile con GHL (inserimento), oppure se GHL
//    introducesse sort su /contacts — entrambi modifiche esterne.
//
// Le funzioni sotto sono scritte per completezza e pronte all'uso
// qualora le condizioni cambino. Sono esportate solo per test.

const CONTACTS_LIST_PARITY_ENDPOINT = "GET /contacts";

// Guardia: SOLO la forma "senza filtri locali" è potenzialmente
// comparabile con GHL reale. Restituisce true solo quando la
// richiesta GET /contacts è "pura" (limit/startAfterId soli).
// Esportata solo per test unitari mirati.
export function isSyncEquivalentContactsList(query) {
  // Filtri testuali locali → risultati diversi da GHL → non confrontabili 1:1.
  if (query.query) return false;
  if (query.tag) return false;
  if (query.email) return false;
  // filters array stile sorgente [{field,operator,value}] → territorio POST /contacts/search.
  if (Array.isArray(query.filters) && query.filters.length > 0) return false;
  // Page offset (POST /contacts/search territory).
  if (query.page) return false;
  // sort esplicito → GHL GET /contacts NON supporta ordinamento
  // ("GET /contacts/ NON supporta alcun ordinamento, solo paginazione
  // per id di inserimento" — mappers/contacts.js).
  if (query.sort) return false;
  // Altrimenti: solo limit (default 20) + startAfterId (cursore opzionale).
  return true;
}

// Funzione di wiring shadow-verifica per GET /contacts.
// NON è chiamata dal router — vedi commento in testa alla sezione.
function scheduleContactsListParityCheck(siteId, filters, serializedContacts) {
  isPassthroughActive(siteId, CONTACTS_LIST_PARITY_ENDPOINT)
    .then((active) => {
      if (active) return;
      return recordComparison({
        siteId,
        endpoint: CONTACTS_LIST_PARITY_ENDPOINT,
        clonePayload: serializedContacts,
        isEquivalent: (clone, ghl) =>
          compareGhlSubset(clone, ghl, { extractGhlList: (p) => p?.contacts || p || [] }),
        fetchReal: async () => {
          const { loadConfig, createSourceClient } = await import("../../services/source-sync/client.js");
          const cfg = await loadConfig(siteId);
          if (!cfg || !cfg.enabled) throw new Error("source-sync non configurato");
          const client = createSourceClient(cfg);
          // GHL GET /contacts: solo limit + startAfterId, NESSUN sort
          // (verificato: supporta solo paginazione per id di inserimento).
          const params = { limit: filters.limit || 20 };
          if (filters.startAfterId) params.startAfterId = filters.startAfterId;
          return client.get("/contacts", params);
        },
      });
    })
    .catch((err) =>
      logger.error(`scheduleContactsListParityCheck fallita (site ${siteId}): ${err.message}`)
    );
}
// ── Fine GET /contacts shadow-verifica ──────────────────────────────

// GET /contacts — Lista con filtri + paginazione.
router.get("/contacts", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const filters = {
      limit,
      startAfterId,
      query: req.query.query || null,
      tag: req.query.tag || null,
      email: req.query.email || null,
    };
    const { contacts, total, nextStartAfterId } = await listContacts(req.tenant.siteId, filters);
    sendList(res, "contacts", contacts, total, nextStartAfterId);
  } catch (err) {
    next(err);
  }
});

// POST /contacts — Crea contatto.
router.post("/contacts", async (req, res, next) => {
  try {
    if (!req.body.email) {
      return sendError(res, 400, "Email obbligatoria");
    }
    const contact = await createContact(req.tenant.siteId, req.body);
    res.status(201).json({ contact });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    if (err.status === 409) return sendError(res, 409, err.message);
    next(err);
  }
});

// POST /contacts/search — Cerca contatti (body sorgente: pageLimit, sort, filtri).
router.post("/contacts/search", async (req, res, next) => {
  try {
    // sorgente invia il limite come `pageLimit` (NON `limit`): leggere il campo
    // sbagliato faceva cadere sempre sul default 20, ignorando pageLimit=1.
    const limit = parseInt(req.body.pageLimit, 10) || 20;
    // sorgente invia la pagina come "page" (numero 1-based, OFFSET-style) su
    // questo endpoint — non il nostro startAfterId (cursore interno, mai
    // usato da sorgente qui). Verificato dal vivo: sorgente onora page e restituisce
    // pagine diverse, il nostro endpoint lo ignorava e restituiva sempre lo
    // stesso primo blocco. Valore non intero/≤0 → ignorato.
    const pageNum = Number.isFinite(req.body.page) ? Math.trunc(req.body.page) : null;
const filters = {
       limit: Math.min(Math.max(limit, 1), 100),
       startAfterId: req.body.startAfterId || null,
       page: pageNum && pageNum >= 1 ? pageNum : null,
       query: req.body.query || null,
       tag: req.body.tag || null,
       email: req.body.email || null,
       sort: Array.isArray(req.body.sort) ? req.body.sort : null,
       // filters array stile sorgente: [{ field, operator, value }].
       // Letto e passato a listContacts/searchContacts con allowlist sicura.
       filters: Array.isArray(req.body.filters) ? req.body.filters : null,
     };
    const { contacts, total } = await searchContacts(req.tenant.siteId, filters);
    if (isSyncEquivalentSearch(req.body)) {
      scheduleContactsSearchParityCheck(req.tenant.siteId, contacts, req.body);
    }
    // Shape TOP DEDICATO per QUESTO endpoint (verificato sul payload reale):
    // { contacts, total, traceId } — NON wrappato in "meta" come gli altri
    // endpoint. sendList() è corretto per GET /contacts ma NON qui, quindi
    // risposta costruita a mano (niente nextPage/prevPage: la paginazione sorgente
    // di questo endpoint usa searchAfter per-contatto, già nei contatti).
    // traceId è generato per-richiesta (non persistito), come fa sorgente.
    res.json({ contacts, total, traceId: crypto.randomUUID() });
  } catch (err) {
    next(err);
  }
});

router.post("/contacts/upsert", async (req, res, next) => {
  try {
    if (!req.body.email) {
      return sendError(res, 400, "Email obbligatoria");
    }
    const { contact, created } = await upsertContact(req.tenant.siteId, req.body);
    res.status(created ? 201 : 200).json({ contact });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    next(err);
  }
});

router.post("/contacts/search/duplicate", async (req, res, next) => {
  try {
    const duplicates = await findDuplicates(req.tenant.siteId);
    res.json({ duplicates, meta: buildMeta(duplicates.length) });
  } catch (err) {
    next(err);
  }
});

router.get("/contacts/:contactId", async (req, res, next) => {
  try {
    const id = requireAnyId(req.params.contactId, res);
    if (!id) return;
    const contact = await getContact(req.tenant.siteId, id);
    res.json({ contact });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// PUT /contacts/:contactId — Aggiorna contatto.
router.put("/contacts/:contactId", async (req, res, next) => {
  try {
    const id = requireAnyId(req.params.contactId, res);
    if (!id) return;
    const contact = await updateContact(req.tenant.siteId, id, req.body);
    res.json({ contact });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// DELETE /contacts/:contactId — Elimina contatto.
router.delete("/contacts/:contactId", async (req, res, next) => {
  try {
    const id = requireAnyId(req.params.contactId, res);
    if (!id) return;
    await deleteContact(req.tenant.siteId, id);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// POST /contacts/search — Cerca contatti.
// POST /contacts/upsert — Upsert per email.
// POST /contacts/search/duplicate — Trova duplicati.
// ── Note contatti ─────────────────────────────────────────────────────────
// GET /contacts/:contactId/notes
router.get("/contacts/:contactId/notes", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const notes = await getContactNotes(req.tenant.siteId, contactId);
    sendList(res, "notes", notes, notes.length);
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// POST /contacts/:contactId/notes
router.post("/contacts/:contactId/notes", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const note = await createContactNote(req.tenant.siteId, contactId, req.body);
    res.status(201).json({ note });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// PUT /contacts/:contactId/notes/:noteId
router.put("/contacts/:contactId/notes/:noteId", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;
    const noteId = requireAnyId(req.params.noteId, res);
    if (!noteId) return;

    const note = await updateContactNote(req.tenant.siteId, contactId, noteId, req.body);
    res.json({ note });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// DELETE /contacts/:contactId/notes/:noteId
router.delete("/contacts/:contactId/notes/:noteId", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;
    const noteId = requireAnyId(req.params.noteId, res);
    if (!noteId) return;

    await deleteContactNote(req.tenant.siteId, contactId, noteId);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// ── Task contatti ─────────────────────────────────────────────────────────
// GET /contacts/:contactId/tasks
router.get("/contacts/:contactId/tasks", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const tasks = await getContactTasks(req.tenant.siteId, contactId);
    sendList(res, "tasks", tasks, tasks.length);
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// POST /contacts/:contactId/tasks
router.post("/contacts/:contactId/tasks", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const task = await createContactTask(req.tenant.siteId, contactId, req.body);
    res.status(201).json({ task });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// PUT /contacts/:contactId/tasks/:taskId
router.put("/contacts/:contactId/tasks/:taskId", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;
    const taskId = requireAnyId(req.params.taskId, res);
    if (!taskId) return;

    const task = await updateContactTask(req.tenant.siteId, contactId, taskId, req.body);
    res.json({ task });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// DELETE /contacts/:contactId/tasks/:taskId
router.delete("/contacts/:contactId/tasks/:taskId", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;
    const taskId = requireAnyId(req.params.taskId, res);
    if (!taskId) return;

    await deleteContactTask(req.tenant.siteId, contactId, taskId);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// ── Follower contatti ─────────────────────────────────────────────────────
// GET /contacts/:contactId/followers
router.get("/contacts/:contactId/followers", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const followers = await getContactFollowers(req.tenant.siteId, contactId);
    sendList(res, "followers", followers, followers.length);
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// POST /contacts/:contactId/followers
router.post("/contacts/:contactId/followers", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    if (!req.body.userId || typeof req.body.userId !== "string" || !req.body.userId.trim() || req.body.userId.length > 255) {
      return sendError(res, 400, "userId richiesto e valido");
    }

    const follower = await addContactFollower(req.tenant.siteId, contactId, req.body.userId);
    const followers = await getContactFollowers(req.tenant.siteId, contactId);
    res.status(201).json({ followers });
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, err.message);
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// DELETE /contacts/:contactId/followers/:userId
router.delete("/contacts/:contactId/followers/:userId", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;
    const userId = requireAnyId(req.params.userId, res);
    if (!userId) return;

    await removeContactFollower(req.tenant.siteId, contactId, userId);
    res.json({ deleted: true });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// ── Appuntamenti contatti ──────────────────────────────────────────────────
// GET /contacts/:contactId/appointments
router.get("/contacts/:contactId/appointments", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const appointments = await getContactAppointments(req.tenant.siteId, contactId);
    sendList(res, "appointments", appointments, appointments.length);
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// ── Verifica email contatti ────────────────────────────────────────────────
// GET /contacts/:contactId/email-verification
router.get("/contacts/:contactId/email-verification", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const emailVerification = await getContactEmailVerification(req.tenant.siteId, contactId);
    res.json({ emailVerification });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// ── Tags subresource (sorgente POST /contacts/{contactId}/tags) ──────────
// POST /contacts/:contactId/tags — aggiunge tag esistenti (non sovrascrive)
router.post("/contacts/:contactId/tags", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const newTags = req.body.tags;
    if (!Array.isArray(newTags)) {
      return sendError(res, 400, "tags deve essere un array");
    }

    const result = await addContactTags(req.tenant.siteId, contactId, newTags);
    res.json({ tags: result.tags });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

// DELETE /contacts/:contactId/tags — rimuove tag dal contatto
router.delete("/contacts/:contactId/tags", async (req, res, next) => {
  try {
    const contactId = requireAnyId(req.params.contactId, res);
    if (!contactId) return;

    const tagsToRemove = req.body.tags;
    if (!Array.isArray(tagsToRemove)) {
      return sendError(res, 400, "tags deve essere un array");
    }

    const result = await removeContactTags(req.tenant.siteId, contactId, tagsToRemove);
    res.json({ tags: result.tags });
  } catch (err) {
    if (err.status === 404) return sendError(res, 404, err.message);
    next(err);
  }
});

export default router;
