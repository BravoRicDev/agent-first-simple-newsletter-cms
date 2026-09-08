import { Router } from "express";
import {
  createSocialAccount,
  listSocialAccounts,
  getSocialAccountCount,
  getSocialAccountByExternalId,
  deleteSocialAccount,
  createSocialPost,
  listSocialPosts,
  getSocialPostCount,
  getSocialPostByExternalId,
  updateSocialPost,
  deleteSocialPost,
} from "../../services/social-clone.js";
import { getLocationId, sendError, requireUuid, getPaging, sendList } from "./_helpers.js";

const router = Router();

// ─────────────────────────────────────────────────────────────────────────
// Social Accounts: GET/POST/DELETE
// ─────────────────────────────────────────────────────────────────────────

router.get("/social/accounts", async (req, res, next) => {
  try {
    const { limit, startAfterId } = getPaging(req.query);
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    const offset = 0; // TODO: cursor pagination con startAfterId
    const accounts = await listSocialAccounts(tenant.siteId, limit, offset);
    const count = await getSocialAccountCount(tenant.siteId);

    const serialized = accounts.map((a) => ({
      id: a.external_id,
      locationId,
      platform: a.platform,
      accountName: a.account_name,
      status: a.status,
      dateAdded: a.created_at?.toISOString(),
    }));

    sendList(res, "accounts", serialized, count);
  } catch (err) {
    next(err);
  }
});

router.post("/social/accounts", async (req, res, next) => {
  try {
    const { platform, accountName } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!platform) {
      return sendError(res, 400, "Platform obbligatoria");
    }

    const account = await createSocialAccount(tenant.siteId, { platform, accountName });

    res.status(201).json({
      account: {
        id: account.external_id,
        locationId,
        platform: account.platform,
        accountName: account.account_name,
        status: account.status,
        dateAdded: account.created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/social/accounts/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!requireUuid(id, res)) return;

    const account = await getSocialAccountByExternalId(id);
    if (!account) {
      return sendError(res, 404, "Account non trovato");
    }

    await deleteSocialAccount(account.id);
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Social Posts: GET/POST/PUT/DELETE
// ─────────────────────────────────────────────────────────────────────────

router.get("/social/posts", async (req, res, next) => {
  try {
    const { platform, status } = req.query;
    const { limit, startAfterId } = getPaging(req.query);
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    const filters = {};
    if (platform) filters.platform = platform;
    if (status) filters.status = status;

    const offset = 0; // TODO: cursor pagination
    const posts = await listSocialPosts(tenant.siteId, filters, limit, offset);
    const count = await getSocialPostCount(tenant.siteId, filters);

    const serialized = posts.map((p) => ({
      id: p.external_id,
      locationId,
      platform: p.platform,
      message: p.message,
      scheduledAt: p.scheduled_at?.toISOString(),
      postedAt: p.posted_at?.toISOString() || null,
      status: p.status,
      dateAdded: p.created_at?.toISOString(),
    }));

    sendList(res, "posts", serialized, count);
  } catch (err) {
    next(err);
  }
});

router.post("/social/posts", async (req, res, next) => {
  try {
    const { platform, message, scheduledAt } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!platform || !message) {
      return sendError(res, 400, "Platform e message obbligatori");
    }

    const post = await createSocialPost(tenant.siteId, { platform, message, scheduledAt });

    res.status(201).json({
      post: {
        id: post.external_id,
        locationId,
        platform: post.platform,
        message: post.message,
        scheduledAt: post.scheduled_at?.toISOString(),
        postedAt: post.posted_at?.toISOString() || null,
        status: post.status,
        dateAdded: post.created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put("/social/posts/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { message, scheduledAt } = req.body;
    const tenant = req.tenant;
    const locationId = await getLocationId(tenant);

    if (!requireUuid(id, res)) return;

    const post = await getSocialPostByExternalId(id, tenant.siteId);
    if (!post) {
      return sendError(res, 404, "Post non trovato");
    }

    const updated = await updateSocialPost(tenant.siteId, post.id, { message, scheduledAt });
    if (!updated) {
      return sendError(res, 409, "Post non può essere modificato (già pubblicato)");
    }

    res.json({
      post: {
        id: updated.external_id,
        locationId,
        platform: updated.platform,
        message: updated.message,
        scheduledAt: updated.scheduled_at?.toISOString(),
        postedAt: updated.posted_at?.toISOString() || null,
        status: updated.status,
        dateAdded: updated.created_at?.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/social/posts/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const tenant = req.tenant;
    if (!requireUuid(id, res)) return;

    const post = await getSocialPostByExternalId(id, tenant.siteId);
    if (!post) {
      return sendError(res, 404, "Post non trovato");
    }

    const deleted = await deleteSocialPost(tenant.siteId, post.id);
    if (!deleted) {
      return sendError(res, 409, "Post non può essere eliminato (già pubblicato)");
    }

    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

export default router;
