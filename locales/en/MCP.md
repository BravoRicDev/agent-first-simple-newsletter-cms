# MCP — Model Context Protocol

The CMS also exposes an MCP server (Streamable HTTP) as an alternative to using the agent REST API directly. **It covers exactly the same functionality as [`AGENT.md`](AGENT.md)** — it's the same `/api/agent/...` seen through a different protocol, not a separate system: every MCP tool makes an internal call to the corresponding REST route, same code, same logic, same authorization. An endpoint added or removed from `agent.js` automatically appears/disappears as a tool when the service restarts, no manual update needed — the two surfaces cannot drift out of sync.

## Connecting

- **Endpoint**: `POST https://<cms-domain>/api/mcp` (Streamable HTTP transport, stateless — no session to manage).
- **Authentication**: the same agent JWT token used for the REST API (`Authorization: Bearer <token>`), obtained via the flow described in `AGENT.md` (`POST /api/auth/login` → OTP → `POST /api/agent/verify-otp`). An MCP client that supports a static `Authorization` header works with no other setup. An explicit Bearer token takes precedence over a session cookie. Write tools require a write-scope token.
- Without a valid token: `401` (not an HTML redirect — mounting under `/api/mcp` guarantees a JSON response even for non-browser clients).

## Tool Set & Discovery Flow

`tools/list` now returns ONLY 6 navigation tools: `agent_guide`, `tools_tree`, `tools_in_category`, `tools_describe`, `tools_run_read` (GET only), and `tools_run` (any tool).

Discovery flow:
1. `tools_tree`
2. `tools_in_category {category}`
3. `tools_describe {name}`
4. `tools_run_read` / `tools_run {name, args}`

All previous tools remain callable directly by name (using the same arguments as before). `GET /api/mcp` is not used. Making a request to `POST /api/mcp?tools=all` makes `tools/list` return the full flat list (annotated with `readOnlyHint`/`destructiveHint` annotations).

## Errors & Limits

- **Errors**: Unknown tool calls return an `isError` result with "Did you mean ..." suggestions and a pointer to `tools_tree`/`tools_in_category`/`tools_describe`. Invalid arguments return a list of invalid fields plus a pointer to `tools_describe`.
- **Limits**:
  - JSON-RPC batch requests are rejected (`-32600`, one request per call).
  - Rate limit: 120 requests/min per token on `/api/mcp` (in addition to per-IP limits).
  - Text responses are capped at 1,000,000 chars (truncated with a note to use limit/offset/fields).
  - Binary responses max out at 15 MB.
  - Request body max size is 50 MB (images are uploaded as base64 via the media upload tool `content_base64`, ~1.33x file size, max file 20 MB).

## Security & Audit

- An explicit Bearer token takes precedence over a session cookie.
- Every call is audit-logged (user, tool, status; arguments are not logged).
- Write tools require a write-scope token.

The operating rules (NEVER loop, prefer bulk/find-replace, don't unpublish while working, etc.) are the same ones in `AGENT.md` — they apply identically regardless of which protocol you use to call them.

## Technical details (for anyone touching the code)

- `src/services/mcp-tools.js`: introspection of the `agent.js` router (`agentRouter.stack`) + the `TOOL_META` enrichment table + the generic proxy handler.
- `src/services/mcp-tree.js`: navigation tree builder, categories, areas, and handler logic.
- `src/routes/mcp.js`: mounts `/api/mcp`, a fresh MCP `Server` + transport for every request (no shared state), rate limiting, batch rejection, and authentication precedence.
- The proxy forwards the original `Authorization` header to the internal call (`http://127.0.0.1:<port>/api/agent/...`) — same identity, no new authentication mechanism to maintain.
- Binary responses (e.g. the backup ZIP) arrive as a base64 `resource` content block, not as text.

## New areas and tools

Categories added to the navigation tree (`src/services/mcp-tree.js`):

- `feeds`, `search`, `editorial`, `releases`: area **Content & site** (`content`).
- `openapi.json`: area **Admin, reports & system** (`admin`).
- Routes under `pages/:pageId/...` and `media/...` stay in the existing `pages` and `media` categories.

New tools (by name):

- **Feeds**: `feeds_list`.
- **Search**: `search_pages`, `search_reindex`.
- **Editorial workflow**: `editorial_queue`, `pages_editorial_get`, `pages_editorial_transition` (actions: `submit`, `withdraw`, `approve`, `reject`, `publish`, `unpublish`, `reopen`).
- **Releases**: `releases_list`, `releases_create`, `releases_get`, `releases_update`, `releases_delete`, `releases_items_add`, `releases_item_remove`, `releases_preview`, `releases_schedule`, `releases_cancel`, `releases_rebase`, `releases_run`.
- **OpenAPI**: `agent_openapi_get`.
- **Page versions**: `pages_version_get`, `pages_version_diff`, `pages_version_checkpoint`, `pages_restore_version`.
- **Media variants**: `media_variants_get`, `media_focal_set`, `media_variants_regenerate`.

Settings and page fields:

- `blog_settings_update` now accepts `feed_enabled`, `feed_item_limit`, `feed_full_content`, `search_enabled`, `search_language`, `editorial_workflow_enabled` and `images_srcset_mode`. Flags are the strings `"1"` / `"0"`.
- `pages_create` and `pages_replace` accept `unpublish_at` (automatic expiry, ISO 8601 with offset; `null` clears it; omitted on replace = unchanged) and the article fields `post_type`, `category_id`, `excerpt`, `featured_image`, `published_at`.
