import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import expressLayouts from "express-ejs-layouts";
import rateLimit from "express-rate-limit";
import config from "./config.js";
import { logger } from "./services/logger.js";
import { requestId } from "./middleware/request-id.js";
import { csrfProtection } from "./middleware/csrf.js";
import { i18nMiddleware } from "./middleware/i18n.js";
import { attachEnabledModules } from "./middleware/modules.js";
import { Router as _adminRouter } from "express";

const adminAgentBuilderRouter = _adminRouter();

import authRoutes from "./routes/auth.js";
import i18nRoutes from "./routes/i18n.js";
import sitesRoutes from "./routes/sites.js";
import usersRoutes from "./routes/users.js";
import pagesRoutes from "./routes/pages.js";
import snippetsRoutes from "./routes/snippets.js";
import serveRoutes, { publicCatchAllRouter } from "./routes/serve.js";
import settingsRoutes from "./routes/settings.js";
import agentRoutes from "./routes/agent.js";
import mediaRoutes from "./routes/media.js";
// Media PROTETTI: serviti SOLO via route Express con autorizzazione. NON
// montare mai express.static su questa cartella (vedi media-protected.js).
import mediaProtectedRoutes from "./routes/media-protected.js";
import formsRoutes from "./routes/forms.js";
import quizzesRoutes from "./routes/quizzes.js";
import adminCrmRoutes from "./routes/admin-crm.js";
import adminClientServicesRoutes from "./routes/admin-client-services.js";
import callRecordingsRoutes from "./routes/call-recordings.js";
import { registerAdminAgentBuilderRoutes } from "./routes/admin-agent-builder.js";
registerAdminAgentBuilderRoutes(adminAgentBuilderRouter);
import adminDashboardRoutes from "./routes/admin-dashboard.js";
import { publicWebhookRouter } from "./routes/public-webhooks.js";
import { publicOauthRouter } from "./routes/public-oauth.js";
import { publicPaymentsRouter } from "./routes/public-payments.js";
import { publicTrackedLinksRouter } from "./routes/public-tracked-links.js";
import contactsRoutes from "./routes/contacts.js";
import apiTokensRoutes from "./routes/api-tokens.js";
import pipelineRoutes from "./routes/pipeline.js";
import callsRoutes from "./routes/calls.js";
import gettingStartedRoutes from "./routes/getting-started.js";
import templatesAdminRoutes from "./routes/templates-admin.js";
import analyticsRoutes from "./routes/analytics.js";
import newsletterRoutes from "./routes/newsletter.js";
import mcpRoutes from "./routes/mcp.js";
import trackingRoutes from "./routes/tracking.js";
import preferencesRoutes from "./routes/preferences.js";
import quotesRoutes from "./routes/quotes.js";
import { startScheduler } from "./services/scheduler.js";

// message è una funzione (non un oggetto statico): express-rate-limit la
// valuta per ogni richiesta, quindi res.locals.t (impostato da
// i18nMiddleware, montato globalmente prima di questi limiter) è disponibile.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: (req, res) => ({ error: res.locals.t("api.auth.tooManyLoginAttempts") }),
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: (req, res) => ({ error: res.locals.t("api.auth.tooManyVerifyAttempts") }),
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter aggiuntivi per account/link target (non solo per IP sorgente): senza
// questi, un attaccante che ruota IP potrebbe generare/tentare magic-link e OTP
// illimitati contro lo stesso account, aggirando il limite per-IP sopra.
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body?.email || "").toLowerCase().trim() || req.ip,
  message: (req, res) => ({ error: res.locals.t("api.auth.tooManyLoginAttempts") }),
  standardHeaders: true,
  legacyHeaders: false,
});

const verifyAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => (req.body?.token || "").trim() || req.ip,
  message: (req, res) => ({ error: res.locals.t("api.auth.tooManyVerifyAttempts") }),
  standardHeaders: true,
  legacyHeaders: false,
});

