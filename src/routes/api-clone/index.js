import { Router } from "express";
import { apiDialect } from "../../middleware/api-dialect.js";
import publicOauthProviderRoutes from "../public-oauth-provider.js";

// ─────────────────────────────────────────────────────────────────────────
// Router clone: montato ROOT-LEVEL sul vhost API dedicato (sites.api_domain,
// vedi middleware/api-host.js). Le risorse reali (contacts, opportunities,
// calendars, ...) arrivano nelle onde successive del piano — vedi
// docs/API_CLONE_MASTER_PLAN.md §5. Questo file resta uno skeleton.
// ─────────────────────────────────────────────────────────────────────────

const router = Router();

// Health check PRIMA del dialetto: non richiede tenant/auth, coerente con
// l'uso tipico (probe di readiness) e con GET /health del target.
router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "api" });
});

// Endpoint OAuth PROVIDER veri (authorize/decision/token/userinfo/revoke —
// src/routes/public-oauth-provider.js) PRIMA del dialetto tenant: hanno auth
// propria (requireAuth con token agente per /authorize/decision, client_id/
// client_secret o access_token per gli altri) e non c'entrano con la site
// API key del resto del clone. Montati qui (mai prima, file orfano — bug
// trovato col compat-harness, 2026-09-08: /oauth/apps (api-clone/oauth.js)
// esisteva, ma authorize/decision/token/userinfo/revoke rispondevano 401
// perché finivano tutti dentro l'apiDialect() sotto, che non riconosce un
// token agente né client_id/client_secret).
router.use(publicOauthProviderRoutes);

// Da qui in poi ogni richiesta è tenant-scoped: risolve req.tenant/req.apiDialect
// (ed eventualmente req.apiVersion) o risponde 401/400 da sé.
router.use(apiDialect());

// ── Risorse (Onda A) ─────────────────────────────────────────────────────
import contactsCloneRoutes from "./contacts.js";
import opportunitiesCloneRoutes from "./opportunities.js";
import tagsCloneRoutes from "./tags.js";
import customFieldsCloneRoutes from "./custom-fields.js";

router.use(contactsCloneRoutes);
router.use(opportunitiesCloneRoutes);
router.use(tagsCloneRoutes);
router.use(customFieldsCloneRoutes);

// ── Risorse (Onde B/C/E) ────────────────────────────────────────────────
import formsCloneRoutes from "./forms.js";
import calendarsCloneRoutes from "./calendars.js";
import campaignsCloneRoutes from "./campaigns.js";

router.use(formsCloneRoutes);
router.use(calendarsCloneRoutes);
router.use(campaignsCloneRoutes);

// ── Risorse (Onde D/F/G) ────────────────────────────────────────────────
import surveysCloneRoutes from "./surveys.js";
import conversationsCloneRoutes from "./conversations.js";
import usersCloneRoutes from "./users.js";
import oauthCloneRoutes from "./oauth.js";

router.use(surveysCloneRoutes);
router.use(conversationsCloneRoutes);
router.use(usersCloneRoutes);
router.use(oauthCloneRoutes);

// ── Risorse (Onda H) ────────────────────────────────────────────────────
import productsCloneRoutes from "./products.js";
import invoicesCloneRoutes from "./invoices.js";
import mediaCloneRoutes from "./media.js";
import objectsCloneRoutes from "./objects.js";
import socialCloneRoutes from "./social.js";
import membershipsCloneRoutes from "./memberships.js";

router.use(productsCloneRoutes);
router.use(invoicesCloneRoutes);
router.use(mediaCloneRoutes);
router.use(objectsCloneRoutes);
router.use(socialCloneRoutes);
router.use(membershipsCloneRoutes);

// Catch-all: qualunque path non riconosciuto su questo vhost è 404 JSON,
// non deve MAI ricadere sulle altre route del CMS (pagine pubbliche/admin).
router.use((req, res) => {
  res.status(404).json({ statusCode: 404, message: "Endpoint non trovato" });
});

export default router;
