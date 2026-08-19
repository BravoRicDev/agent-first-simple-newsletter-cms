# Architecture — Gestione Siti CMS

A comprehensive multi-tenant CMS for email newsletter automation, CRM, and sales pipeline management, built on Node.js + Express + PostgreSQL.

## Core Concepts

### Multi-tenant by Site
The CMS manages multiple independent websites (`sites` table), each with:
- Multiple associated domains (`site_domains`)
- Isolated content, contacts, and settings (via `site_id` on all tables)
- Per-site modules (CRM features can be enabled/disabled)
- Per-site branding and variables (`site_variables`)

### Authorization Model
- **RBAC**: Three roles (`superadmin`, `admin`, `collaboratore`) with granular per-resource permissions (`src/constants/permissions.js`)
- **Magic-link + OTP**: No passwords; email-based authentication with HMAC-signed tokens and rate limiting

### Data-driven Events
- All significant actions emit `contact_events` (form submitted, email opened, link clicked, call completed, etc.)
- Events feed into workflows, segments, lead scoring, and dashboards

## Stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 18+ (ESM modules) |
| **HTTP** | Express.js 4.x |
| **Templates** | EJS + express-ejs-layouts |
| **Database** | PostgreSQL 16 (migrations in `db/`) |
| **Styling** | Plain CSS (no frameworks) |
| **Deployment** | Docker + docker-compose |
| **Static fallback** | Caddy reverse proxy (serves `media/`/`static/` offline) |

## Module Breakdown

### Authentication & Access Control
- **Magic link login** (`services/magic-link.js`): email-based auth, HMAC-signed tokens, rate-limited per IP/email
- **JWT tokens** (`config.js`): signed with `JWT_SECRET`, included in cookies and bearer headers
- **RBAC & authorization** (`middleware/authorize.js`, `services/rbac.js`): per-route permission checks
- **API tokens** (`routes/api-tokens.js`, `services/api-tokens.js`): long-lived tokens for integrations (n8n, webhooks)

### Content Management
- **Pages** (`routes/admin-pages.js`): versioned pages, preview, scheduled publish, redirects
- **Snippets** (`routes/admin-snippets.js`): reusable template fragments with `{{snippet:...}}` placeholder
- **Site variables** (`routes/admin-site-variables.js`): dynamic content via `{{var:...}}`
- **Media** (`routes/media.js`, `services/media-utils.js`): file upload/import, LLM alt-text generation, video compression
- **Protected media** (`routes/media-protected.js`): files served only to authenticated users or via HMAC tokens

### Page Rendering & Export
- **Live rendering** (`services/site-render.js`): resolves snippets/variables, injects SEO fields, serves HTML
- **Static export** (`services/static-export.js`): generates HTML files for all pages, served by Caddy as fallback
- **SEO** (`services/seo.js`): per-page title, meta, og-image overrides
- **Layouts** (`views/layouts/`): wrapped (CMS header/nav) vs. standalone (custom HTML template)

### Email & Newsletter
- **Email sending** (`services/email.js`): via Nodemailer (SMTP or JSON transport for dev)
- **Newsletter campaigns** (`routes/admin-newsletter-campaigns.js`): HTML/text email with template variables, scheduling
- **Newsletter sequences** (`routes/admin-newsletter-sequences.js`): multi-step automated email sequences
- **Email tracking** (`services/tracking-email.js`): open/click tracking, UTM parameters, link proxying
- **Email templates** (`services/email-templates.js`): system emails (magic link, confirmation, etc.) with per-site customization
- **Transactional email** (`services/email.js`): deployment notifications, form submissions, call reminders, etc.

### Forms & Contacts
- **Form builder** (`routes/admin-forms.js`, `services/contacts.js`): text/email/phone/dropdown/checkbox question types
- **Form submissions** → auto-create/update contacts with tags, notes, scoring
- **Contacts** (`services/contacts.js`): CRM-lite — email, name, tags, status, notes, custom fields
- **Contact search** (`routes/admin-contacts.js`): cross-form search, dedupe detection
- **Contact merge** (`services/merge.js`): merge duplicate contact records