const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // Il proxy MCP (mcp-tools.js) fa fetch interni a 127.0.0.1 per ogni tool
  // call: prima condividevano il bucket per-IP di TUTTI i client → ~120 tool
  // call/min totali = 429 per chiunque (interferenza cross-tenant). Il proxy
  // è già rate-limited sull'endpoint /api/mcp; il loopback va esentato.
  skip: (req) => {
    const ip = req.ip || "";
    return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  },
  message: (req, res) => ({ error: res.locals.t("api.common.tooManyRequests") }),
});

const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const newsletterSubscribeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: (req, res) => ({ error: res.locals.t("api.common.tooManyAttemptsPerMinute") }),
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter per-email sul subscribe pubblico: con la sola rotazione IP un
// attaccante poteva generare email di conferma illimitate verso una vittima
// (email bombing) compilando il form con la sua email.
const newsletterSubscribeAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => (req.body?.email || "").toLowerCase().trim() || req.ip,
  message: (req, res) => ({ error: res.locals.t("api.common.tooManyAttemptsPerMinute") }),
  standardHeaders: true,
  legacyHeaders: false,
});

const rewriteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: (req, res) => ({ error: res.locals.t("api.pages.rewriteTooManyRequests") }),
  standardHeaders: true,
  legacyHeaders: false,
});

if (!config.jwtSecret || !config.databaseUrl) {
  logger.error("FATAL: JWT_SECRET e DATABASE_URL devono essere configurati");
  process.exit(1);
}

