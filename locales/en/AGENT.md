# AGENT.md — IlMioSito CMS operating protocol

> Native MCP clients (Claude Desktop and similar): see [`MCP.md`](MCP.md) —
> same functionality described here, exposed as MCP tools instead of REST.

## ABSOLUTE RULES

### HOMEPAGE CARDS — MANDATORY STRUCTURE

The homepage (`/`) contains card grids split by section. Each grid is a `<div class="cards">` (or `<div class="cards util">` for the 2-column "Useful guide" section).

**IRON RULE**: every new article added to a section MUST:
1. Be an `<article class="card">` (with optional `glossy` for "News")
2. Be inserted BEFORE the closing `</div>` of its `.cards` div
3. NEVER end up outside the `.cards` div (after `</div>\n    </div>`)

**Mandatory structure:**
```html
<article class="card">
  <a class="headlink" href="/SLUG">
    <img src="IMAGE_URL" alt="ALT_TEXT" style="width:100%;aspect-ratio:16/10;object-fit:cover;display:block;border-radius:2px" loading="lazy">
    <span class="ek">CATEGORY</span>
    <h3>TITLE</h3>
  </a>
  <p>DESCRIPTION (max 2 lines).</p>
  <div class="meta">AUTHOR · N min</div>
</article>
```

**For the "Useful guide" section** (`.cards.util`, 2 columns):
```html
<article class="card">
  <span class="lesson">CATEGORY</span>
  <a class="headlink" href="/SLUG"><h3>TITLE</h3></a>
  <p>DESCRIPTION.</p>
  <div class="meta">Guide · N min · AUTHOR</div>
</article>
```

**"News" section**: use `class="card glossy"` instead of `class="card"`.

**VERIFY AFTER THE OPERATION**: make sure the content does NOT contain patterns like `</div>\n    </div>\n  \n          <a class="headlink"` — those are orphan articles outside the grid.

1. **NEVER** read a page's content if you don't need to.
   INSTEAD: use `GET .../summary` for metrics, `GET .../full-report` for analysis.
   Reading a page = up to 500KB of JSON in context. Pointless if you just want to know whether it has base64.

2. **NEVER** loop over pages.
   INSTEAD: use `bulk-find-replace`, `bulk-inline-to-files`, `bulk-extract-assets`.
   Looping over 10 pages = 10 calls. Bulk = 1 call. -90% tokens.

3. **NEVER** call `GET /versions` before find-replace.
   The server AUTOMATICALLY saves a version before every change.
   The find-replace response includes `saved_version_id`.

4. **NEVER** send base64 in POST/PUT if you can avoid it.
   INSTEAD: upload first with `POST /media/upload`, then use `/media/{id}/{file}` in the HTML.
   Auto-extract is automatic, but uploading first is better (JSON 10x smaller).

5. **NEVER** call `inline-to-files` right after creating/updating a page.
   The server AUTOMATICALLY extracts all base64 after POST/PUT.
   inline-to-files is ONLY for EXISTING pages with leftover base64.

6. **NEVER** use PUT for partial edits. ALWAYS use find-replace.
   PUT overwrites everything and can break scripts, snippets, and variables.

7. **NEVER** unpublish a page while working on it.
   A published page with a small error beats an offline page.
   The user prefers imperfect content over a 404.
   For extensive edits: use find-replace in multiple steps. Don't touch `published`.

8. **NEVER** invent endpoint paths. Only use the ones listed here.
   The EXACT path for media upload is:
   `POST /api/agent/sites/{siteId}/media/upload`
   NOT `/upload`, NOT `/api/agent/upload`, NOT `/sites/:id/upload`.

9. **NEVER** download external media manually.
   ALWAYS use:
   POST /api/agent/sites/{siteId}/media/fetch-url
   body: { "url": "https://...", "force": true }

   If fetch-url fails with "File too large (max 20 MB)":
   - RETRY WITH { "force": true } — AFTER ASKING THE USER
   - Don't try to download the file any other way. It won't work.
   - Don't look for alternative URLs. They won't work.
   - If force also fails → inform the user and ask for help.

   Files >20MB can be downloaded with force.
   API responses always include `size_formatted` for readability (KB if <1MB, MB if >=1MB).

## PUBLIC FORMS — anti-spam

When you create/edit a page containing a `<form>` that submits to
`POST /forms/{siteId}/{formSlug}`, ALWAYS add a hidden honeypot field:

```html
<input type="text" name="website" style="position:absolute;left:-9999px" tabindex="-1" autocomplete="off">
```

The server silently accepts (`{ok:true}`, nothing saved) any submission where
`website` (or `_honeypot`/`url`) is filled in — bots that fill in every field
fall for it, human users never see the field. Beyond the honeypot, the server
automatically applies: 5/min rate limit per IP, 30 submissions/day cap per
IP+site, and a filter on the number of links in the fields (>3 URLs in a
submission → silently discarded). Nothing else is needed on the page side.

## AUTHENTICATION

Step 1: POST /api/auth/login — body: { "email": "..." }
  Expected response: { "sent": true }
  If sent is false: the email doesn't exist in the system, ask to verify it.

Step 2: ask the user for the OTP code received by email (6 digits).

Step 3: POST /api/agent/verify-otp — body: { "email": "...", "otp": "..." }
  Expected response: { "token": "...", "user": { ... } }
  Save the token. Use it as header: Authorization: Bearer {token}
  The token lasts 7 days. After expiry, repeat the flow from the start.

Step 4: verify identity with GET /api/agent/me
  Expected response: { "user": { "role": "...", "site_id": ... }, "token_expires_at": "..." }
  If role is "admin" or "collaboratore", site_id is your assigned site.
  If role is "superadmin", you must ask which site to work on and use that id.

## FINDING THE SITE AND PAGES

GET /api/agent/sites
  Response: { "sites": [ { "id": 1, "name": "My site", "domain": "..." } ] }
  If there's only one site, always use that id.

GET /api/agent/sites/{siteId}/pages
  Response: { "pages": [ { "id": 5, "url_path": "/landing", "title": "Landing", "published": true } ] }
  Use this list to find a page's numeric id from its url_path or title.

## ENDPOINT HIERARCHY — what to use IN ORDER

For EVERY operation, use the FIRST option in the list. It's always the most efficient.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SEARCHING TEXT across all pages
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1st choice: POST /api/agent/pages/search          ← 1 call, ALL sites
2nd choice: GET /sites/:id/pages/search?q=...      ← 1 call, 1 site
NEVER:      GET /pages and scroll through every page manually

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EDITING TEXT across multiple pages
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1st choice: POST /sites/:id/pages/bulk-find-replace  ← 1 call, ALL pages
2nd choice: POST /sites/:id/pages/:pid/find-replace  ← 1 call, 1 page
NEVER:      PUT /pages/:pid with the entire content

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANALYZING A PAGE (without reading its content)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1st choice: GET /sites/:id/pages/:pid/full-report   ← 1 call, EVERYTHING
2nd choice: GET /sites/:id/pages/:pid/summary       ← 1 call, metrics only
NEVER:      GET /pages/:pid to read useless content

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UPLOADING AN IMAGE (avoid base64)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1st choice: POST /sites/:id/media/upload
           EXACT path: /api/agent/sites/{siteId}/media/upload
           multipart, field "file". Response includes `size_formatted`
           NOT /upload, NOT /api/agent/upload, NOT /sites/:id/upload
2nd choice: POST /sites/:id/media/fetch-url  ← import from an external URL
           If >20MB, use { "url": "...", "force": true }
NEVER:      Paste data:image/...;base64 into the page JSON
NEVER:      Try to download external files yourself. Use fetch-url.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERTING BASE64 to files
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1st choice: NOT NEEDED — the server does it automatically on POST/PUT
2nd choice: POST /sites/:id/pages/:pid/inline-to-files   ← existing page
3rd choice: POST /sites/:id/pages/bulk-inline-to-files   ← multiple pages
NEVER:      Call inline-to-files right AFTER just creating the page

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PUBLISHING / HIDING PAGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEVER:      Unpublish a page while working on it
           Leave published=true. Use find-replace for partial edits.
           The user prefers a small error over an offline page.

## COST TABLE — how much you save using the right endpoint

