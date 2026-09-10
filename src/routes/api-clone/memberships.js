import { Router } from "express";
import {
  createMembership,
  listMemberships,
  getMembershipCount,
  getMembershipByExternalId,
  updateMembership,
  deleteMembership,
  createCourse,
  listCourses,
  getCourseCount,
  getCourseByExternalId,
  updateCourse,
  deleteCourse,
  createEnrollment,
  listEnrollments,
  getEnrollmentCount,
  getEnrollmentByExternalId,
  updateEnrollment,
  deleteEnrollment,
} from "../../services/memberships-clone.js";
import { getLocationId, sendError, requireUuid, getPaging, sendList } from "./_helpers.js";
import { ensureExternalId, findByAnyId, publicId } from "../../services/external-ids.js";
import { query } from "../../db.js";

const router = Router();

// Id pubblico del contatto collegato a un enrollment: ghl_id reale se
// presente, fallback UUID interno (stesso ordine di publicId usato in tutti
// i serializer del clone-API). memberships/courses/enrollments NON hanno
// ghl_id: l'unica referenza cross-risorsa sincronizzata da GHL è il contatto.
async function contactPublicId(contactInternalId) {
  if (!contactInternalId) return null;
  const c = (await query(
    "SELECT external_id, ghl_id FROM contacts WHERE id = $1",
    [contactInternalId]
  )).rows[0];
  if (!c) return null;
  return (c.ghl_id && String(c.ghl_id).trim()) || c.external_id
    || (await ensureExternalId("contacts", contactInternalId));
}

// ─────────────────────────────────────────────────────────────────────────
// Memberships: CRUD
// ─────────────────────────────────────────────────────────────────────────

router.get("/memberships", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    const offset = 0; // TODO: cursor pagination
    const memberships = await listMemberships(tenant.siteId, limit, offset);
    const count = await getMembershipCount(tenant.siteId);

    const serialized = memberships.map((m) => ({
      id: m.external_id,
      locationId,
      name: m.name,
      price: parseFloat(m.price),
      currency: m.currency,
      billingInterval: m.billing_interval,
      active: m.active,
      dateAdded: m.created_at?.toISOString(),
      dateUpdated: m.updated_at?.toISOString(),
    }));

    sendList(res, "memberships", serialized, count);
  } catch (err) {
    next(err);
  }
});

