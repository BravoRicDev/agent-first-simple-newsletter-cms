import { Router } from "express";
import { sendError, sendList, getPaging, requireAnyId, getLocationId, buildMeta } from "./_helpers.js";
import {
  createContact, getContact, updateContact, deleteContact,
  listContacts, searchContacts, upsertContact, findDuplicates,
  getContactNotes, createContactNote, updateContactNote, deleteContactNote,
  getContactTasks, createContactTask, updateContactTask, deleteContactTask,
  getContactFollowers, addContactFollower, removeContactFollower,
  getContactAppointments, getContactEmailVerification,
} from "../../services/contacts-clone.js";

const router = Router();

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

// POST /contacts/search — Cerca contatti (body GHL: pageLimit, sort, filtri).
router.post("/contacts/search", async (req, res, next) => {
  try {
    // GHL invia il limite come `pageLimit` (NON `limit`): leggere il campo
    // sbagliato faceva cadere sempre sul default 20, ignorando pageLimit=1.
    const limit = parseInt(req.body.pageLimit, 10) || 20;
    const filters = {
      limit: Math.min(Math.max(limit, 1), 100),
      startAfterId: req.body.startAfterId || null,
      query: req.body.query || null,
      tag: req.body.tag || null,
      email: req.body.email || null,
      // sort stile GHL: array [{ field, direction }]. Non è una colonna SQL
      // grezza: viene validato/mappato su allowlist in listContacts.
      sort: Array.isArray(req.body.sort) ? req.body.sort : null,
    };
    const { contacts, total, nextStartAfterId } = await searchContacts(req.tenant.siteId, filters);
    sendList(res, "contacts", contacts, total, nextStartAfterId);
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

export default router;