| Operation | OLD method | Calls | NEW method | Calls | Savings |
|---|---|---|---|---|---|
| Search text in 50 pages | GET /pages + search manually | 50 | GET /pages/search | 1 | -98% |
| Find pages with snippet X | GET /pages + snippet-usage × 50 | 51 | GET /snippets/:id/usage | 1 | -98% |
| Replace text in 10 pages | find-replace × 10 | 10 | bulk-find-replace | 1 | -90% |
| Analyze 1 page | page + snippet + asset = 3 | 3 | full-report | 1 | -66% |
| Delete 20 orphan files | DELETE × 20 | 20 | media/cleanup | 1 | -95% |
| Convert base64 on 5 pages | inline-to-files × 5 | 5 | bulk-inline-to-files | 1 | -80% |
| Duplicate 3 pages | duplicate × 3 | 3 | bulk-duplicate | 1 | -66% |
| Update 5 variables | PUT × 5 | 5 | PUT /variables/bulk | 1 | -80% |
| Upload image + page | base64 in JSON (500KB) | 1 | /media/upload + URL (1KB) | 1 | -99.8% JSON |
| Search ALL sites | /sites × N + search × N | N+1 | POST /api/agent/pages/search | 1 | -90%+ |
| **Size readability** | raw bytes (e.g. 1048576) | — | `size_formatted` (e.g. "1.0 MB") | — | **Readable** |

## RECIPES — exact sequences for each task

### Recipe A: change text on a page
1. POST /api/agent/sites/{siteId}/pages/{pageId}/find-replace
   body: { "find": "text to search", "replace": "new text", "regex": false }
   Expected response: { "matches": N, "message": "Replaced N occurrences", "saved_version_id": 42 }
2. If matches is 0: the text isn't in the raw content (it might be inside a snippet).
3. Inform the user of the result.
4. Do NOT call GET /versions. The server saves the version automatically.
   [Savings: 1 call instead of 2. -50% tokens.]

### Recipe B: check what's on a page before editing it
1. GET /api/agent/sites/{siteId}/pages/{pageId}/full-report
   → { "page": {...}, "snippets": {...}, "assets": {...}, "variables_used": [...] }
2. If you only want metrics: GET .../summary (even lighter).
   [Savings: 1 call instead of 3. -66% tokens.]

### Recipe C: locate external assets on a page
1. GET .../asset-report → list of downloadable URLs (src, href, poster, CSS url(), .mov video, woff2...)
2. Show the list to the user and ask for confirmation.
3. POST .../extract-assets
   Response: { "converted": [...], "tooLarge": [...], "errors": [...], "pages_updated": {...} }
4. Useful fields: **reused: true** (already downloaded), **deduped: true** (same content)
5. If tooLarge isn't empty: ask for confirmation, retry with { "force": true }
6. For multiple pages: POST .../pages/bulk-extract-assets (1 call instead of N)
   [Savings: 1 call instead of N. -90% on multiple pages.]

### Recipe D: convert inline base64 to files
1. POST /api/agent/sites/{siteId}/pages/{pageId}/inline-to-files
   Response: { "converted": N, "files": [...], "message": "..." }
2. The page content is updated automatically.
3. For lighter responses: add `?minimal=true` → { "converted": N } without the file list.
4. For multiple pages: POST .../pages/bulk-inline-to-files
   [Savings: Not needed if you just created the page (auto-extract).]

### Recipe E: publish or hide a page
POST /api/agent/sites/{siteId}/pages/{pageId}/publish-toggle
body: { "published": true } or { "published": false }
NEVER use PUT for this. publish-toggle doesn't touch the content.
NEVER unpublish while working. Leave published=true.

### Recipe F: duplicate a page and edit it
1. POST /api/agent/sites/{siteId}/pages/{pageId}/duplicate
   body: { "new_url_path": "/new-page", "new_title": "Copy title" }
2. The duplicated page is always created as a draft (published: false).
3. For multiple pages: POST .../pages/bulk-duplicate (1 call instead of N)
   [Savings: 1 call instead of N. -80% on multiple pages.]

### Recipe G: find text across all pages
1. GET /api/agent/sites/{siteId}/pages/search?q=text+to+search
   Response: { "results": [ { "id": ..., "url_path": "...", "title": "..." } ] }
2. To search ALL sites: POST /api/agent/pages/search
   [Savings: 1 call instead of N+1. -90%+.]

### Recipe H: restore a previous version
**Fast method (latest version):**
POST /api/agent/sites/{siteId}/pages/{pageId}/restore-last
(no body) → { "ok": true, "restored_version_id": 42, ... }

**Specific method (exact version):**
1. GET /api/agent/sites/{siteId}/pages/{pageId}/versions → find the id
2. POST /api/agent/sites/{siteId}/pages/{pageId}/versions/{versionId}/restore

The current version is always saved before restoring.
[Savings: 1 call instead of 2 with restore-last. -50%.]

### Recipe I: edit a snippet used on multiple pages
**Replaced by Recipe V.** Use that one: 1 call instead of 51.
GET /api/agent/sites/{siteId}/snippets/{snippetId}/usage

### Recipe L: validate a page after changes
POST /api/agent/sites/{siteId}/pages/{pageId}/validate
Response: { "ok": true/false, "issues": [ { "type": "broken_snippet", "detail": "..." } ] }

### Recipe M: download a file from Google Drive
Use POST .../media/fetch-url with the shared Google Drive URL.
The system automatically converts it to the direct download URL.

### Recipe N: know whether video compression is in progress
When you upload a video (upload or fetch-url), the response contains:
- `compressed: false` — the file is immediately available, compression in progress
- `size` — original size (pre-compression)
Compression replaces the file in the background. It doesn't block the response.

### Recipe O: force the static export
1. POST /api/agent/sites/{siteId}/export-static
   Response: { "ok": true, "exported": N, "errors": 0 }
2. To export ALL sites:
   POST /api/agent/export-static-all
   Response: { "ok": true, "totalExported": N, "totalErrors": 0 }

### Recipe P: working with site variables
1. GET /api/agent/sites/{siteId}/variables
   Response: { "variables": [ { "key": "phone", "value": "+39..." } ] }
2. PUT /api/agent/sites/{siteId}/variables/{key}
   body: { "value": "new value", "description": "optional" }
3. DELETE /api/agent/sites/{siteId}/variables/{key}
4. For multiple variables: PUT .../variables/bulk (1 call instead of N)
   [Savings: 1 call instead of N. -80% on multiple variables.]

### Recipe Q: upload images BEFORE creating a page (NO base64)
1. POST /api/agent/sites/{siteId}/media/upload (multipart, field "file")
   EXACT path: /api/agent/sites/{siteId}/media/upload
   NOT /upload, NOT /api/agent/upload, NOT /sites/:id/upload
   Response: { "file": { "url": "/media/{siteId}/{filename}", ... } }
2. Use the URL "/media/{siteId}/{filename}" in the page HTML
3. The page JSON stays LIGHT (no inline base64)
   [Savings: JSON 500KB → 1KB. -99.8% request size.]

### Recipe R: create a page with base64 (server-side auto-extract)
1. POST /api/agent/sites/{siteId}/pages with HTML content (even with base64)
2. The server AUTOMATICALLY extracts all base64 into local files
3. The response already contains the substituted /media/... URLs
4. No need to call inline-to-files after creation
5. Same for PUT /api/agent/sites/{siteId}/pages/{pageId}
   [Savings: 0 extra calls. Auto-extract is automatic.]

### Recipe S: find and replace on ALL pages in 1 call
1. POST /api/agent/sites/{siteId}/pages/bulk-find-replace
   body: { "find": "text", "replace": "new", "regex": false, "dry_run": false }
   Response: { "pages_affected": 3, "total_matches": 5, "results": [...] }
2. With dry_run:true you see the impact without changing anything
3. Pages are automatically re-exported after the replacement
   [Savings: 1 call instead of 10. -90% tokens.]

### Recipe T: undo the last change to a page
1. POST /api/agent/sites/{siteId}/pages/{pageId}/undo (no body)
   Response: { "ok": true, "restored_version_id": 42, "restored_at": "..." }
2. Saves the current version before the rollback (you lose nothing)
   [Savings: 0 extra calls if you have saved_version_id from the previous edit.]

### Recipe U: clean up orphan media after conversions
1. GET /api/agent/sites/{siteId}/media/unused → list of orphan files
2. POST /api/agent/sites/{siteId}/media/cleanup
   body: { "all_unused": true } ← DELETES ALL orphans in 1 shot
   Or: { "filenames": ["file1.jpg", "file2.png"] }
   Response: { "deleted": 5, "freed_bytes": 1048576, "errors": [] }
3. Warning: all_unused=true deletes ALL unreferenced files
   [Savings: 1 call instead of N+1. -95% tokens.]

### Recipe V: know which pages use a snippet (REPLACES Recipe I)
1. GET /api/agent/sites/{siteId}/snippets/{snippetId}/usage
   Response: { "snippet_id": 3, "snippet_name": "header", "total_pages": 5,
              "pages": [ { "id": 10, "url_path": "/landing", "title": "Landing" }, ... ] }
2. A single call. No loop.
   [Savings: 1 call instead of 51. -98% tokens.]

