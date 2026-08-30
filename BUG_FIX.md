# BUG_FIX.md — Verified Remaining Bugs

*Generated from actual codebase verification (not from stale audit plans). Old planning files piano_*.md have been deleted.*

## ✅ Already Fixed — Verified in Current Code

These bugs from the old audit plans are **already resolved**. The code has been updated since the August 2026 audit plans were written.

### 1. token_version increment on logout ✅ FIXED
- **File**: `src/routes/auth.js:86`
- **Status**: Verified — `await query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [decoded.sub])` incrementally updates token_version on logout.
- **Previously flagged**: piano_bug_fix §3, piano_dettagliato §3.9 claimed it was "never incremented" — now it is.

### 2. Page deletion: audit log + IDOR guard ✅ FIXED
- **File**: `src/routes/pages.js:437-455` (`/admin/pages/:id/delete`)
- **Status**: Verified — ownership check `if (req.user.role !== "superadmin" && page.site_id !== req.user.site_id)` + `auditLog()` call with oldData.
- **Previously flagged**: piano_bug_fix §5 item 5 and §1 claimed missing auditLog — now present.

### 3. IDOR in social posts (agent route) ✅ FIXED
- **File**: `src/routes/agent.js:3733-3736` (`POST /api/agent/sites/:siteId/social-posts`)
- **Status**: Verified — `SELECT id FROM pages WHERE id = $1 AND site_id = $2` before INSERT; returns 404 if page doesn't belong to site.
- **Previously flagged**: piano_bug_fix §4 claimed "must verify before INSERT" — now done.

### 4. `sameSite` function handles NULL site_id correctly ✅ FIXED
- **File**: `src/routes/users.js:10-19`
- **Status**: Verified — properly handles: superadmin always allowed, target NULL → deny for non-superadmin, actor NULL → deny, explicit comparison `targetSiteId === actorSiteId`.
- **Previously flagged**: piano_bug_fix §2 claimed "bypass ownership with site_id NULL" — the `sameSite()` function now handles it correctly.

### 5. Page delete route has ownership check ✅ FIXED
- **File**: `src/routes/pages.js:437-455` (the `/:id/delete` route)
- **Status**: Verified — non-superadmin cannot delete pages not belonging to their site.

---

## 🔴 Confirmed Still Present — Real Open Bugs

### 6. Social posting is a **stub** — NOT IMPLEMENTED ❌
- **File**: `src/routes/newsletter.js:89`
- **Evidence**: Comment in code: `"solo 'simulato' (il posting reale non è implementato, vedi social-poster.js)"`
- **Status**: Completely unimplemented — social posting silently does nothing. Real API calls not implemented.
- **Previously flagged**: piano_bug_fix §13, piano_dettagliato §3.2 item 39 both flagged this — still open.

---

## ⚪ Status Unknown — Not Verified

The remaining entries from the old audit plans could not be verified in this session. The codebase has evolved since the audit plans were written (August 2026), and many issues may have been resolved or may have new locations. These require systematic re-audit.

**Do not list unverified bugs.** Only confirmed, verified issues appear above.