async function start() {
  const app = express();

  app.set("trust proxy", 1);

  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser());
  app.use(requestId);
  // i18n PRIMA di csrfProtection: il middleware CSRF usa res.locals.t nei
  // percorsi di errore — montato dopo, una violazione CSRF esplodeva in
  // TypeError → 500 al posto del 403 previsto (index.js:139 montava csrf
  // prima di i18nMiddleware).
  app.use(i18nMiddleware);
  app.use(express.urlencoded({ extended: false, limit: "50mb" }));
  app.use(express.json({ limit: "50mb" }));
  app.use(csrfProtection);

  // Session ID per statistiche page views
  app.use((req, res, next) => {
    if (!req.cookies?.session_id) {
      const sessionId = crypto.randomUUID();
      res.cookie("session_id", sessionId, { maxAge: 30 * 24 * 3600000, httpOnly: true, sameSite: "lax", secure: config.nodeEnv === "production" });
      req.cookies = req.cookies || {};
      req.cookies.session_id = sessionId;
    }
    next();
  });

  app.use((req, _res, next) => {
    const token = req.cookies?.token;
    if (token) {
      try { req.user = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }); } catch { req.user = null; }
    }
    next();
  });

  app.set("view engine", "ejs");
  app.set("views", new URL("../views", import.meta.url).pathname);
  app.use(expressLayouts);

  app.use(express.static(new URL("../public", import.meta.url).pathname));
  app.use("/media", express.static(new URL("../media", import.meta.url).pathname));

  app.use(async (req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.path = req.path;
    res.locals.site = null;
    // Host header poisoning: req.get("host") è controllabile dall'attaccante
    // (con trust proxy deriva anche da X-Forwarded-Host). Un Host: evil.com
    // finiva in res.locals.baseUrl → URL manipolati mostrati agli admin
    // (phishing). Stessa regex di serve.js resolvePublicBaseUrl: hostname
    // plausibile, altrimenti fallback su magicLinkBaseUrl configurato.
    const hostHeader = String(req.get("host") || "").trim();
    res.locals.baseUrl = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/i.test(hostHeader)
      ? `${req.protocol}://${hostHeader}`
      : config.magicLinkBaseUrl;
    // Escape per attributi HTML (usato in srcdoc="..." e value="..."): blocca
    // la chiusura dell'attributo con " o ' e l'iniezione di markup.
    res.locals.escapeAttr = (v) => String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    res.locals.app = {
      name: config.appName,
      tagline: config.appTagline,
      logoText: config.appLogoText,
      adminTitle: config.adminTitle,
    };
    next();
  });

  app.use("/admin", (req, res, next) => {
    const originalRender = res.render.bind(res);
    res.render = function(view, options = {}) {
      if (typeof options.layout === "undefined") {
        options.layout = "layouts/admin";
      }
      return originalRender(view, options);
    };
    next();
  });
  app.use("/admin", attachEnabledModules);
  app.use("/admin/pages", previewLimiter);
  app.use("/admin/pages/rewrite", rewriteLimiter);
  app.use("/api/auth/login", loginLimiter, loginAccountLimiter);
  app.use("/api/auth/verify", verifyLimiter, verifyAccountLimiter);
  app.use("/api/agent/verify-otp", verifyLimiter, verifyAccountLimiter);

  app.use("/api/agent", agentLimiter);
  app.use("/api/mcp", agentLimiter);
  app.use(authRoutes);
  app.use(i18nRoutes);
  app.use(serveRoutes);
  app.use(sitesRoutes);
  app.use(usersRoutes);
  app.use(pagesRoutes);
  app.use(snippetsRoutes);
  app.use(settingsRoutes);
  app.use(mediaRoutes);
  // Route dei media protetti: unico accesso alla cartella media-protected/
  // (deny by default: 401 senza utente, 403 senza ruolo admin). NON esiste
  // alcun express.static per media-protected — se ne serve uno, NON farlo.
  app.use(mediaProtectedRoutes);
  app.use(formsRoutes);
  app.use(quizzesRoutes);
  app.use(adminCrmRoutes);
  app.use(callRecordingsRoutes);
  app.use(adminClientServicesRoutes);
  app.use(adminAgentBuilderRouter);
  app.use(adminDashboardRoutes);
  app.use(publicWebhookRouter);
  app.use(publicOauthRouter);
  app.use(publicPaymentsRouter);
  app.use(publicTrackedLinksRouter);
  app.use(contactsRoutes);
  app.use(apiTokensRoutes);
  app.use(pipelineRoutes);
  app.use(callsRoutes);
  app.use(gettingStartedRoutes);
  app.use(templatesAdminRoutes);
  app.use(analyticsRoutes);
  app.use("/newsletter/:siteId/subscribe", newsletterSubscribeLimiter, newsletterSubscribeAccountLimiter);
  app.use(newsletterRoutes);
  app.use(mcpRoutes);
  app.use(trackingRoutes);
  app.use(preferencesRoutes);
  app.use(quotesRoutes);
  app.use(agentRoutes);

  // Sempre per ultimo: risolve qualunque path residuo come pagina del sito
  // pubblico e non passa mai il controllo oltre (vedi routes/serve.js).
  app.use(publicCatchAllRouter);

  app.use((req, res) => {
    if (req.path.startsWith("/api")) return res.status(404).json({ error: "Endpoint non trovato" });
    res.redirect("/");
  });

  app.use((err, req, res, _next) => {
    if (config.nodeEnv === "production") {
      logger.error(`[ERROR] ${req.method} ${req.path}: ${err.message}`);
    } else {
      console.error(err);
    }
    // Errore di cast Postgres su input non numerico (es. /sites/1/pages/abc):
    // è un 404 (risorsa inesistente), non un 500. Copre tutte le route con
    // :id non validati senza dover validare a mano ogni parametro.
    if (err.code === "22P02") {
      if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: res.locals.t("api.common.notFound") });
      }
      return res.status(404).render("error", { message: res.locals.t("api.common.notFound"), layout: req.path.startsWith("/admin") ? "layouts/admin" : false });
    }
    if (req.path.startsWith("/api")) {
      return res.status(err.status || 500).json({ error: res.locals.t("api.common.internalError") });
    }
    // In produzione non esporre mai err.message (percorsi file, dettagli
    // infrastruttura, messaggi Postgres/ffmpeg/Whisper). Solo in dev è utile.
    const safeMessage = config.nodeEnv === "production"
      ? res.locals.t("api.common.internalError")
      : (err.message || res.locals.t("api.common.internalError"));
    res.status(err.status || 500).render("error", { message: safeMessage, layout: req.path.startsWith("/admin") ? "layouts/admin" : false });
  });

  app.listen(config.port, () => {
    logger.info(`${config.appName} service running on port ${config.port}`);
    startScheduler();
  });
}

start().catch(err => {
  logger.error("Failed to start server", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});
