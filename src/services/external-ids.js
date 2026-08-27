import { query } from "../db.js";

// ─────────────────────────────────────────────────────────────────────────
// Identificatori esterni (UUID) per-risorsa, in vista del clone API totale
// (docs/API_CLONE_MASTER_PLAN.md §4.2). Le PK interne (SERIAL) non vanno mai
// esposte fuori dal CMS: le API esterne devono usare `external_id`.
//
// Assegnazione lazy: l'external_id viene generato alla prima richiesta
// (ensureExternalId), non a tutte le righe esistenti in un colpo solo.
//
// WHITELIST_TABLES è la difesa contro SQL injection: `table` arriva sempre
// da codice interno (mai da input utente diretto), ma i nomi tabella non
// sono parametrizzabili in SQL — la whitelist garantisce che solo nomi
// noti/validati finiscano in una query interpolata.
// ─────────────────────────────────────────────────────────────────────────

export const WHITELIST_TABLES = {
  sites: true,
  contacts: true,
  contact_notes: true,
  tasks: true,
  opportunities: true,
  pipelines: true,
  pipeline_stages: true,
  custom_fields: true,
  custom_field_folders: true,
  tags: true,
  workflows: true,
  segments: true,
  forms: true,
  form_submissions: true,
  quizzes: true,
  quiz_submissions: true,
  quotes: true,
  payment_links: true,
  conversations: true,
  conversation_messages: true,
  newsletter_campaigns: true,
  newsletter_sequences: true,
  newsletter_subscribers: true,
  tracked_links: true,
  users: true,
  webhooks: true,
  booking_appointments: true,
  calendars: true,
  email_templates: true,
  campaign_subscriptions: true,
  marketing_templates: true,
  surveys: true,
  survey_pages: true,
  survey_questions: true,
  survey_submissions: true,
  agencies: true,
  teams: true,
  team_members: true,
  user_locations: true,
  oauth_provider_apps: true,
  oauth_provider_codes: true,
  oauth_provider_tokens: true,
  products: true,
  product_prices: true,
  coupons: true,
  invoices: true,
  invoice_items: true,
  media_files: true,
  object_definitions: true,
  object_records: true,
  object_associations: true,
  memberships: true,
  courses: true,
  enrollments: true,
  social_accounts: true,
  social_posts: true,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertWhitelisted(table) {
  if (!WHITELIST_TABLES[table]) {
    throw new Error(`Tabella non autorizzata per external_id: ${table}`);
  }
}

export async function ensureExternalId(table, id) {
  assertWhitelisted(table);

  const updated = (await query(
    `UPDATE ${table} SET external_id = gen_random_uuid()
     WHERE id = $1 AND external_id IS NULL
     RETURNING external_id`,
    [id]
  )).rows[0];
  if (updated) return updated.external_id;

  const existing = (await query(
    `SELECT external_id FROM ${table} WHERE id = $1`,
    [id]
  )).rows[0];
  return existing ? existing.external_id : null;
}

export async function getExternalId(table, id) {
  return ensureExternalId(table, id);
}

export async function findByExternalId(table, externalId) {
  assertWhitelisted(table);

  if (typeof externalId !== "string" || !UUID_RE.test(externalId)) {
    const err = new Error("Identificatore non valido");
    err.status = 400;
    throw err;
  }

  const row = (await query(
    `SELECT * FROM ${table} WHERE external_id = $1 LIMIT 1`,
    [externalId]
  )).rows[0];
  return row || null;
}