### Recipe W: FULL analysis of a page in 1 call
1. GET /api/agent/sites/{siteId}/pages/{pageId}/full-report
   Response: { "page": {...}, "snippets": { total, list, broken },
              "assets": { external_urls, inline_base64, inline_size_kb },
              "variables_used": [...], "media_urls": N }
2. Replaces: GET /page + GET /snippet-usage + GET /asset-report
   [Savings: 1 call instead of 3. -66% tokens.]

### Recipe X: extract base64 or assets on multiple pages in 1 call
**Base64:** POST /api/agent/sites/{siteId}/pages/bulk-inline-to-files
  body: { "page_ids": [1, 2, 3] }
  → { "pages_processed": 3, "total_converted": 15, "results": [...] }

**External assets:** POST /api/agent/sites/{siteId}/pages/bulk-extract-assets
  body: { "page_ids": [1, 2, 3], "force": false }
  → { "pages_processed": 3, "assets_converted": 12, "too_large": 0, "errors": 0 }
  [Savings: 1 call instead of N. -90% on multiple pages.]

### Recipe Y: clean up ALL orphan media in 1 shot
1. GET /api/agent/sites/{siteId}/media/unused → see what's there
2. POST /api/agent/sites/{siteId}/media/cleanup
   body: { "all_unused": true } ← DELETES ALL orphans
   Or: { "filenames": ["file1.jpg", "file2.png"] }
   → { "deleted": 5, "freed_bytes": 1048576, "errors": [] }
   [Savings: 1 call instead of N+1. -95% tokens.]

### Recipe Z: search ALL sites at once
1. POST /api/agent/pages/search
   body: { "q": "text", "site_ids": [1, 21] }  ← site_ids optional
   → { "results": [ { "site_id": 1, "site_name": "Online Store", "page_id": 5, ... } ], "total": 2 }
2. If site_ids isn't specified, searches ALL accessible sites.
3. Use GET /api/agent/sites/{siteId}/pages/search for a single site.
   [Savings: 1 call instead of N+1. -90%+.]

## VIDEO COMPRESSION

MP4 files are automatically compressed in the background after upload or URL fetch.
- **Target**: ~60 MB per minute of video
- **Codec**: H.264 (libx264), fast preset, CRF 28
- **Audio**: AAC 128 kbps
- **Fast start**: enabled for optimal streaming (metadata at the start of the file)
- **Behavior**: the original file is immediately available; compression replaces it atomically (`rename`) only once encoding completes successfully
- **On failure**: the original file is preserved, no crash
- **Depends on**: ffmpeg must be installed in the container (alpine: `apk add ffmpeg`)

## STATIC EXPORT — Managed Caddy (maintenance fallback)

The CMS exports every published page as a static HTML file.
A separate Managed Caddy (independent docker stack) serves these files
when Express is under maintenance. Zero downtime guaranteed.

### Rules for the agent
1. Export starts **automatically** after every change (text, snippet,
   variables, SEO, publishing). Nothing needs to be called.
2. To force a manual export (complex batch operations):
   POST /api/agent/sites/:id/export-static    ← that site only
   POST /api/agent/export-static-all          ← all sites
3. Managed Caddy uses a dynamic `{host}` → all domains associated
   with the site work without duplicating files (site_id → domain symlink).
4. UNpublished pages → no static file.
5. If Express is DOWN:
   - Existing pages → served from static (OK)
   - Non-existent pages → homepage served (404.html same as the site)
   - Managed Caddy runs on its own, doesn't depend on the CMS
6. Media (images/video) live at `/media/{siteId}/{file}` and work
   identically from both Express and Caddy. Caddy is FASTER for media.

### What triggers the export
- Every change to: pages, snippets, site variables, homepage_path
- Every domain added/removed
- Every deploy (before the Cloudflare purge)
- Every 5 minutes (internal scheduler)
- On CMS startup

## NEWSLETTER

Two send types, same SMTP and same hourly quota per site (they add up to
the same limit, not two separate limits):

- **Broadcast campaign** — a single send. Reached by whoever is `confirmed`
  **at the moment the server processes the send** (every 60s, in batches
  respecting `rate_per_hour`) — a subscriber who unsubscribes after
  yesterday's send doesn't receive today's, and one who subscribes after the
  campaign is queued still receives that campaign if it's still sending.
