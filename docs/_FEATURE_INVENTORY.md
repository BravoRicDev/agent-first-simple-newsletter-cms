# Feature Inventory — Documentation Coverage Checklist

## Legend
- ✅ Documented in README
- 🔄 Partially documented (needs update)
- ❌ Not documented

## Admin Panel Features

| Feature | Route | Route File | README.md | README.it.md |
|---------|-------|------------|-----------|--------------|
| ✅ Dashboard KPIs | GET /admin/dashboard | admin-dashboard.js | ✅ | ✅ |
| ✅ Sites management | /admin/sites* | sites.js | ✅ | ✅ |
| ✅ Pages CRUD | /admin/pages* | pages.js | ✅ | ✅ |
| ✅ Pages: publish toggle, inline-to-files, extract-assets | POST /admin/pages/:id/* | pages.js | ✅ | ✅ |
| ✅ Pages: social posts | POST /admin/pages/:pageId/social | pages.js | ✅ | ✅ |
| ✅ Snippets CRUD | /admin/snippets* | snippets.js | ✅ | ✅ |
| ✅ Templates CRUD | /admin/templates* | templates-admin.js | ✅ | ✅ |
| ✅ Media library | /admin/media* | media.js | ✅ | ✅ |
| ✅ Media: protected | /admin/media-protected* | media-protected.js | 🔄 | 🔄 |
| ✅ Forms CRUD | /admin/forms* | forms.js | ✅ | ✅ |
| ✅ Forms: submissions, CSV export | /admin/forms/:slug/submissions | forms.js | ✅ | ✅ |
| ✅ Quizzes builder | /admin/quizzes* | quizzes.js | ✅ | ✅ |
| ✅ Segments | /admin/segments | admin-crm.js | ✅ | ✅ |
| ✅ Workflows | /admin/workflows | admin-crm.js | ✅ | ✅ |
| ✅ Tasks | /admin/tasks | admin-crm.js | ✅ | ✅ |
| ✅ Funnel | /admin/funnel | admin-crm.js | ✅ | ✅ |
| ✅ Conversations | /admin/conversations | admin-crm.js | ✅ | ✅ |
| ✅ Contacts | /admin/contacts* | contacts.js | ✅ | ✅ |
| ✅ Pipeline (Kanban) | /admin/pipeline | pipeline.js | ✅ | ✅ |
| ✅ Calls | /admin/calls* | calls.js | ✅ | ✅ |
| ✅ Call recordings | /admin/call-recordings* | call-recordings.js | ✅ | ✅ |
| ✅ Opportunities + board | /admin/opportunities* | crm-agent.js | ✅ | ✅ |
| ✅ Quotes | /admin/quotes* | quotes.js | ✅ | ✅ |
| ✅ Newsletter subscribers/campaigns/sequences/templates/settings | /admin/newsletter* | newsletter.js | ✅ | ✅ |
| ✅ Social poster (stub) | /admin/social | admin/social/view | ✅ | ✅ |
| ✅ Users CRUD | /admin/users* | users.js | ✅ | ✅ |
| ✅ API tokens | /admin/api-tokens* | api-tokens.js | ✅ | ✅ |
| ❌ Protected access / Access grants | /admin/access-grants* | access-grants.js | ❌ | ❌ |
| ✅ Analytics | /admin/analytics | analytics.js | ✅ | ✅ |
| ✅ Settings | /admin/settings* | settings.js | ✅ | ✅ |
| ✅ Imports | /admin/import | admin-import.js | 🔄 | 🔄 |
| ✅ Audit log | /admin/audit | sites.js | ✅ | ✅ |
| ✅ Getting started | /admin/getting-started | getting-started.js | ✅ | ✅ |
| ✅ Preferences | /admin/preferences | preferences.js | ✅ | ✅ |
| ❌ Page tracking overrides | /admin/settings/tracking | settings.js | 🔄 | 🔄 |
| ❌ Sandbox scenarios | Admin UI | - | ❌ | ❌ |
| ❌ HITL / Approvals | - | agent-hitl.js | ❌ | ❌ |
| ❌ Agent builder | /admin/agent-builder* | admin-agent-builder.js | ❌ | ❌ |

## Agent API Features (/api/agent)

| Feature | Route | Route File | Documented in AGENT.md? |
|---------|-------|------------|----------------------|
| ✅ Auth & identity | /api/agent/me | auth.js | ✅ |
| ✅ Site listing | /api/agent/sites | agent.js | ✅ |
| ✅ Pages (search, bulk, edit, rewrite, etc.) | /api/agent/sites/:siteId/pages* | agent.js | ✅ |
| ✅ Snippets | /api/agent/sites/:siteId/snippets | agent.js | ✅ |
| ✅ Templates | /api/agent/sites/:siteId/templates | agent.js | ✅ |
| ✅ Media | /api/agent/sites/:siteId/media* | agent.js | ✅ |
| ✅ Site variables | /api/agent/sites/:siteId/variables | agent.js | ✅ |
| ✅ Redirects | /api/agent/sites/:siteId/redirects | agent.js | ✅ |
| ✅ Forms | /api/agent/sites/:siteId/forms | agent.js | ✅ |
| ✅ Social posts | /api/agent/sites/:siteId/social-posts | agent.js | ✅ |
| ✅ SEO | /api/agent/sites/:siteId/seo | agent.js | ✅ |
| ❌ Dashboard KPIs | /api/agent/sites/:siteId/dashboard/* | agent-dashboard.js | ❌ |
| ❌ Sandbox | /api/agent/sites/:siteId/sandbox/* | agent-sandbox.js | ❌ |
| ❌ Approvals (HITL) | /api/agent/sites/:siteId/approvals* | agent-hitl.js | ❌ |
| ❌ Agent builder/definitions | /api/agent/sites/:siteId/agent-* | agent-builder.js | ❌ |
| ❌ KB (knowledge base) | /api/agent/sites/:siteId/kb* | agent-kb.js | ❌ |
| ❌ Reply suggestions | /api/agent/sites/:siteId/reply-suggestions* | agent-suggestions.js | ❌ |
| ❌ Source sync | /api/agent/sites/:siteId/source-sync/* | agent-source-sync.js | ❌ |
| ❌ Calendar sync | /api/agent/sites/:siteId/calendar-sync* | agent-calendar-sync.js | ❌ |
| ❌ Call summaries | /api/agent/sites/:siteId/call-summaries* | agent-callsummaries.js | ❌ |
| ❌ Client services | /api/agent/sites/:siteId/services-catalog, /clients | agent-client-services.js | ❌ |
| ❌ RBAC (roles, shifts) | /api/agent/sites/:siteId/roles, /shifts | agent-rbac.js | ❌ |
| ❌ Recurring/followups | /api/agent/sites/:siteId/recurring-*, /followup-*-rules | agent-recurring.js | ❌ |
| ❌ Reports | /api/agent/sites/:siteId/report-configs* | agent-reports.js | ❌ |
| ❌ Limits | /api/agent/sites/:siteId/channel-limits, /usage | agent-limits.js | ❌ |
| ❌ Payments | /api/agent/sites/:siteId/payment-links* | agent-payments.js | ❌ |
| ❌ OAuth apps | /api/agent/sites/:siteId/oauth* | agent-oauth.js | ❌ |
| ❌ Webhooks mgmt | /api/agent/sites/:siteId/webhooks* | agent-webhooks.js | ❌ |
| ❌ Tracked links | /api/agent/sites/:siteId/tracked-links* | agent-tracked-links.js | ❌ |
| ❌ Access grants | /api/agent/sites/:siteId/access-grants* | agent-access-grants.js | ❌ |
| ❌ Export/import | /api/agent/sites/:siteId/data-export, /data-import | agent-export.js | ❌ |
| ❌ CRM (segments, workflows details) | /api/agent/sites/:siteId/segments*, /workflows | crm-agent.js | ❌ |
| ❌ Page tracking override | /api/agent/page-tracking | agent.js | ❌ |

## v1 API Features (/v1)

| Feature | Route | Documented in README? |
|---------|-------|----------------------|
| ✅ Custom fields | /v1/custom-fields | ✅ |
| ✅ Pipelines | /v1/pipelines | ✅ |
| ✅ Config | /v1/config | ✅ |
| ✅ Contacts | /v1/contacts | ✅ |
| ✅ Opportunities | /v1/opportunities | ✅ |
| ✅ Quotes | /v1/quotes | ✅ |
| ✅ Segments | /v1/segments | ✅ |
| ✅ Workflows | /v1/workflows | ✅ |
| ✅ Bookings | /v1/bookings | ✅ |
| ✅ Booking calendar config | /v1/booking-calendar-config | ✅ |
| ✅ Payment links | /v1/payment-links | ✅ |
| ✅ Conversations | /v1/conversations | ✅ |
| ✅ Dashboard | /v1/dashboard | ✅ |
| ✅ Funnel | /v1/funnel | ✅ |
| ✅ Activities | /v1/activities | ✅ |
| ✅ Email stats | /v1/email-stats | ✅ |
| ✅ Reports | /v1/reports | ✅ |
| ✅ Import | /v1/import | ✅ |
| ✅ API keys | /v1/api-keys | ✅ |
| ✅ Capabilities | /v1/capabilities | ✅ |
| ✅ Location mapping | /v1/location | ✅ |

## Satellite/Public APIs

| Feature | Route | Route File | Documented? |
|---------|-------|------------|-------------|
| ✅ Protected access | /shared/:token | access-grants-public.js | ✅ |
| ✅ Public forms | /forms/:siteId/:formSlug | forms.js | ✅ |
| ✅ Public booking | /book/:siteId/:calendarSlug | booking-public.js | ✅ |
| ✅ Public tracked links | /l/:token | public-tracked-links.js | 🔄 |
| ✅ Public payments | /pay/:token | public-payments.js | ✅ |
| ✅ Public webhooks | /webhooks/in/:siteId/:token | public-webhooks.js | ✅ |
| ✅ Public OAuth | /oauth/* | public-oauth.js | ✅ |
| ✅ v1 OpenAPI docs | /v1/openapi.json, /v1/docs | v1.js, openapi.js | ✅ |
| ✅ MCP server | /api/mcp | mcp.js, mcp-tools.js | ✅ |
| ✅ Agent guide | /api/agent/guide | agent.js | ✅ |

## Security Features

| Feature | Documented? |
|---------|-------------|
| ✅ RBAC (3 roles, granular permissions) | ✅ |
| ✅ CSRF protection (Origin/Referer) | ✅ (ARCHITECTURE.md) |
| ✅ SSRF guard (safeFetch + assertPublicHttpUrl) | ✅ (ARCHITECTURE.md) |
| ✅ Rate limiting (per IP + per account) | ✅ |
| ✅ JWT with token_version rotation | ✅ |
| ✅ SQL injection prevention | ✅ (ARCHITECTURE.md) |
| ✅ XSS prevention (EJS auto-escape + JSON.stringify) | ✅ (ARCHITECTURE.md) |
| ✅ SVG sanitization | 🔄 (mentioned in code comments) |
| ✅ OTP brute force protection | ✅ |
| ✅ Self-lockout prevention | ✅ |
| ❌ Host header validation | ❌ |
| ❌ Cookie flags (secure, httpOnly, sameSite) | 🔄 |
| ❌ File upload magic bytes verification | ❌ |
| ❌ Open redirect prevention | 🔄 |

## Key Missing Documentation Gaps:
1. Protected access / Access grants feature needs to be added to both READMEs
2. Source sync feature needs to be documented
3. Agent builder, sandbox, HITL/approvals need documentation
4. Tracked links admin feature needs better documentation
5. Page tracking overrides need documentation
6. Italian translations of docs/ARCHITECTURE.md, docs/SETUP.md, docs/OPENAPI_SPEC.md
7. Italian translations of docs/GAP-ANALYSIS-*.md