### CRM & Sales Pipeline
- **Opportunities** (`services/opportunities.js`): draft/sent/viewed/signed quote workflow, GDPR-compliant link generation
- **Pipeline** (`services/opportunities.js`): stages (lead, qualified, proposal, won, lost) with configurable values
- **Tasks** (`services/tasks.js`): user-assigned to-dos with due dates, status tracking
- **Calls** (`services/calls.js`): log incoming/outgoing calls, attach to contacts, track availability/reminders
- **Call recordings** (`services/call-recordings.js`): upload + auto-transcribe (Whisper API), store encrypted
- **Call summaries** (`services/call-summaries.js`): AI-generated summaries of transcriptions
- **Workflows** (`services/workflows.js`): automation — trigger on event → action (email, tag, stage, task, webhook)
- **Segments** (`services/segments.js`): dynamic groups (has event X in last Y days, tag matches, etc.)
- **Scoring** (`services/scoring.js`): accumulate points per contact (form fill +10, email open +5, etc.), decay over time

### AI & Automation
- **Agent API** (`routes/agent-*.js`): dedicated endpoints for AI agents (Claude Code, OpenCode) to read/write content, media, campaigns, CRM
- **MCP server** (`routes/mcp.js`, `services/mcp-tools.js`): Model Context Protocol — same functionality exposed as tools for Claude Desktop
- **Agent runtime** (`services/agent-runtime.js`): manage agent credentials, LLM calls, conversation state
- **Agent builder** (`services/agent-builder.js`): define custom agents with prompts, tools, knowledge base
- **Knowledge base** (`services/kb.js`): document storage for agents to reference

### Analytics & Reporting
- **Tracking** (`routes/tracking.js`, `services/tracking.js`): GA4, GTM, Meta Pixel, Microsoft Clarity integration
- **Email tracking** (`services/tracking-email.js`): open/click analytics per campaign
- **Newsletter stats** (`services/newsletter-stats.js`): delivery rate, open rate, click rate per campaign
- **Dashboard** (`services/dashboard.js`): key metrics (revenue, pipeline value, lead count, etc.)
- **Reports** (`services/reports.js`): custom report builder (filters, grouping, export to PDF)
- **Funnel tracking** (`services/tasks.js`, `services/scoring.js`): channel attribution, conversion funnel

### Internationalization (i18n)
- **Localization** (`locales/it.json`, `locales/en.json`): admin interface strings
- **Multilingual docs** (`locales/en/AGENT.md`, `locales/it/AGENT.md`, `locales/en/MCP.md`, `locales/it/MCP.md`): agent and MCP documentation in English and Italian
- **Transactional email** (`services/email.js`): system emails generated in user's language

### External Integrations
- **OAuth** (`services/oauth.js`): Google login, calendar sync, drive integration
- **Social posting** (`services/social-poster.js`): stub for Twitter/LinkedIn/Facebook (currently checks token only)
- **Webhooks** (`services/webhooks.js`): outbound notifications on events (form submit, call complete, etc.)
- **Calendar sync** (`services/calendar-sync.js`): Google Calendar integration for meetings, availability
- **Payments** (`services/payments.js`): payment link generation (not full payment processing)
- **Export/import** (`services/export-import.js`): bulk export contacts/forms/campaigns as JSON

### System & Operations
- **Database migrations** (`db/migrate.js`): version control for schema changes, numbered and idempotent
- **Backup** (`services/backup.js`, `routes/admin-backup.js`): automated daily DB dumps (compressed), configurable retention
- **Scheduled tasks** (`services/scheduler.js`): runs workflows, newsletter sequences, reminders, scoring decay
- **Audit log** (`services/audit.js`): record of admin actions (pages edited, forms published, etc.)
- **Deployment webhooks** (`services/deploy.js`): notify external systems on deploy
- **Settings** (`routes/admin-settings.js`, `services/settings.js`): global (per-site) configuration (branding, tracking codes, etc.)