- **Evergreen sequence** — N ordered emails (`step_order`), each sent to a
  subscriber once `delay_days` days have passed since **their subscription
  was confirmed** (not since the previous step — "day 0/3/7 from
  confirmation" pattern, no cumulative drift). Order is guaranteed: a step
  won't go out to a subscriber until they've received the previous step,
  even if the hourly quota has slowed sends down. A subscriber who
  unsubscribes automatically stops receiving further steps (the filter is
  always `status='confirmed'`).

### One-time setup — BEFORE any send

```
PUT /api/agent/sites/{siteId}/newsletter/settings
body: { "smtp_host": "...", "smtp_port": 465, "smtp_user": "...",
        "smtp_pass": "...", "from_email": "newsletter@site.com",
        "rate_per_hour": 100, "signature_html": "<p>The Team at ...</p>" }
```
Partial body: omitted fields keep their already-saved value. `signature_html`
is the signature, configure it once — it's automatically appended to the
bottom of EVERY email (campaign or step), together with the unsubscribe link
and open-tracking pixel (the server always adds these last two, don't put
them in the content yourself). No send starts until `newsletter_settings`
exists for the site (no fallback to the system SMTP).

`GET /api/agent/sites/{siteId}/newsletter/settings` never returns the
password in clear text, only `smtp_pass_set: true/false`.

### Per-site email templates (override system email texts)

Every system email can have per-site subject/body overrides. If not set,
the standard default is used. Same system available in the UI
(`/admin/newsletter/email-templates`).

```
GET    /api/agent/sites/{siteId}/email-templates
       → { templates: [...], kinds: [{ kind, configured }] }

PUT    /api/agent/sites/{siteId}/email-templates/{kind}
       body: { "subject": "...", "body_html": "..." }   ← empty = default for that field

DELETE /api/agent/sites/{siteId}/email-templates/{kind}
       → removes the override (back to default)
```

Supported kinds: `newsletter_confirm`, `newsletter_test`,
`call_confirmation`, `call_reminder`, `form_notify`, `deploy_notify`,
`review_reminder`. Placeholders in subject/body (same `{var}` syntax as
locales): `{siteName}`, `{siteDomain}`, `{confirmUrl}`, `{cancelUrl}`,
`{when}`, `{formSlug}`, `{fieldsHtml}`, `{title}`, `{url}`, `{urlPath}`,
`{date}`, `{pageList}`, `{note}`, `{siteId}`.

### The "builder"

The content (campaigns and steps) goes through the same snippet/variable
engine as pages, expanded at send time (not at save time): use
`{{snippet:name}}` to reuse a block already managed for the site (e.g. an
article, a promo) and `{{var:key}}` for site variables. Compose the email
this way instead of writing HTML from scratch — if you update the snippet
afterward, content already queued but not yet sent reflects the updated
version.

### Recipe: broadcast campaign

```
1. POST /api/agent/sites/{siteId}/newsletter/campaigns
   body: { "subject": "...", "html_content": "{{snippet:august-promo}}" }
   → { "campaign": { "id": 3, "status": "draft", ... } }
2. POST /api/agent/sites/{siteId}/newsletter/campaigns/3/send
   → { "ok": true, "status": "sending" }
```
2 calls. The scheduler processes it in batches over the following minutes.

### Recipe: evergreen sequence (e.g. 3-email onboarding)

```
1. POST /api/agent/sites/{siteId}/newsletter/sequences
   body: { "name": "New subscriber onboarding" }
   → { "sequence": { "id": 5, "active": true, ... } }
2. PUT /api/agent/sites/{siteId}/newsletter/sequences/5/steps
   body: { "steps": [
     { "step_order": 1, "delay_days": 0, "subject": "Welcome!", "html_content": "{{snippet:welcome}}" },
     { "step_order": 2, "delay_days": 3, "subject": "Have you tried...", "html_content": "{{snippet:tip-1}}" },
     { "step_order": 3, "delay_days": 7, "subject": "An offer for you", "html_content": "{{snippet:offer}}" }
   ] }
   → { "ok": true, "steps": [...] }
```
2 calls for the whole sequence (atomic replacement of all steps, not one
call per step). **WARNING**: calling this endpoint again on a sequence
that's already active with subscribers in progress deletes and recreates
the steps — someone who already received a step with a given `step_order`
may receive it again (send history is tied to the step id, not its order).
Define the steps before letting the sequence collect subscribers who've
matured, or accept that redefining an already-running sequence resets
progress on those steps.

### Recipe: test send (before queueing)

```
POST /api/agent/sites/{siteId}/newsletter/campaigns/{campaignId}/test-send
body: { "email": "you@example.com" }        ← optional, defaults to the agent account's email
POST /api/agent/sites/{siteId}/newsletter/sequences/{sequenceId}/steps/{stepId}/test-send
body: { "email": "you@example.com" }        ← same behavior, for a single step
```
Expands snippets/variables and adds the signature exactly like a real send,
but with the subject prefixed `[TEST]`, no working unsubscribe link or
pixel, and **doesn't count as a send** (doesn't touch `newsletter_sends`/
`newsletter_sequence_sends`, doesn't consume the hourly quota). Always use
it before `POST .../send` on a campaign, or before letting a sequence
collect matured subscribers — if `email` isn't given, it goes to the
address of the account the agent is authenticated as.

### Recipe: assisted import of existing subscribers

```
POST /api/agent/sites/{siteId}/newsletter/subscribers
body: { "email": "customer@example.com", "confirmed": true }
```
`confirmed:true` skips double opt-in (confirmation email) — use it only for
lists the user already owns consent for (e.g. existing customers who
already consented elsewhere). Default `confirmed:false`: the subscriber
goes to `pending` and receives the standard confirmation email.

## SOCIAL — scheduled posts (do NOT actually publish)

`social_posts_create`/`social-posts` **does not actually publish** to
Twitter/LinkedIn/Facebook: it only checks that the platform token is
configured, then records the post as "simulated" (`simulated=true` column)
and returns success. No real call is made to any social API.

If the user asks to "publish a social post", the scheduled post will show up
in `/admin/social` with a "Simulated" status — say this explicitly instead of
implying it was really published. Implementing the real integration is low
priority and not done yet.

## REMINDER — Auto-context (anti-compaction)

Every ~12 API calls, the service includes a `_reminder` field in the
JSON response. It contains a random section of this file.

**What to do when you see `_reminder`:**
- Read it. It contains a rule or recipe you might have forgotten after
  a context compaction.
- If the reminder says "Don't use PUT for partial edits" and you were
  about to do a PUT → stop and use find-replace instead.
- If the reminder lists an endpoint you didn't remember → use it.
- If the reminder shows a token saving → use it.

The reminder does NOT change API behavior. It's just a memo.

## COMMON ERRORS AND HOW TO HANDLE THEM

- 401 Unauthorized: expired or invalid token. Repeat the authentication flow from the start.
- 403 Forbidden: you don't have access to that site. Check GET /api/agent/me for your assigned site_id.
- 404 Not Found: the page or snippet id doesn't exist. Reload the list with GET .../pages or .../snippets. If the path is something like `/upload`, it's probably wrong: check the ENDPOINT HIERARCHY section.
- 409 Conflict: url_path already exists. Pick a different path.
- matches: 0 from find-replace: the searched text isn't in the raw content. It might be
  expanded from a snippet: check with GET .../snippet-usage and then edit the snippet directly.

## FULL ENDPOINT LIST

GET    /api/agent/me
GET    /api/agent/sites
GET    /api/agent/sites/:id/pages
GET    /api/agent/sites/:id/pages/:pid
POST   /api/agent/sites/:id/pages
PUT    /api/agent/sites/:id/pages/:pid                    ← only if you need to rewrite everything
GET    /api/agent/sites/:id/pages/search?q=...
POST   /api/agent/sites/:id/pages/bulk-publish
POST   /api/agent/sites/:id/pages/bulk-find-replace         ← search/replace on ALL pages
POST   /api/agent/sites/:id/pages/:pid/publish-toggle
POST   /api/agent/sites/:id/pages/:pid/duplicate
POST   /api/agent/sites/:id/pages/:pid/rename-url
POST   /api/agent/sites/:id/pages/:pid/find-replace       ← always prefer this over PUT
POST   /api/agent/sites/:id/pages/:pid/extract-assets     ← download external URLs locally
POST   /api/agent/sites/:id/pages/:pid/inline-to-files    ← convert base64 to files
GET    /api/agent/sites/:id/pages/:pid/asset-report       ← asset analysis before editing
POST   /api/agent/sites/:id/pages/:pid/validate           ← check errors after changes
GET    /api/agent/sites/:id/pages/:pid/versions
POST   /api/agent/sites/:id/pages/:pid/versions/:vid/restore
GET    /api/agent/sites/:id/pages/:pid/summary              ← page metrics (no content)
GET    /api/agent/sites/:id/pages/:pid/full-report          ← full analysis (snippet+asset+metrics)
POST   /api/agent/sites/:id/pages/:pid/undo                 ← undo last change
POST   /api/agent/sites/:id/pages/:pid/restore-last         ← restore last version (no GET needed)
POST   /api/agent/sites/:id/pages/bulk-inline-to-files      ← convert base64 on multiple pages
POST   /api/agent/sites/:id/pages/bulk-extract-assets       ← download assets on multiple pages
POST   /api/agent/sites/:id/pages/bulk-duplicate            ← duplicate multiple pages in one shot
POST   /api/agent/pages/search                              ← search ALL sites
GET    /api/agent/sites/:id/pages/:pid/snippet-usage
GET    /api/agent/sites/:id/pages/:pid/rendered
GET    /api/agent/sites/:id/pages/:pid/diff/:vid
GET    /api/agent/sites/:id/snippets
GET    /api/agent/sites/:id/snippets/:sid
GET    /api/agent/sites/:id/snippets/:sid/usage              ← pages using the snippet
POST   /api/agent/sites/:id/snippets
PUT    /api/agent/sites/:id/snippets/:sid
POST   /api/agent/sites/:id/snippets/:sid/find-replace
GET    /api/agent/sites/:id/media
POST   /api/agent/sites/:id/media/upload                 ← multipart field "file" — EXACT path
POST   /api/agent/sites/:id/media/fetch-url              ← supports shared Google Drive links
DELETE /api/agent/sites/:id/media/:filename
GET    /api/agent/sites/:id/media/unused                    ← unreferenced orphan media
POST   /api/agent/sites/:id/media/cleanup                  ← bulk delete orphan media
GET    /api/agent/sites/:id/settings
PUT    /api/agent/sites/:id/settings/:key
GET    /api/agent/sites/:id/audit-log
GET    /api/agent/sites/:id/stats
POST   /api/auth/login
POST   /api/agent/verify-otp
POST   /api/agent/sites/:id/export-static              ← force static export for the site
POST   /api/agent/export-static-all                    ← force export for ALL sites
GET    /api/agent/sites/:id/newsletter/settings         ← SMTP+signature config (password never in clear text)
PUT    /api/agent/sites/:id/newsletter/settings         ← one-time setup, partial body
GET    /api/agent/sites/:id/newsletter/subscribers      ← ?status=&limit=&offset=
GET    /api/agent/sites/:id/newsletter/subscribers/stats
POST   /api/agent/sites/:id/newsletter/subscribers      ← assisted import, { email, confirmed? }
DELETE /api/agent/sites/:id/newsletter/subscribers/:email
GET    /api/agent/sites/:id/newsletter/campaigns
GET    /api/agent/sites/:id/newsletter/campaigns/:cid
POST   /api/agent/sites/:id/newsletter/campaigns        ← create broadcast draft
PUT    /api/agent/sites/:id/newsletter/campaigns/:cid   ← only if draft
POST   /api/agent/sites/:id/newsletter/campaigns/:cid/send
POST   /api/agent/sites/:id/newsletter/campaigns/:cid/test-send   ← { email? }, doesn't count as a send
DELETE /api/agent/sites/:id/newsletter/campaigns/:cid   ← drafts only
GET    /api/agent/sites/:id/newsletter/sequences
POST   /api/agent/sites/:id/newsletter/sequences        ← create empty sequence
GET    /api/agent/sites/:id/newsletter/sequences/:sid   ← with steps[]
PUT    /api/agent/sites/:id/newsletter/sequences/:sid   ← { name?, active? }
DELETE /api/agent/sites/:id/newsletter/sequences/:sid
PUT    /api/agent/sites/:id/newsletter/sequences/:sid/steps  ← atomic replacement of all steps, 1 call
POST   /api/agent/sites/:id/newsletter/sequences/:sid/steps/:stid/test-send  ← { email? }, doesn't count as a send
GET    /api/agent/sites/:id/variables                  ← list site variables
PUT    /api/agent/sites/:id/variables/:key             ← create/update a variable
PUT    /api/agent/sites/:id/variables/bulk             ← update multiple variables in one shot
DELETE /api/agent/sites/:id/variables/:key             ← delete a variable
PATCH  /api/agent/sites/:id/pages/:pid/sections/:name  ← atomic section edit
GET    /api/agent/sites/:id/forms                      ← list forms with submission counts
GET    /api/agent/sites/:id/forms/:slug/submissions    ← submissions of one form, paginated (?since=)
GET    /api/agent/sites/:id/forms/search?q=...         ← search a value across ALL submissions of the site
GET    /api/agent/sites/:id/contacts?tag=...            ← contacts derived from submissions (CRM-lite, by email), filterable by tag
GET    /api/agent/sites/:id/contacts/tags               ← distinct tags in use on the site
GET    /api/agent/sites/:id/contacts/:email             ← a contact's submission history + tags/status/notes
PUT    /api/agent/sites/:id/contacts/:email             ← sets tags/status/notes/estimated value (creates the contact if missing)
GET    /api/agent/sites/:id/contacts/:email/export      ← GDPR access right: full JSON export
DELETE /api/agent/sites/:id/contacts/:email             ← GDPR erasure right: deletes everything, permanent
GET    /api/agent/sites/:id/modules                     ← optional module status for the site
PUT    /api/agent/sites/:id/modules/:key                ← enable/disable a module
GET    /api/agent/sites/:id/pipeline                    ← sales pipeline board by stage (requires module)
GET    /api/agent/sites/:id/calls                       ← list calls (requires module)
POST   /api/agent/sites/:id/calls                       ← manually schedule a call
PUT    /api/agent/sites/:id/calls/:callId               ← set call status/outcome
GET    /api/agent/sites/:id/calls/availability           ← weekly availability rules
PUT    /api/agent/sites/:id/calls/availability           ← atomic rules replacement
GET    /api/agent/sites/:id/calls/slots                  ← computed free slots
POST   /api/agent/sites/:id/calls/book                   ← book on someone's behalf
GET    /api/agent/sites/:id/tracking                     ← GA4/GTM/Meta Pixel/CAPI/Clarity config (token masked)
PUT    /api/agent/sites/:id/tracking                     ← set tracking config
GET    /api/agent/sites/:id/pages/:pid/seo               ← a page's meta/canonical/noindex/OG
PUT    /api/agent/sites/:id/pages/:pid/seo               ← set page SEO (only affects wrapped pages, see SEO section)
GET    /api/agent/sites/:id/seo                          ← site-wide SEO defaults (OG image, Twitter handle, robots.txt extra)
PUT    /api/agent/sites/:id/seo                          ← set site SEO defaults
GET    /api/agent/sites/:id/calendars                    ← list bookable calendars (multi-agenda)
POST   /api/agent/sites/:id/calendars                    ← create calendar { name, slug?, description?, user_id?, enabled?, ty_page? }
PUT    /api/agent/sites/:id/calendars/:calendarId        ← update name/slug/description/owner/enabled/ty_page
DELETE /api/agent/sites/:id/calendars/:calendarId        ← delete calendar (rules cascade, bookings unlinked)
GET    /api/agent/sites/:id/quizzes                      ← list scored quizzes (questions/thresholds + result count)
POST   /api/agent/sites/:id/quizzes                      ← create quiz { name, slug?, intro?, questions, thresholds, ask_email?, contact_tag?, redirect_url?, enabled? }
PUT    /api/agent/sites/:id/quizzes/:quizId              ← update quiz (omitted fields unchanged)
DELETE /api/agent/sites/:id/quizzes/:quizId              ← delete quiz definition (results kept)
GET    /api/agent/sites/:id/quizzes/:quizSlug/submissions ← results: answers + recomputed score + verdict

## CONTACTS (CRM-lite)

No separate table for identity data: each submission's email is derived
from the field marked type `email` in the form (created via the admin form
builder), or a name heuristic for hand-written forms in pages. A contact
with `forms_count > 1` filled more than one different form — useful to see
if a lead interacted more than once before being followed up. A submission
with no recognizable email field stays visible only via
`forms/:slug/submissions` or `forms/search`, not in `/contacts`.

Tags/status/notes ARE persisted instead (`contacts` table, auto-created/
updated on every submission with a recognized email) since they can't be
derived from submitted data — set them with `PUT .../contacts/:email`.

### Tag-based newsletter segmentation

Broadcast campaigns and evergreen sequences accept `target_tag` on create
(`newsletter_campaigns_create`/`newsletter_sequences_create`) or update
(`newsletter_campaigns_update`/`newsletter_sequences_update`, pass
`target_tag: ""` to remove it): if set, only confirmed subscribers whose
contact has that tag receive the send; omitted/empty = unchanged behavior,
all confirmed subscribers of the site.

### Auto-subscribe to the newsletter from a form

In the admin form builder, a form with a checkbox field can be set as the
"newsletter consent" field (`newsletter_optin_key`): if that checkbox is
checked and an email is identified in the submission, it auto-subscribes to
the site's newsletter with the same double opt-in as manual subscription
(confirmation email, no instant subscription). Not manageable via the agent
API — builder-only, in admin.

**Newsletter tag from form** (`newsletter_tag_key` + optional
`newsletter_tag_value`, also admin builder-only): on submit, the contact
derived from the submission's email gets the given tag assigned
(idempotent, same mechanism as `PUT .../contacts/:email`). It's the bridge
between forms and segmentation: a sequence/campaign with `target_tag` on
that tag fires automatically for people subscribing from that form, with
no agent action.

**Thank-you page** (`redirect_url`, admin builder-only): after a successful
submission the browser is redirected to the given path (e.g. `/grazie`)
instead of showing the confirmation message. For AJAX clients the redirect
comes in the JSON `redirect` field (`{ok:true, redirect:"/grazie"}`) and
must be followed client-side. The server only accepts relative paths or
same-domain URLs (an arbitrary external `_redirect` is ignored, even if
present in the form).

## LONG-LIVED API TOKENS (for n8n/automations)

Besides OTP login + `refresh-token` (meant for interactive sessions like
Claude Code), there's a second credential type for non-interactive
automations: tokens generated from `/admin/api-tokens` (web UI, created by a
human), valid 30-365 days (default 120), individually revocable without
touching the user's other sessions. Use exactly like an agent JWT:
`Authorization: Bearer agtok_...` on any `/api/agent/...` endpoint. There's
no endpoint to create them via API — generate once from the web UI and
paste into n8n's (or another system's) configuration.

