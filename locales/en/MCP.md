# MCP — Model Context Protocol

The CMS also exposes an MCP server (Streamable HTTP) as an alternative to using the agent REST API directly. **It covers exactly the same functionality as [`AGENT.md`](AGENT.md)** — it's the same `/api/agent/...` seen through a different protocol, not a separate system: every MCP tool makes an internal call to the corresponding REST route, same code, same logic, same authorization. An endpoint added or removed from `agent.js` automatically appears/disappears as a tool when the service restarts, no manual update needed — the two surfaces cannot drift out of sync.

## Connecting

- **Endpoint**: `POST https://<cms-domain>/api/mcp` (Streamable HTTP transport, stateless — no session to manage).
- **Authentication**: the same agent JWT token used for the REST API (`Authorization: Bearer <token>`), obtained via the flow described in `AGENT.md` (`POST /api/auth/login` → OTP → `POST /api/agent/verify-otp`). An MCP client that supports a static `Authorization` header works with no other setup.
- Without a valid token: `401` (not an HTML redirect — mounting under `/api/mcp` guarantees a JSON response even for non-browser clients).

## Tool set

312 tools, one for each existing `/api/agent/...` endpoint, with readable names and schemas (e.g. `pages_find_replace`, `newsletter_campaigns_send`, `media_upload`, `calendars_list`, `quizzes_create`, `segments_create`, `workflows_create`, `scoring_rules_create`, `tasks_create`, `contact_merge`, `pipelines_list`, `contact_note_add`, `conversation_message_send`, `opportunities_create`, `quotes_create`, `recurring_tasks_list`, `followup_rules_create`, `crm_create_role`, `agent_runtime_process`, `kb_search`, `agent_definition_test`, `approvals_approve`, `call_summary_generate`, `reply_suggestions_generate`, `webhook_create`, `oauth_get_auth_url`, `calendar_sync_run`, `payment_links_create`, `crm_export_data`, `crm_get_dashboard_kpis`, `crm_send_report`, `sandbox_run`, `backup_job_run`, `channel_limits_consume`, `clients_list`, `client_services_set`, `client_access_check`). For an endpoint added in the future without a dedicated name/schema, the tool still exists with a generic schema (path fields recognized individually, the rest in an `extra` object) — never missing, just less convenient to use until someone adds it a dedicated entry in `src/services/mcp-tools.js`.

The operating rules (NEVER loop, prefer bulk/find-replace, don't unpublish while working, etc.) are the same ones in `AGENT.md` — they apply identically regardless of which protocol you use to call them.

## Technical details (for anyone touching the code)

- `src/services/mcp-tools.js`: introspection of the `agent.js` router (`agentRouter.stack`) + the `TOOL_META` enrichment table + the generic proxy handler.
- `src/routes/mcp.js`: mounts `/api/mcp`, a fresh `McpServer` + transport for every request (no shared state).
- The proxy forwards the original `Authorization` header to the internal call (`http://127.0.0.1:<port>/api/agent/...`) — same identity, no new authentication mechanism to maintain.
- Binary responses (e.g. the backup ZIP) arrive as a base64 `resource` content block, not as text.
