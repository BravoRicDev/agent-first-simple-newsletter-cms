import dotenv from "dotenv";
dotenv.config();

export default {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",

  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "24h",

  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: parseInt(process.env.SMTP_PORT || "465", 10),
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  emailFrom: process.env.EMAIL_FROM || "",

  magicLinkBaseUrl: process.env.MAGIC_LINK_BASE_URL || "http://localhost:3000",
  magicLinkExpiryMs: 15 * 60 * 1000,

  logLevel: process.env.LOG_LEVEL || "info",

  appName: process.env.APP_NAME || "CMS Multi-sito",
  appTagline: process.env.APP_TAGLINE || "",
  footerTagline: process.env.FOOTER_TAGLINE || "",
  appLogoText: process.env.APP_LOGO_TEXT || "CMS",
  adminTitle: process.env.ADMIN_TITLE || "Pannello di amministrazione",
  siteDefaultBrand: process.env.SITE_DEFAULT_BRAND || "Il mio sito",
  defaultLang: process.env.DEFAULT_LANG || "it",

  staticExportEnabled: process.env.STATIC_EXPORT_ENABLED !== "false",

  backupEnabled: process.env.BACKUP_ENABLED !== "false",
  backupRetentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || "14", 10),

  // Chiave OpenAI "letterale" — usata dove si chiama direttamente un endpoint
  // OpenAI specifico non astraibile dietro LLM_BASE_URL (es. Whisper per la trascrizione).
  openaiApiKey: process.env.OPENAI_API_KEY || "",

  // Trascrizione audio chiamate (feature call-recordings): Groq Whisper come
  // trascrittore primario (whisper-large-v3), fallback su OPENAI_API_KEY
  // (whisper-1) se Groq non configurata o fallisce.
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqBaseUrl: process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1",
  whisperModel: process.env.WHISPER_MODEL || "whisper-large-v3",
  // Retention audio: giorni dopo i quali l'audio viene eliminato tenendo solo
  // trascrizione+verdetto (minimizzazione dati personali). 0 = mai.
  audioRetentionDays: parseInt(process.env.AUDIO_RETENTION_DAYS || "0", 10),

  // Chiave segreta Stripe per i link di pagamento (feature 38): se valorizzata
  // i payment link vengono creati su Stripe, altrimenti la pagina pubblica
  // /pay/:token resta in modalità conferma simulata.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",

  // Provider LLM astratto usato da services/llm.js (rewrite testo, alt-text immagini):
  // LLM_API_KEY ha priorità, con fallback a OPENAI_API_KEY per non rompere le config esistenti.
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  llmModel: process.env.LLM_MODEL || "gpt-4o-mini",
  llmApiKey: process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "",

  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID || "",
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || "",
  deployWebhookUrl: process.env.DEPLOY_WEBHOOK_URL || "",

  twitterBearerToken: process.env.TWITTER_BEARER_TOKEN || "",
  linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN || "",
  facebookPageToken: process.env.FACEBOOK_PAGE_TOKEN || "",
};