## OPTIONAL MODULES (enabled per site)

Sales Pipeline and Calls are disabled by default — their routes return 403
until enabled for that site (except for superadmin, who always sees them).
Enable from `/admin/sites/:id/edit` (human) or via `modules_toggle`
(agent/n8n).

```
GET    /api/agent/sites/:id/modules                     ← module status for the site
PUT    /api/agent/sites/:id/modules/:key                ← { enabled: true|false }, key: sales_pipeline | call_scheduling
```

### Sales pipeline

Reuses `contacts.status` (already existing) with a fixed stage vocabulary:
`lead`, `contattato`, `chiamata_fissata`, `proposta_inviata`, `vinto`,
`perso` (empty/unrecognized status = "unassigned"). Adds `value_estimate`
(numeric) to the contact.

```
GET    /api/agent/sites/:id/pipeline                    ← board grouped by stage, with total value
```

Move a stage or update the value with `contact_update` (PUT
`/contacts/:email`, `status`/`value_estimate` fields) — no dedicated
endpoint, reuses the contacts one.

### Calls

Manual log (scheduled by admin from the contact card) + public
self-booking at `/book/:siteId` (slots computed from recurring weekly
availability, double conflict check at booking time, confirmation email
with a cancel link). Times are interpreted in the server's timezone (no
per-site multi-timezone support).

**Automatic reminder**: a reminder email goes out on its own (scheduler,
every 60s) one hour before every `programmata` call, exactly once
(`reminder_sent_at`) — no agent action needed, visible in `GET .../calls`
as the `reminder_sent_at` field (null = not sent yet).

``` 
GET    /api/agent/sites/:id/calls?email=...              ← list calls, or one contact's history; ?calendar_id= filters by calendar
POST   /api/agent/sites/:id/calls                        ← manually schedule { email, scheduled_at, duration_minutes?, calendar_id? }
PUT    /api/agent/sites/:id/calls/:callId                ← { status, outcome_notes } — status: programmata|completata|no_show|annullata
GET    /api/agent/sites/:id/calls/availability?calendar_id=  ← weekly availability rules (site-wide or one calendar's)
PUT    /api/agent/sites/:id/calls/availability           ← atomic replace { rules: [{weekday, start_time, end_time, slot_minutes?}], calendar_id? }
GET    /api/agent/sites/:id/calls/slots?days=14&calendar_id= ← computed free slots (site-wide or one calendar's)
POST   /api/agent/sites/:id/calls/book                   ← book on someone's behalf { email, start, notify?, calendar_id? } — re-checks conflicts
GET    /api/agent/sites/:id/calendars                    ← list bookable calendars (multi-agenda)
POST   /api/agent/sites/:id/calendars                    ← create calendar { name, slug?, description?, user_id?, enabled?, ty_page? }
PUT    /api/agent/sites/:id/calendars/:calendarId        ← update name/slug/description/owner/enabled/ty_page
DELETE /api/agent/sites/:id/calendars/:calendarId        ← delete calendar (rules cascade, bookings unlinked)
```