router.post("/memberships", async (req, res, next) => {
  try {
    const { name, price, currency, billingInterval, active } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!name) {
      return sendError(res, 400, "Name obbligatorio");
    }

    const membership = await createMembership(tenant.siteId, {
      name,
      price,
      currency,
      billingInterval,
      active,
    });

    res.status(201).json({
      membership: {
        id: membership.external_id,
        locationId,
        name: membership.name,
        price: parseFloat(membership.price),
        currency: membership.currency,
        billingInterval: membership.billing_interval,
        active: membership.active,
        dateAdded: membership.created_at?.toISOString(),
        dateUpdated: membership.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/memberships/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const membership = await getMembershipByExternalId(id);
    if (!membership) {
      return sendError(res, 404, "Membership non trovata");
    }

    const locationId = await getLocationId(req.tenant);

    res.json({
      membership: {
        id: membership.external_id,
        locationId,
        name: membership.name,
        price: parseFloat(membership.price),
        currency: membership.currency,
        billingInterval: membership.billing_interval,
        active: membership.active,
        dateAdded: membership.created_at?.toISOString(),
        dateUpdated: membership.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put("/memberships/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, price, currency, billingInterval, active } = req.body;
    if (!requireUuid(id, res)) return;

    const membership = await getMembershipByExternalId(id);
    if (!membership) {
      return sendError(res, 404, "Membership non trovata");
    }

    const updated = await updateMembership(membership.id, {
      name,
      price,
      currency,
      billingInterval,
      active,
    });

    const locationId = await getLocationId(req.tenant);

    res.json({
      membership: {
        id: updated.external_id,
        locationId,
        name: updated.name,
        price: parseFloat(updated.price),
        currency: updated.currency,
        billingInterval: updated.billing_interval,
        active: updated.active,
        dateAdded: updated.created_at?.toISOString(),
        dateUpdated: updated.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/memberships/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const membership = await getMembershipByExternalId(id);
    if (!membership) {
      return sendError(res, 404, "Membership non trovata");
    }

    await deleteMembership(membership.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Courses: CRUD (filtro ?membershipId=)
// ─────────────────────────────────────────────────────────────────────────

router.get("/courses", async (req, res, next) => {
  try {
    const { membershipId } = req.query;
    const { limit, startAfterId } = getPaging(req.query);
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    const filters = {};
    if (membershipId) {
      filters.membershipId = membershipId;
    }

    const offset = 0; // TODO: cursor pagination
    const courses = await listCourses(tenant.siteId, filters, limit, offset);
    const count = await getCourseCount(tenant.siteId, filters);

    const serialized = courses.map((c) => ({
      id: c.external_id,
      locationId,
      membershipId: c.membership_id ? null : null, // TODO: external_id of membership
      name: c.name,
      description: c.description,
      published: c.published,
      dateAdded: c.created_at?.toISOString(),
      dateUpdated: c.updated_at?.toISOString(),
    }));

    // Serializza membershipId se esiste
    for (let i = 0; i < courses.length; i++) {
      if (courses[i].membership_id) {
        serialized[i].membershipId = await ensureExternalId("memberships", courses[i].membership_id);
      }
    }

    sendList(res, "courses", serialized, count);
  } catch (err) {
    next(err);
  }
});

router.post("/courses", async (req, res, next) => {
  try {
    const { membershipId, name, description, published } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!name) {
      return sendError(res, 400, "Name obbligatorio");
    }

    // Se membershipId è esterno (UUID), lo risolviamo
    let membershipDbId = null;
    if (membershipId) {
      const membership = await getMembershipByExternalId(membershipId);
      if (!membership) {
        return sendError(res, 404, "Membership non trovata");
      }
      membershipDbId = membership.id;
    }

    const course = await createCourse(tenant.siteId, {
      membershipId: membershipDbId,
      name,
      description,
      published,
    });

    res.status(201).json({
      course: {
        id: course.external_id,
        locationId,
        membershipId: course.membership_id ? await ensureExternalId("memberships", course.membership_id) : null,
        name: course.name,
        description: course.description,
        published: course.published,
        dateAdded: course.created_at?.toISOString(),
        dateUpdated: course.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/courses/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const course = await getCourseByExternalId(id);
    if (!course) {
      return sendError(res, 404, "Course non trovato");
    }

    const locationId = await getLocationId(req.tenant);

    res.json({
      course: {
        id: course.external_id,
        locationId,
        membershipId: course.membership_id ? await ensureExternalId("memberships", course.membership_id) : null,
        name: course.name,
        description: course.description,
        published: course.published,
        dateAdded: course.created_at?.toISOString(),
        dateUpdated: course.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put("/courses/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { membershipId, name, description, published } = req.body;
    if (!requireUuid(id, res)) return;

    const course = await getCourseByExternalId(id);
    if (!course) {
      return sendError(res, 404, "Course non trovato");
    }

    let membershipDbId;
    if (membershipId) {
      const membership = await getMembershipByExternalId(membershipId);
      if (!membership) {
        return sendError(res, 404, "Membership non trovata");
      }
      membershipDbId = membership.id;
    } else if (membershipId === null) {
      membershipDbId = null;
    } else {
      membershipDbId = undefined; // non aggiornare se non fornito
    }

    const updated = await updateCourse(course.id, {
      membershipId,
      name,
      description,
      published,
    });

    const locationId = await getLocationId(req.tenant);

    res.json({
      course: {
        id: updated.external_id,
        locationId,
        membershipId: updated.membership_id ? await ensureExternalId("memberships", updated.membership_id) : null,
        name: updated.name,
        description: updated.description,
        published: updated.published,
        dateAdded: updated.created_at?.toISOString(),
        dateUpdated: updated.updated_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/courses/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const course = await getCourseByExternalId(id);
    if (!course) {
      return sendError(res, 404, "Course non trovato");
    }

    await deleteCourse(course.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Enrollments: POST /memberships/{membershipId}/enroll, GET list, PUT status
// ─────────────────────────────────────────────────────────────────────────

router.post("/memberships/:membershipId/enroll", async (req, res, next) => {
  try {
    const { membershipId } = req.params;
    const { contactId, courseId } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!requireUuid(membershipId, res)) return;
    if (!contactId) {
      return sendError(res, 400, "contactId obbligatorio");
    }

    // Risolvi membership esterno
    const membership = await getMembershipByExternalId(membershipId);
    if (!membership) {
      return sendError(res, 404, "Membership non trovata");
    }

    // Valida contatto esterno. La tabella contacts HA ghl_id (è sincronizzata
    // da GHL), quindi l'automazione può passare l'id reale del contatto:
    // findByAnyId accetta sia UUID sia ghl_id. (memberships/courses/enrollments
    // NON hanno ghl_id → restano UUID-only, vedi verifica lo schema.)
    const contact = await findByAnyId("contacts", tenant.siteId, contactId);
    if (!contact || contact.site_id !== tenant.siteId) {
      return sendError(res, 404, "Contatto non trovato");
    }

    let courseDbId = null;
    if (courseId) {
      if (!requireUuid(courseId, res)) return;
      const course = await getCourseByExternalId(courseId);
      if (!course) {
        return sendError(res, 404, "Course non trovato");
      }
      courseDbId = course.id;
    }

    const enrollment = await createEnrollment(tenant.siteId, membership.id, {
      contactId: contact.id,
      courseId: courseDbId,
    });

    // contact è già in scope (risolto sopra con findByAnyId): riusiamo la
    // sua publicId invece di riquery-re il contatto.
    const contactExtId = publicId(contact) || (await ensureExternalId("contacts", contact.id));
    const courseExtId = courseDbId ? await ensureExternalId("courses", courseDbId) : null;

    res.status(201).json({
      enrollment: {
        id: enrollment.external_id,
        locationId,
        membershipId: await ensureExternalId("memberships", enrollment.membership_id),
        contactId: contactExtId,
        courseId: courseExtId,
        status: enrollment.status,
        enrolledAt: enrollment.enrolled_at?.toISOString(),
        completedAt: enrollment.completed_at?.toISOString() || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/memberships/:membershipId/enrollments", async (req, res, next) => {
  try {
    const { membershipId } = req.params;
    const { limit, startAfterId } = getPaging(req.query);
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!requireUuid(membershipId, res)) return;

    const membership = await getMembershipByExternalId(membershipId);
    if (!membership) {
      return sendError(res, 404, "Membership non trovata");
    }

    const offset = 0; // TODO: cursor pagination
    const enrollments = await listEnrollments(membership.id, limit, offset);
    const count = await getEnrollmentCount(membership.id);

    const serialized = await Promise.all(
      enrollments.map(async (e) => ({
        id: e.external_id,
        locationId,
        membershipId: await ensureExternalId("memberships", e.membership_id),
        contactId: await contactPublicId(e.contact_id),
        courseId: e.course_id ? await ensureExternalId("courses", e.course_id) : null,
        status: e.status,
        enrolledAt: e.enrolled_at?.toISOString(),
        completedAt: e.completed_at?.toISOString() || null,
      }))
    );

    sendList(res, "enrollments", serialized, count);
  } catch (err) {
    next(err);
  }
});

router.put("/enrollments/:enrollmentId", async (req, res, next) => {
  try {
    const { enrollmentId } = req.params;
    const { status } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!requireUuid(enrollmentId, res)) return;

    const enrollment = await getEnrollmentByExternalId(enrollmentId);
    if (!enrollment) {
      return sendError(res, 404, "Enrollment non trovato");
    }

    const updated = await updateEnrollment(enrollment.id, { status });

    res.json({
      enrollment: {
        id: updated.external_id,
        locationId,
        membershipId: await ensureExternalId("memberships", updated.membership_id),
        contactId: await contactPublicId(updated.contact_id),
        courseId: updated.course_id ? await ensureExternalId("courses", updated.course_id) : null,
        status: updated.status,
        enrolledAt: updated.enrolled_at?.toISOString(),
        completedAt: updated.completed_at?.toISOString() || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
