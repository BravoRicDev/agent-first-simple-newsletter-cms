import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb, uniqueEmail } from "../helpers.js";
import apiCloneRoutes from "../../src/routes/api-clone/index.js";
import crypto from "crypto";

describe("ONDA A — Contacts clone API", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let locationId;

  before(async () => {
    site = await createTestSite("Contacts Clone Test");
    locationId = site.id;

    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [site.id, "clone key", hash, raw.slice(0, 12)]
    );
    apiKey = { id: r.rows[0].id, raw };

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(apiCloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(err.status || 500).json({ statusCode: err.status || 500, message: err.message });
    });

    await new Promise(resolve => {
      server = app.listen(0, () => {
        baseUrl = `http://localhost:${server.address().port}`;
        resolve();
      });
    });
  });

  after(async () => {
    server.closeAllConnections?.();
    server.close();
    await closeDb();
  });

  const buildUrl = (path, q = {}) => {
    const params = new URLSearchParams({ locationId: String(locationId), ...q });
    return `${baseUrl}${path}?${params}`;
  };

  const h = (token) => ({ "Authorization": `Bearer ${token}`, "Content-Type": "application/json" });

  test("POST /contacts — crea contatto", async () => {
    const email = uniqueEmail("contact");
    const res = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({
        locationId: String(locationId),
        firstName: "John",
        lastName: "Doe",
        email,
        phone: "+1-555-1234",
        companyName: "ACME",
        tags: ["vip"],
      }),
    });
    assert.equal(res.status, 201);
    const { contact } = await res.json();
    assert.ok(contact.id);
    assert.equal(contact.email, email);
    assert.equal(contact.firstName, "John");
    assert.deepStrictEqual(contact.tags, ["vip"]);
  });

  test("POST /contacts — mancante email → 400", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), firstName: "John" }),
    });
    assert.equal(res.status, 400);
    const { statusCode } = await res.json();
    assert.equal(statusCode, 400);
  });

  test("POST /contacts — email invalida → 400", async () => {
    const res = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email: "notanemail" }),
    });
    assert.equal(res.status, 400);
  });

  test("POST /contacts — duplicato → 409", async () => {
    const email = uniqueEmail("dup");
    await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const res = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    assert.equal(res.status, 409);
    const { statusCode } = await res.json();
    assert.equal(statusCode, 409);
  });

  test("GET /contacts/:contactId — leggi contatto", async () => {
    const email = uniqueEmail("read");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email, firstName: "Jane" }),
    });
    const { contact: created } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${created.id}`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { contact } = await res.json();
    assert.equal(contact.id, created.id);
    assert.equal(contact.email, email);
    assert.equal(contact.firstName, "Jane");
  });

  test("GET /contacts/:contactId — uuid invalido → 400", async () => {
    const res = await fetch(buildUrl("/contacts/not-a-uuid"), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 400);
  });

  test("GET /contacts/:contactId — mancante → 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(buildUrl(`/contacts/${fakeId}`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 404);
  });

  test("PUT /contacts/:contactId — aggiorna parziale", async () => {
    const email = uniqueEmail("update");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact: created } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${created.id}`), {
      method: "PUT",
      headers: h(apiKey.raw),
      body: JSON.stringify({
        firstName: "UpdatedName",
        phone: "+1-999-9999",
      }),
    });
    assert.equal(res.status, 200);
    const { contact } = await res.json();
    assert.equal(contact.firstName, "UpdatedName");
    assert.equal(contact.phone, "+1-999-9999");
  });

  test("PUT /contacts/:contactId — tags replace", async () => {
    const email = uniqueEmail("tags");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email, tags: ["old"] }),
    });
    const { contact: created } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${created.id}`), {
      method: "PUT",
      headers: h(apiKey.raw),
      body: JSON.stringify({ tags: ["new", "tags"] }),
    });
    assert.equal(res.status, 200);
    const { contact } = await res.json();
    assert.deepStrictEqual(contact.tags, ["new", "tags"]);
  });

  test("DELETE /contacts/:contactId — elimina", async () => {
    const email = uniqueEmail("delete");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact: created } = await createRes.json();

    const delRes = await fetch(buildUrl(`/contacts/${created.id}`), {
      method: "DELETE",
      headers: h(apiKey.raw),
    });
    assert.equal(delRes.status, 200);
    const { deleted } = await delRes.json();
    assert.equal(deleted, true);

    const getRes = await fetch(buildUrl(`/contacts/${created.id}`), {
      headers: h(apiKey.raw),
    });
    assert.equal(getRes.status, 404);
  });

  test("GET /contacts — lista con paginazione", async () => {
    for (let i = 0; i < 3; i++) {
      const email = uniqueEmail(`list${i}`);
      await fetch(`${baseUrl}/contacts`, {
        method: "POST",
        headers: h(apiKey.raw),
        body: JSON.stringify({ locationId: String(locationId), email }),
      });
    }

    const res = await fetch(buildUrl("/contacts", { limit: "2" }), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { contacts, meta } = await res.json();
    assert.ok(Array.isArray(contacts));
    assert.ok(typeof meta.total === "number");
    assert.ok(meta.total >= 3);
    assert.ok(meta.nextPage === null || typeof meta.nextPage === "string");
  });

  test("GET /contacts?tag=xyz — filtra per tag", async () => {
    const email = uniqueEmail("tagged");
    await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email, tags: ["special"] }),
    });

    const res = await fetch(buildUrl("/contacts", { tag: "special" }), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { contacts } = await res.json();
    assert.ok(Array.isArray(contacts));
  });

  test("POST /contacts/search — cerca", async () => {
    const email = uniqueEmail("search");
    await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email, firstName: "SearchTest" }),
    });

    const res = await fetch(`${baseUrl}/contacts/search`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), query: "SearchTest" }),
    });
    assert.equal(res.status, 200);
    const { contacts, meta } = await res.json();
    assert.ok(Array.isArray(contacts));
    assert.ok(typeof meta.total === "number");
  });

  test("POST /contacts/upsert — crea se manca", async () => {
    const email = uniqueEmail("upsert");
    const res = await fetch(`${baseUrl}/contacts/upsert`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email, firstName: "New" }),
    });
    assert.equal(res.status, 201);
    const { contact } = await res.json();
    assert.equal(contact.email, email);
    assert.equal(contact.firstName, "New");
  });

  test("POST /contacts/upsert — aggiorna se esiste", async () => {
    const email = uniqueEmail("upsert2");
    await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });

    const res = await fetch(`${baseUrl}/contacts/upsert`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email, firstName: "Updated" }),
    });
    assert.equal(res.status, 200);
    const { contact } = await res.json();
    assert.equal(contact.firstName, "Updated");
  });

  test("POST /contacts/search/duplicate — lista duplicati", async () => {
    const res = await fetch(`${baseUrl}/contacts/search/duplicate`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId) }),
    });
    assert.equal(res.status, 200);
    const { duplicates } = await res.json();
    assert.ok(Array.isArray(duplicates));
  });

  // ── Note subresource ──

  test("GET /contacts/:contactId/notes — lista note", async () => {
    const email = uniqueEmail("notes");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/notes`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { notes, meta } = await res.json();
    assert.ok(Array.isArray(notes));
  });

  test("POST /contacts/:contactId/notes — crea nota", async () => {
    const email = uniqueEmail("note-create");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/notes`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ body: "Test note" }),
    });
    assert.equal(res.status, 201);
    const { note } = await res.json();
    assert.ok(note.id);
    assert.equal(note.body, "Test note");
    assert.equal(note.contactId, contact.id);
  });

  test("PUT /contacts/:contactId/notes/:noteId — aggiorna nota", async () => {
    const email = uniqueEmail("note-update");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const noteRes = await fetch(buildUrl(`/contacts/${contact.id}/notes`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ body: "Original" }),
    });
    const { note: created } = await noteRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/notes/${created.id}`), {
      method: "PUT",
      headers: h(apiKey.raw),
      body: JSON.stringify({ body: "Updated" }),
    });
    assert.equal(res.status, 200);
    const { note } = await res.json();
    assert.equal(note.body, "Updated");
  });

  test("DELETE /contacts/:contactId/notes/:noteId — elimina nota", async () => {
    const email = uniqueEmail("note-delete");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const noteRes = await fetch(buildUrl(`/contacts/${contact.id}/notes`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ body: "To delete" }),
    });
    const { note } = await noteRes.json();

    const delRes = await fetch(buildUrl(`/contacts/${contact.id}/notes/${note.id}`), {
      method: "DELETE",
      headers: h(apiKey.raw),
    });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);
  });

  // ── Task subresource ──

  test("GET /contacts/:contactId/tasks — lista task", async () => {
    const email = uniqueEmail("tasks");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/tasks`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { tasks, meta } = await res.json();
    assert.ok(Array.isArray(tasks));
  });

  test("POST /contacts/:contactId/tasks — crea task", async () => {
    const email = uniqueEmail("task-create");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/tasks`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({
        title: "Test Task",
        body: "Description",
        dueDate: new Date("2026-09-01").toISOString(),
      }),
    });
    assert.equal(res.status, 201);
    const { task } = await res.json();
    assert.ok(task.id);
    assert.equal(task.title, "Test Task");
    assert.equal(task.completed, false);
  });

  test("PUT /contacts/:contactId/tasks/:taskId — toggle completed", async () => {
    const email = uniqueEmail("task-toggle");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const taskRes = await fetch(buildUrl(`/contacts/${contact.id}/tasks`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ title: "Toggle Test" }),
    });
    const { task: created } = await taskRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/tasks/${created.id}`), {
      method: "PUT",
      headers: h(apiKey.raw),
      body: JSON.stringify({ completed: true }),
    });
    assert.equal(res.status, 200);
    const { task } = await res.json();
    assert.equal(task.completed, true);
  });

  test("PUT /contacts/:contactId/tasks/:taskId — set reminderDate", async () => {
    const email = uniqueEmail("task-reminder");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const taskRes = await fetch(buildUrl(`/contacts/${contact.id}/tasks`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ title: "Reminder Test" }),
    });
    const { task: created } = await taskRes.json();

    const reminderDate = new Date("2026-08-30").toISOString();
    const res = await fetch(buildUrl(`/contacts/${contact.id}/tasks/${created.id}`), {
      method: "PUT",
      headers: h(apiKey.raw),
      body: JSON.stringify({ reminderDate }),
    });
    assert.equal(res.status, 200);
    const { task } = await res.json();
    assert.ok(task.reminderDate);
  });

  test("DELETE /contacts/:contactId/tasks/:taskId — elimina task", async () => {
    const email = uniqueEmail("task-delete");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const taskRes = await fetch(buildUrl(`/contacts/${contact.id}/tasks`), {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ title: "To delete" }),
    });
    const { task } = await taskRes.json();

    const delRes = await fetch(buildUrl(`/contacts/${contact.id}/tasks/${task.id}`), {
      method: "DELETE",
      headers: h(apiKey.raw),
    });
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted, true);
  });

  // ── Follower subresource ──

  test("GET /contacts/:contactId/followers — lista follower", async () => {
    const email = uniqueEmail("followers");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/followers`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { followers, meta } = await res.json();
    assert.ok(Array.isArray(followers));
  });

  // ── Email verification ──

  test("GET /contacts/:contactId/email-verification — verifica email", async () => {
    const email = uniqueEmail("verify");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    const res = await fetch(buildUrl(`/contacts/${contact.id}/email-verification`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { emailVerification } = await res.json();
    assert.ok(emailVerification.email);
    assert.ok(emailVerification.status);
  });

  // ── Appointment subresource ──

  test("GET /contacts/:contactId/appointments — lista appuntamenti", async () => {
    const email = uniqueEmail("appt");
    const createRes = await fetch(`${baseUrl}/contacts`, {
      method: "POST",
      headers: h(apiKey.raw),
      body: JSON.stringify({ locationId: String(locationId), email }),
    });
    const { contact } = await createRes.json();

    // Inserisci un booking_appointment
    const contactData = await (await fetch(buildUrl(`/contacts/${contact.id}`), {
      headers: h(apiKey.raw),
    })).json();
    const contactEmail = contactData.contact.email;

    await query(
      `INSERT INTO booking_appointments (site_id, title, contact_email, start_time, end_time, external_id, status)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '1 hour', gen_random_uuid(), 'confirmed')`,
      [site.id, "Test Appointment", contactEmail]
    );

    const res = await fetch(buildUrl(`/contacts/${contact.id}/appointments`), {
      headers: h(apiKey.raw),
    });
    assert.equal(res.status, 200);
    const { appointments, meta } = await res.json();
    assert.ok(Array.isArray(appointments));
  });
});