`weekday`: 0=Sunday...6=Saturday (JS `Date.getDay()` convention). Times as
`"HH:MM"` strings.

**Multi-calendar**: each calendar is a bookable "agenda" (e.g.
"Consulenza", "Demo", "Assistenza") with its own weekly availability, its
own calls, and an optional owner (users.id). It integrates into pages with
`{{calendar:slug}}` (expanded by the page-renderer like `{{form:slug}}`)
and has a dedicated public page `/book/:siteId/:slug` (the legacy
`/book/:siteId` is unchanged and uses the first enabled calendar, or the
site-wide rules if none exist). Omitting `calendar_id` on the calls routes
= legacy site-wide behavior. A calendar with `enabled=false` is no longer
expanded in pages nor resolved by `/book/:siteId/:slug`, but existing
bookings stay linked; deleting it unlinks them (calendar_id → NULL)
without removing them.

**Per-calendar thank-you page** (`ty_page`): after a successful booking the
visitor is taken to the configured page instead of the standard
confirmation message. Only a relative path (e.g. `/grazie`) or a
same-domain URL is accepted (never an external domain). The
`{{calendar:slug}}` widget follows it automatically (`window.location` on
the JSON `redirect` field); the public page `/book/:siteId/:slug` issues an
HTTP 302 redirect; agent `calls_book` does NOT redirect, it replies with
the normal JSON. Settable in admin (calendar form) or via agent:
`POST/PUT .../calendars` with `ty_page` (empty string removes it).

## SCORED QUIZZES (lead qualification, assessments, tests)

Single-answer quizzes where every option carries a score: on submit the
points are added up and the visitor sees the verdict matching the reached
threshold. The classic use case is **lead qualification** (e.g. the BANT
framework: Budget, Authority, Need, Timeline) but assessments, tests and
checklists work too. Embed in pages with `{{quiz:slug}}` (expanded by the
page-renderer like `{{form:slug}}` and `{{calendar:slug}}`).

```
GET    /api/agent/sites/:id/quizzes                      ← list quizzes (questions, thresholds, result count)
POST   /api/agent/sites/:id/quizzes                      ← create quiz
PUT    /api/agent/sites/:id/quizzes/:quizId              ← update (omitted fields unchanged)
DELETE /api/agent/sites/:id/quizzes/:quizId              ← delete definition (results kept)
GET    /api/agent/sites/:id/quizzes/:quizSlug/submissions ← results with recomputed score and verdict
```

**`questions` shape** (array, max 30 questions, max 12 options each):
```json
[
  { "key": "budget", "label": "What is your available budget?",
    "options": [
      { "label": "Less than €1,000", "points": 0 },
      { "label": "€1,000-5,000", "points": 1 },
      { "label": "€5,000-20,000", "points": 2 },
      { "label": "Over €20,000", "points": 3 }
    ] },
  { "key": "authority", "label": "Are you the decision maker?",
    "options": [
      { "label": "Yes, I decide", "points": 3 },
      { "label": "I can influence", "points": 1 },
      { "label": "No, I have to ask", "points": 0 }
    ] }
]
```

**`thresholds` shape** (verdict bands, sorted by `min`; `max` null/omitted =
up to infinity):
```json
[
  { "min": 0,  "max": 3,  "title": "Cold lead", "message": "Nurture with content.", "class": "cold" },
  { "min": 4,  "max": 7,  "title": "Warm lead", "message": "Interested, qualify further.", "class": "warn" },
  { "min": 8,  "max": null, "title": "Qualified lead 🔥", "message": "Contact within 24 hours.", "class": "ok" }
]
```

**Scoring**: computed twice — client-side in the widget (instant feedback,
works in the static export too) and server-side on submit
(`POST /quiz/:siteId/:slug`), which is the source of truth stored in
`quiz_submissions`. A tampered client cannot inflate its own score.

**Lead into CRM**: with `ask_email: true` the widget shows an optional email
field; if filled, the lead is created/updated in `/contacts` and gets
`contact_tag` (e.g. `qualifica-lead-caldo`) — newsletter campaigns/sequences
with a matching `target_tag` start on their own.

**`redirect_url`**: thank-you page after submit (relative path or same-domain
URL), same behaviour as forms. AJAX clients receive the destination in the
`redirect` JSON field and the widget follows it.

## CRM AUTOMATION (segments, workflows, scoring, tasks, funnel)

Native "CRM/ActiveCampaign-like" features built on `contacts`. No external
connectors. Every meaningful action (form, quiz, email, call, tag, stage)
fires a **contact event** (`contact_events`) that feeds segments, workflows
and scoring.

### Dynamic segments
Saved contact queries; membership is materialized and refreshed on every
event. Rules: `[{field, op, value, days?}]` with `match_mode all|any`.
Fields: `tag` (has), `status`/`email`/`notes`/`utm_source`/`utm_medium`/
`utm_campaign`/`first_source` (eq/neq/contains/...), `score`/
`value_estimate` (gt/gte/lt/lte), `event` (gte_days_ago/lt_days_ago/exists,
`days` = window). Preview via `GET .../segments/preview?rules=<json>`.
```text
GET    /api/agent/sites/:id/segments                ← list with member count
POST   /api/agent/sites/:id/segments                ← create { name, rules, match_mode? }
PUT    /api/agent/sites/:id/segments/:segmentId     ← update
DELETE /api/agent/sites/:id/segments/:segmentId     ← delete
GET    /api/agent/sites/:id/segments/:segmentId/members ← emails in segment
POST   /api/agent/sites/:id/segments/:segmentId/recount ← manual recount
GET    /api/agent/sites/:id/segments/preview        ← dry-run without saving
```

### Trigger workflows (automations)
"If event → actions" rules. `trigger_type`: `form_submitted`,
`quiz_completed`, `email_opened`, `email_clicked`, `call_booked`,
`call_status_changed`, `stage_changed`, `tag_added`, `contact_created`,
`score_threshold`, `segment_entered`, `manual`. `trigger_config` filters
(e.g. `{"quiz_slug":"qualifica-lead","min_score":8}`). Ordered actions:
`add_tag`, `remove_tag`, `set_stage`, `send_campaign`, `send_sequence`,
`create_task`, `notify_email`, `wait_days` (delayed queue in the tick).
Idempotent: the same campaign is never re-sent to the same contact.
```text
GET    /api/agent/sites/:id/workflows               ← list
POST   /api/agent/sites/:id/workflows               ← create { name, trigger_type, trigger_config?, actions:[{action_type, action_config}] }
PUT    /api/agent/sites/:id/workflows/:workflowId   ← update (actions replaces all)
DELETE /api/agent/sites/:id/workflows/:workflowId   ← delete
GET    /api/agent/sites/:id/workflows/:workflowId/runs ← run log
POST   /api/agent/sites/:id/workflows/:workflowId/test ← dry-run (lists actions, executes nothing)
```

### Lead scoring
Event→points rules + min_score→action thresholds (set_stage/add_tag/
notify_email). Automatic decay: score × 0.95 for every day without events
(scheduler tick). `score`/`add_score` also settable manually.
```text
GET/POST/PUT/DELETE /api/agent/sites/:id/scoring-rules
GET/POST/DELETE     /api/agent/sites/:id/scoring-thresholds
```

### Sales tasks + funnel
Tasks assigned to users (filters assignee/status/email, `status done` sets
`done_at`). Daily funnel snapshot per UTM channel (visits → leads → calls →
wins + revenue), computed by the scheduler.
```text
GET/POST/PUT/DELETE /api/agent/sites/:id/tasks
GET    /api/agent/sites/:id/funnel                  ← snapshots per channel/day
```

### Email tracking (open/click) + UTM
Emails (campaigns and sequences) already include the existing open pixel;
http/https links are rewritten to `/track/click/:kind/:sendId?u=...` (safe
redirect, http/https only, no userinfo/javascript). Statistics:
```text
GET /api/agent/sites/:id/email-stats/:campaignId        ← campaign open/click
GET /api/agent/sites/:id/email-stats/sequence/:sequenceId ← per step
```
UTM: forms capture `utm_source`/`utm_medium`/`utm_campaign` (hidden fields
or query params); the FIRST source wins on `contacts.utm_*` +
`first_source`. Disable with site variable `tracking_email_enabled=0`.