## Database Schema

**68 migrations** (numbered `001_schema.sql` through `068_call_recordings.sql`), covering:
- Core: sites, users, pages, snippets, media, forms
- CRM: contacts, opportunities, tasks, calls, recordings, summaries
- Email: campaigns, sequences, templates, tracking
- Automation: workflows, segments, scoring, events, conversations
- Admin: audit logs, API tokens, settings, calendar sync
- Analytics: tracking pixels, report configs, dashboard views

All with `created_at`/`updated_at` timestamps and `site_id` for multi-tenancy.

## Request Flow Example: Form Submission → Contact → Email

1. **Frontend** submits form at `/public/forms/:formId`
2. **Backend** validates, creates `form_submission` record
3. **Contact upsert** (`services/contacts.js`): find or create contact by email, merge fields, add tags
4. **Event fire** (`services/events.js`): emit `form_submitted` → triggers workflows
5. **Workflow match** (`services/workflows.js`): find workflows with `trigger: form_submitted`
6. **Actions**: send email (campaign template), add tag, change status, create task
7. **Email queue** (`services/newsletter.js`): compose with template variables, send via SMTP
8. **Tracking** (`services/tracking-email.js`): inject open/click pixel, proxied links
9. **Result** in contact timeline, dashboard metrics, analytics

## Security

- **CSRF protection** (`middleware/csrf.js`): token validation on state-changing requests
- **SSRF guard** (`services/ssrf.js`): block internal IPs in URL imports
- **Rate limiting** (`middleware/auth.js`): max 10 login attempts per IP/email per 15 min
- **JWT rotation** (`middleware/auth.js`): refresh token on login
- **SQL injection** prevention: parameterized queries (pg module)
- **XSS** prevention: EJS auto-escape, DOMPurify on user-generated HTML
- **Email injection** prevention: header parsing, CRLF stripping
- **File type validation** (`services/media-utils.js`): only allow image/video/audio/document MIME types
- **Media protection** (`routes/media-protected.js`): HMAC-signed tokens for shareable file access

## Deployment & Scaling

### Docker Compose Stack
- `gestione-siti` service: Express app (port 3000)
- `db` service: PostgreSQL 16 (port 5432)
- External networks (`edge_net`, `gestione_siti`) for multi-service coordination

### Caddy Reverse Proxy
- Separate stack (`caddy-gestito/docker-compose.yml`): serves media/static from disk
- Fallback when CMS is down (zero downtime for static content)
- SSL termination, caching, gzip compression

### Scaling Considerations
- Stateless Express (run multiple replicas, load-balanced)
- PostgreSQL connection pooling recommended for production
- Static export to S3/CDN for very large sites
- Scheduled tasks (workflows, newsletter) run on a single instance (advisory locks)

## Modifying the Architecture

### Adding a New Module
1. Create `src/routes/admin-<feature>.js` (admin interface) and/or `src/routes/api-<feature>.js` (API)
2. Create corresponding `src/services/<feature>.js` (business logic)
3. Add database migration in `db/` (numbered sequentially)
4. Add RBAC permissions to `src/constants/permissions.js`
5. Add i18n strings to `locales/it.json` and `locales/en.json`
6. Mount route in `src/index.js`

### Adding a Database Migration
```bash
# Create migration
cat > db/NNN_feature.sql << EOF
CREATE TABLE new_table (id SERIAL PRIMARY KEY, site_id INT NOT NULL, ...);
EOF

# It will auto-run on next app start (db/migrate.js)
```

### Adding Agent API Endpoints
- Add to `src/routes/agent-<feature>.js`
- Include route documentation (query params, response schema)
- MCP server auto-discovers tools via introspection
