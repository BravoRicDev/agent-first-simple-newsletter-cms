import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import express from "express";
import { query } from "../../src/db.js";
import { createTestSite, closeDb } from "../helpers.js";
import cloneRoutes from "../../src/routes/api-clone/index.js";

// Onda H: Memberships clone API — memberships, courses, enrollments.
describe("Onda H — Memberships clone", () => {
  let server, baseUrl;
  let site;
  let apiKey;
  let contact;

  const mkKey = async (siteId, name) => {
    const raw = "testkey_" + crypto.randomBytes(24).toString("hex");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const r = await query(
      "INSERT INTO site_api_keys (site_id, name, token_hash, token_prefix, active) VALUES ($1, $2, $3, $4, true) RETURNING id",
      [siteId, name, hash, raw.slice(0, 12)]
    );
    return { id: r.rows[0].id, raw };
  };

  const fetch = async (path, opts = {}) => {
    const sep = path.includes("?") ? "&" : "?";
    const url = `http://localhost:${server.address().port}${path}${sep}locationId=${site.id}`;
    const res = await globalThis.fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey.raw}`,
        ...(opts.headers || {}),
      },
    });
    const data = res.ok ? await res.json() : null;
    return { status: res.status, data };
  };

  before(async () => {
    site = await createTestSite("Memberships Clone");
    apiKey = await mkKey(site.id, "test key");

    // Create test contact
    const contactEmail = `contact-${crypto.randomBytes(4).toString("hex")}@test.local`;
    const contactResult = await query(
      "INSERT INTO contacts (site_id, email, status) VALUES ($1, $2, 'active') RETURNING id, external_id",
      [site.id, contactEmail]
    );
    contact = { id: contactResult.rows[0].id, externalId: contactResult.rows[0].external_id };
    if (!contact.externalId) {
      const extResult = await query("SELECT external_id FROM contacts WHERE id = $1", [contact.id]);
      contact.externalId = extResult.rows[0].external_id;
    }

    const app = express();
    app.use(express.json());
    app.use(cloneRoutes);
    app.use((req, res) => res.status(404).json({ statusCode: 404, message: "not found" }));
    app.use((err, req, res, next) => {
      res.status(500).json({ statusCode: 500, message: err.message });
    });

    server = await new Promise((resolve) => {
      const srv = app.listen(0, () => {
        baseUrl = `http://localhost:${srv.address().port}`;
        resolve(srv);
      });
    });
  });

  after(async () => {
    if (server) server.close();
    await closeDb();
  });

  // ── Memberships ──────────────────────────────────────────────────────

  test("Memberships: create → list → get → update → delete", async () => {
    // Create membership
    const createRes = await fetch("/memberships", {
      method: "POST",
      body: JSON.stringify({
        name: "Premium Club",
        price: 29.99,
        currency: "EUR",
        billingInterval: "monthly",
        active: true,
      }),
    });
    assert.equal(createRes.status, 201);
    assert(createRes.data.membership);
    assert(createRes.data.membership.id);
    assert.equal(createRes.data.membership.name, "Premium Club");
    assert.equal(createRes.data.membership.price, 29.99);
    assert.equal(createRes.data.membership.currency, "EUR");
    assert.equal(createRes.data.membership.billingInterval, "monthly");
    assert.equal(createRes.data.membership.active, true);
    assert(createRes.data.membership.dateAdded);
    const membershipId = createRes.data.membership.id;

    // List memberships
    const listRes = await fetch("/memberships");
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.memberships));
    assert(listRes.data.meta);
    assert.equal(listRes.data.meta.total, 1);

    // Get membership
    const getRes = await fetch(`/memberships/${membershipId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.membership.id, membershipId);

    // Update membership
    const updateRes = await fetch(`/memberships/${membershipId}`, {
      method: "PUT",
      body: JSON.stringify({ price: 39.99, active: false }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.membership.price, 39.99);
    assert.equal(updateRes.data.membership.active, false);

    // Delete membership
    const delRes = await fetch(`/memberships/${membershipId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);

    // Verify deletion
    const listAfterRes = await fetch("/memberships");
    assert.equal(listAfterRes.data.meta.total, 0);
  });

  // ── Courses ──────────────────────────────────────────────────────────

  test("Courses: create → list with membershipId filter → get → update → delete", async () => {
    // Create membership first
    const membershipRes = await fetch("/memberships", {
      method: "POST",
      body: JSON.stringify({
        name: "Learning Path",
        price: 49.99,
        billingInterval: "yearly",
      }),
    });
    const membershipId = membershipRes.data.membership.id;

    // Create course
    const courseRes = await fetch("/courses", {
      method: "POST",
      body: JSON.stringify({
        membershipId,
        name: "Advanced JavaScript",
        description: "Learn advanced JS",
        published: false,
      }),
    });
    assert.equal(courseRes.status, 201);
    assert(courseRes.data.course);
    assert(courseRes.data.course.id);
    assert.equal(courseRes.data.course.name, "Advanced JavaScript");
    assert.equal(courseRes.data.course.membershipId, membershipId);
    const courseId = courseRes.data.course.id;

    // List courses with membershipId filter
    const listRes = await fetch(`/courses?membershipId=${membershipId}`);
    assert.equal(listRes.status, 200);
    assert(listRes.data.courses.some((c) => c.id === courseId));

    // Get course
    const getRes = await fetch(`/courses/${courseId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.course.id, courseId);

    // Update course
    const updateRes = await fetch(`/courses/${courseId}`, {
      method: "PUT",
      body: JSON.stringify({ published: true }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.course.published, true);

    // Delete course
    const delRes = await fetch(`/courses/${courseId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);
  });

  // ── Enrollments ──────────────────────────────────────────────────────

  test("Enrollments: create → list → update status to completed → check completedAt", async () => {
    // Create membership
    const membershipRes = await fetch("/memberships", {
      method: "POST",
      body: JSON.stringify({
        name: "Enrollment Test",
        price: 0,
      }),
    });
    const membershipId = membershipRes.data.membership.id;

    // Enroll contact
    const enrollRes = await fetch(`/memberships/${membershipId}/enroll`, {
      method: "POST",
      body: JSON.stringify({
        contactId: contact.externalId,
      }),
    });
    assert.equal(enrollRes.status, 201);
    assert(enrollRes.data.enrollment);
    assert(enrollRes.data.enrollment.id);
    assert.equal(enrollRes.data.enrollment.membershipId, membershipId);
    assert.equal(enrollRes.data.enrollment.contactId, contact.externalId);
    assert.equal(enrollRes.data.enrollment.status, "active");
    assert(enrollRes.data.enrollment.enrolledAt);
    assert(enrollRes.data.enrollment.completedAt === null);
    const enrollmentId = enrollRes.data.enrollment.id;

    // List enrollments
    const listRes = await fetch(`/memberships/${membershipId}/enrollments`);
    assert.equal(listRes.status, 200);
    assert(Array.isArray(listRes.data.enrollments));
    assert(listRes.data.meta.total >= 1);

    // Update enrollment to completed
    const updateRes = await fetch(`/enrollments/${enrollmentId}`, {
      method: "PUT",
      body: JSON.stringify({ status: "completed" }),
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.data.enrollment.status, "completed");
    assert(updateRes.data.enrollment.completedAt); // Should be set to NOW()
  });

  test("Enrollments: create with courseId", async () => {
    // Create membership and course
    const membershipRes = await fetch("/memberships", {
      method: "POST",
      body: JSON.stringify({ name: "Course Test", price: 0 }),
    });
    const membershipId = membershipRes.data.membership.id;

    const courseRes = await fetch("/courses", {
      method: "POST",
      body: JSON.stringify({
        membershipId,
        name: "Test Course",
        published: true,
      }),
    });
    const courseId = courseRes.data.course.id;

    // Enroll with courseId
    const enrollRes = await fetch(`/memberships/${membershipId}/enroll`, {
      method: "POST",
      body: JSON.stringify({
        contactId: contact.externalId,
        courseId,
      }),
    });
    assert.equal(enrollRes.status, 201);
    assert.equal(enrollRes.data.enrollment.courseId, courseId);
  });
});