### Contact preferences (granular GDPR)
Per-channel consent (`pref_email/sms/phone/whatsapp/marketing`) + public
page `/preferences/:token` (email link via `{{pref_url}}`). Turning off
email/marketing also unsubscribes from the newsletter.
```text
POST /api/agent/sites/:id/contacts/:email/pref-token   ← generate token
GET  /api/agent/sites/:id/contacts/:email/extras       ← score+utm+prefs+events
PUT  /api/agent/sites/:id/contacts/:email/extras       ← update score/prefs/utm
```

### Lead notes (timeline)
Besides the single `notes` field (compat), every contact has a timeline of
multiple notes with author (`author_type: human|agent|system`,
`author_name`). Each note fires the `note_added` event (workflow/scoring).
Use them after every meaningful interaction so the lead history stays
readable by humans.
```text
GET    /api/agent/sites/:id/contacts/:email/notes        ← timeline
POST   /api/agent/sites/:id/contacts/:email/notes        ← add
       body: { body, author_type?, author_name? }
DELETE /api/agent/sites/:id/contacts/:email/notes/:noteId ← delete
```

### Conversations (email/WhatsApp)
One thread per contact+channel with the full in/out message history.
Emails sent by campaigns/sequences are recorded here automatically
(outbound). The **whatsapp channel is NOT sent by the CMS**: an external
bot (Baileys, e.g. ExampleBot) records in/out messages via the API — the CMS
is just the single archive of the conversation.
Each message fires `conversation_message`; status changes
`open|pending|closed` fire `conversation_status_changed`.
```text
GET    /api/agent/sites/:id/conversations                 ← threads (filters email/channel/status)
GET    /api/agent/sites/:id/conversations/:convId/messages ← full history
POST   /api/agent/sites/:id/contacts/:email/conversations/:channel/messages
       channel: email|whatsapp — body: { direction: in|out, subject?, body, meta? }
PATCH  /api/agent/sites/:id/conversations/:convId          ← status or subject
DELETE /api/agent/sites/:id/conversations/:convId          ← delete thread
```

### Deals/opportunities + PDF quotes (26)
A deal tied to a contact and a pipeline: amount, probability (0-100),
stage, status open/won/lost. Quotes have line items `items:
[{description, qty, price}]` and status `draft → sent → viewed → signed`;
the client link is `/quote/:token` (public page + PDF generated on the
fly with pdfkit, no files on disk). Events: `opportunity_stage_changed`,
`opportunity_status_changed`, `quote_sent`, `quote_viewed`, `quote_signed`.
```text
GET/POST            /api/agent/sites/:id/opportunities
GET/PUT/DELETE      /api/agent/sites/:id/opportunities/:oppId
GET                 /api/agent/sites/:id/opportunities/:oppId   ← with quotes
GET/POST            /api/agent/sites/:id/quotes
GET/PUT/DELETE      /api/agent/sites/:id/quotes/:quoteId
POST                /api/agent/sites/:id/quotes/:quoteId/status  ← sent|viewed|signed
Public pages:       GET /quote/:token · GET /quote/:token/pdf · POST /quote/:token/sign
```

### Clients + services (GENERIC client area)
A contact can be marked as "client" (`is_client`) with a status
(`active` | `suspended` | `inactive`). The services catalog is configurable
(e.g. `portale`, `whatsapp`, `calendario`) and each service can be
activated/deactivated per client. An EXTERNAL service (e.g. a dedicated
client area) calls the access check to know whether a client may use a
service: true only if client active + service active in catalog + service
assigned. An opportunity that becomes `won` automatically marks the contact
as an active client (if not already).
```text
GET/POST            /api/agent/sites/:id/services-catalog          ← catalog
PATCH/DELETE        /api/agent/sites/:id/services-catalog/:key
GET                 /api/agent/sites/:id/clients?status=active     ← clients
GET                 /api/agent/sites/:id/clients/:contactId
POST                /api/agent/sites/:id/clients/:contactId/mark   ← { is_client, client_status }
GET                 /api/agent/sites/:id/clients/:contactId/services
POST                /api/agent/sites/:id/clients/:contactId/services/:serviceKey/set ← { active, config? }
GET                 /api/agent/sites/:id/clients/:contactId/access/:serviceKey  ← { has_access }
GET                 /api/agent/sites/:id/clients/access-by-email?email=…&service=… ← for external service
```

### Contact merge
Merges a contact into another: tags union, max score/value, most advanced
stage, first UTM; re-links submissions/calls/tasks/events; deletes the
source. Transactional.
```text
POST /api/agent/sites/:id/contacts/:email/merge  body: { into_email: "..." }
```

### Multiple pipelines
Multiple boards with custom stages (one per service/niche).
`contacts.pipeline_id` NULL → site default pipeline (or legacy board).
```text
GET/POST/PUT/DELETE /api/agent/sites/:id/pipelines
```

## TRACKING & ANALYTICS (GA4, Meta Pixel/CAPI, GTM, Clarity)

```
GET    /api/agent/sites/:id/tracking                    ← current config (CAPI token masked)
PUT    /api/agent/sites/:id/tracking                    ← { ga4Id?, gtmId?, metaPixelId?, metaCapiToken?, metaCapiTestCode?, clarityId?, searchConsoleVerification?, consentBannerText?, consentAcceptLabel?, consentRejectLabel?, consentPrivacyUrl? }
```

No module to enable: as soon as one of these keys is set (GA4, GTM, Pixel,
or Clarity), the corresponding script and the **GDPR consent banner**
(Consent Mode v2: `ad_storage`/`analytics_storage`/`ad_user_data`/
`ad_personalization`, denied by default) automatically appear on the
public site — for ALL layout modes. `wrapped` pages get them from the
layout (`views/partials/tracking-head.ejs` in `<head>` and
`tracking-body.ejs` before `</body>`); `standalone` pages get them stitched
into the saved HTML by `injectTrackingIntoStandalone` (`serve.js` +
`static-export.js`, same logic as the SEO semi-wrapped). Under the hood it
reuses the existing generic per-site `settings` table (`tracking_*` keys),
so it's also reachable via `GET/PUT /api/agent/sites/:id/settings/:key`
with those keys if preferred.

⚠️ **Do NOT combine native tracking with manual banner/scripts already in a
standalone page's template**: enabling GA4 via API makes the CMS banner
appear next to the handwritten one and GA4 loads twice (double counting).
If a standalone site already runs a GDPR-compliant manual banner (e.g.
Example Site 1), keep the `tracking_*` keys empty — that's the current setup.

**Customizable banner texts** (`consentBannerText`, `consentAcceptLabel`,
`consentRejectLabel`, `consentPrivacyUrl` for an optional "Learn more"
link, e.g. to the site's privacy policy page): if left unset/empty, they
fall back to sensible Italian defaults. Same logic as `ai_disclosure_text`
below: only propose customizing them if the user asks or has a specific
context (brand voice, a language other than Italian, etc.) — don't change
them "by default".

**Never send both GA4 and GTM if GA4 is already managed inside GTM** —
double-counts pageviews.

### Meta Conversions API (server-side)

If `metaPixelId` + `metaCapiToken` are configured, the app sends three
standard Meta events on its own (no agent action needed) at the real
conversion moments already present:

| Meta event | When |
|---|---|
| `Lead` | a public form is submitted |
| `CompleteRegistration` | newsletter subscription confirmed (email link clicked) |
| `Schedule` | a call is booked via `/book/:siteId` |

Every send is **gated by the visitor's marketing consent** (cookie
`consent_marketing=1`, set by the banner) — if consent wasn't granted, the
event is silently skipped, no error. No server-side PageView event:
statically-exported pages are served by Caddy, outside Express's
visibility, and the client-side pixel already covers PageView.
`metaCapiToken` is never returned in clear by `GET .../tracking`; to
generate one: Meta Events Manager → the Pixel's event → Settings →
Conversions API → Generate access token.

## SEO (canonical, Open Graph, JSON-LD, noindex, robots.txt/sitemap)

```
GET    /api/agent/sites/:id/pages/:pid/seo             ← a page's meta/canonical/noindex/OG
PUT    /api/agent/sites/:id/pages/:pid/seo             ← { meta_title?, meta_description?, meta_keywords?, canonical_url?, noindex?, og_image? }
GET    /api/agent/sites/:id/seo                        ← site-wide SEO defaults
PUT    /api/agent/sites/:id/seo                        ← { defaultOgImage?, twitterHandle?, robotsExtra? }
```

**Read this before using `pages/:pid/seo`**: the fields affect BOTH layout
modes. On `layout_mode="wrapped"` pages the tags come from the CMS layout
(`views/layouts/site.ejs`). On `layout_mode="standalone"` pages — the most
common case on this platform, e.g. every page of example-site-2.it
and example-site-1.it — the HTML is what's saved in `content`, but the SEO fields
are stitched into the `<head>` at live-render time (serve.js) and at static
export (Caddy): NON-destructive override — an empty field leaves the
handwritten tag in the template untouched (e.g. the article `<title>`), a
filled field replaces the existing tag or inserts it before `</head>`.

Supported fields: `meta_title` (replaces/inserts `<title>`),
`meta_description`, `meta_keywords`, `canonical_url` (canonical + og:url),
`og_image` (og:image + twitter:image), `noindex` (`X-Robots-Tag` header on
live rendering + `<meta name="robots" content="noindex,follow">` in the
statically exported HTML — Caddy serves static files without going through
Express, so the header alone wouldn't reach them), plus derived Open
Graph/Twitter tags and the WebPage JSON-LD (injected ONLY if the HTML does
not already contain one: a handwritten schema, e.g. Article, wins).

So for standalone SEO you no longer need to hand-write tags in the HTML:
just `PUT .../seo`. Handwritten tags remain valid as fallback while the
fields are empty. Example:
```html
<!-- handwritten in the template: stays while meta_title is empty -->
<title>Article title</title>
```

**Site-wide defaults** (`GET/PUT .../seo`): `defaultOgImage` is the
fallback for pages that don't set their own `og_image` — both `wrapped` and
`standalone` (for the latter when the page's `og_image` field is empty; the
image is still stitched into `<head>`). `robotsExtra`: one robots.txt
directive per line (`User-agent`, `Disallow`, `Allow`, `Crawl-delay`,
`Sitemap`, or `#` comments) — non-conforming lines are silently dropped.
Useful to block specific AI crawlers:
```
User-agent: GPTBot
Disallow: /
```
**Don't use `Disallow` for a page that should just be `noindex`**: a
`Disallow` stops crawlers from reading the page at all, so they never even
see its `noindex` tag — the two mechanisms conflict, they don't stack.

Under the hood it reuses the generic per-site `settings` table (`seo_*`
keys), so `GET/PUT .../seo` is also reachable via `GET/PUT
/api/agent/sites/:id/settings/:key` with those keys, if preferred — same
pattern as `/tracking`.

The sitemap (`GET /sitemap.xml`) automatically excludes `noindex` pages;
robots.txt (`GET /robots.txt`) includes the site's `robotsExtra`.

## AI-GENERATED CONTENT DISCLOSURE (AI Act Article 50)

Not a dedicated endpoint: it's a site_variable like any other (`brand_name`,
`legal_line`, etc.), key `ai_disclosure_text`, manageable with the
already-existing endpoints:

```
PUT    /api/agent/sites/:id/variables/ai_disclosure_text   ← { value: "disclosure text" }
DELETE /api/agent/sites/:id/variables/ai_disclosure_text   ← removes the disclosure
```

If set, the text appears at the bottom of every public page (footer).
**Do not set it by default or "just in case"**: Article 50 requires this
disclosure only for AI-generated/manipulated text "published with the
purpose of informing the public on matters of public interest" (e.g.
articles, in-depth pieces) — **it does not apply** when a human reviews
the text and holds editorial responsibility before publishing, which is
this CMS's normal flow (AI drafts, a user saves/publishes). Only propose
enabling it if the user describes an actual case of AI-published content
with little or no review on matters of public interest — when in doubt,
ask before enabling it; this isn't a technical decision to make on your
own.

## FOOTER TAGLINE

Public sites can show a tagline under the name/brand in the footer. Two
equivalent ways (the site variable wins over the .env):

- **Global**: `FOOTER_TAGLINE` environment variable in the server's `.env`
  (empty = row hidden, the default).
- **Per site** (recommended if sites have different tones): site_variable
  `footer_tagline`, managed with the existing variable endpoints:

```
PUT    /api/agent/sites/:id/variables/footer_tagline   ← { value: "Your tagline" }
DELETE /api/agent/sites/:id/variables/footer_tagline   ← removes (row hidden)
```

The footer is a shared partial (`views/partials/footer.ejs`): the row
appears on every page of the site using the CMS layout. On standalone sites
(HTML saved in `content`) the tagline must be added by hand to the
template, like the rest of the footer — it is not injected automatically.
Don't invent default taglines: if neither is configured, the row is simply
not rendered.

## GDPR RIGHTS OVER A CONTACT'S DATA (access, portability, erasure)

A person's data is spread across multiple tables with no common FK (form
submissions, contact row, calls, newsletter subscription — email is the
only link). `contact_export`/`contact_erase` gather/delete it all in one
shot instead of having to cross-reference `forms_submissions`,
`pipeline_board`, `calls_list`, etc. by hand.

`contact_erase` is **permanent and irreversible** (a real delete, not a
"deleted" flag): only use it on the user's explicit request to fulfil a
real visitor's GDPR erasure request — never as generic data cleanup,
never "just to be safe", never without the user confirming the exact
email to delete. If in doubt about the contact's identity, show
`contact_export` (or `contact_timeline`) first and have the user confirm
before proceeding with erasure.

---

## PHASE 2 — Operational roadmap completed (26-44, 15/08/2026)

All 18 Phase 2 items are implemented, tested (312 tests) and exposed as
agent routes + MCP tools (301 total tools). Overview:

- **27 — Recurring tasks + smart follow-up**: `recurring-tasks` (daily/
  weekly/monthly/custom cadence, auto-generation via tick), `followup-rules`
  (conversation waiting N days → create_task/notify_email/add_tag),
  idempotent `followup-runs` log.
- **28 — Granular roles/permissions, operator shifts, audit**: custom
  `roles` with per-module permissions (`crm_list_roles`...), `shifts`,
  `operators-on-duty`, filtered `audit-events` search.
- **29 — Channel conversational runtime**: `agent-runtimes` with ordered
  rules (contains/starts/equals/regex), contact/segment/tag matching, GDPR
  preferences respected (pref_whatsapp=false → skip), optional LLM, dry-run
  test. WhatsApp is NEVER sent by the CMS (log + external Baileys bot).
- **30 — Knowledge base + full-text search**: `kb` articles (category, tags),
  GIN `to_tsvector('italian')` index, ranked `kb/search`.
- **31 — Agent builder + sandbox**: `agent-definitions` (prompt/channels/
  tools config), dry-run sandbox test (`/test`), `sandbox-runs` history.
- **32 — Human-in-the-loop**: `approvals` (kind outbound_message/task/quote/
  campaign/contact_change/custom), approve executes the payload, reject/delete.
- **33 — AI call summaries**: `call-summaries` (LLM if configured, template
  fallback), action items + next step, human correction.
- **34 — Operator reply suggestion**: `reply-suggestions` generated from
  conversation + KB, approve/dismiss with one click.
- **35 — Webhooks in/out**: public endpoint `/webhooks/in/:siteId/:token`
  (event mapping → actions), outbound webhooks with HMAC signature,
  `webhook-deliveries` queue with retry/backoff (hooked into
  `emitContactEvent`).
- **36 — Google OAuth**: `oauth-apps` + authorization code flow
  (auth-url/exchange/refresh/disconnect), `/oauth/callback/:provider`.
- **37 — Bidirectional calendar sync**: `calendar-sync-configs`
  (calls ↔ Google Calendar, push/pull), execution logs; fails cleanly
  without OAuth.
- **38 — Stripe payment links**: `payment-links` with public token
  `/pay/:token` (page + confirm), real Stripe if `STRIPE_SECRET_KEY` set,
  `payment_paid` event.
- **39 — Full export/import**: `data-export` (multi-table JSON or contacts
  CSV), `data-import` (contacts/tasks upsert with `import-jobs` log).
- **40 — Realtime dashboard**: `dashboard/kpis` (leads by channel, pipeline
  value, task SLA, recent activity), saved views, `/admin/dashboard` UI.
- **41 — Periodic reports**: `report-configs` (weekly/monthly, sections,
  recipients), generate (dry-run) / send (email) / runs; scheduler tick.
- **42 — Sandbox/staging**: `sandbox/run` dry-run for segment/workflow/
  agent/quote with `sandbox-runs` log and reusable scenarios.
- **43 — Backups with history**: `backup-jobs` (manual run, list, detail,
  delete; failures are recorded too).
- **44 — Channel rate-limits with alerts**: `channel-limits` (email/
  whatsapp/call/sms/chat per hour/day), atomic `consume`, email alert on
  exceed, `channel-usage` history.
- **45 — Tracked links (QR/short link)**: per-site `tracked-links` with
  `target_url`, unique `slug`, `channel`/`utm_campaign` (funnel hook),
  `qr_enabled`; public endpoint `/go/:slug` (counts visit + 302) and
  `/go/:slug.qr` (QR PNG); visit stats (total/unique/daily).

Unchanged constraint: **WhatsApp is never native** — the CMS only records
messages; sending remains with external Baileys engines (ExampleBot) via
agent/MCP APIs.
