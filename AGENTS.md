# Specialized Development Agents

## 1. `mcp-worker-architect`
**Expertise:** MCP Protocol & Durable Object Orchestration
- **Responsibilities:**
    - Maintain the `MCPSession` Durable Object class and its dual-transport architecture.
    - Own the **Streamable HTTP** transport (MCP 2025-03-26) via `OneShotTransport`: each `POST /mcp` request must return the JSON-RPC response inline in the HTTP body. This is the primary transport — all new features are implemented here first.
    - Own the **legacy SSE** transport (MCP 2024-11-05) via `CloudflareSSEServerTransport`: handle SSE lifecycles, ensure `no-transform` headers and aggressive stream flushing prevent Cloudflare buffering, and maintain the 15-second keep-alive heartbeat.
    - Ensure shared tool logic (`toolDefinitions`, `dispatchToolCall`, `registerHandlers`) is applied identically to both transport paths.
    - Guarantee exact MCP capability compliance (e.g., `listChanged: true`, tool `annotations`) to satisfy strict client UI requirements.
    - Implement robust error handling: return `{"error":"Internal Server Error"}` to HTTP clients; emit full stack traces to `console.error` only. Never send `e.stack` or `e.message` in response bodies. **(Finding 6)**
    - Enforce a 512 KB max body size on all `POST` handlers before calling `request.json()`. **(Finding 8)**
    - Validate document IDs against `^[a-zA-Z0-9_-]{25,55}$` before any Google API call. **(Finding 9)**
    - Re-validate session tokens against KV in all DO handlers (`handleStreamablePost`, `tools/list`) to ensure immediate revocation enforcement. **(Finding 22)**

## 2. `google-workspace-integrator`
**Expertise:** Google APIs & Markdown Transformation
- **Responsibilities:**
    - Implement and maintain the OAuth 2.0 flow with background token refresh logic.
    - After every token exchange, verify `tokens.scope` contains all required scopes before storing. Redirect to consent with an error if any scope is missing. **(Finding 13)**
    - Encrypt the full OAuth token blob (including `refresh_token`) in AES-GCM before writing to KV, and decrypt on read, using the `TOKEN_ENCRYPTION_KEY` Wrangler secret. **(Finding 4)**
    - Store `createdAt` and `expiresAt` (90-day TTL) metadata with each KV token entry. Reject tokens past `expiresAt` in `getAccessToken`. **(Finding 14)**
    - Sanitise all dynamic values embedded in HTML responses using an `escapeHtml` helper before interpolation (OAuth success page, home page). **(Finding 3)**
    - Guard against memory exhaustion by checking the `Content-Length` of Google API responses; reject documents exceeding 10MB. **(Finding 23)**
    - Sanitise Drive API search queries: strip `(`, `)`, `'`, `"`, `\` and truncate to 200 characters before forming the query predicate. **(Finding 7)**
    - Parse Google API error bodies as JSON where possible; strip HTML tags and truncate to 300 characters before including in thrown errors. **(Finding 12)**
    - Maintain the Google Docs JSON-to-Markdown conversion engine (`docToMarkdown`) and the single-pass inline formatter (`processInlineFormatting`).
    - Maintain context-based editing (`replaceSection`) and append (`appendText`), ensuring batch-update index calculations remain correct.
    - Ensure robust input handling (bare IDs vs. full Google Docs URLs).

## 3. `cloudflare-ops-expert`
**Expertise:** Cloudflare Ecosystem & Deployment
- **Responsibilities:**
    - Manage `wrangler.toml`, KV namespaces, and Durable Object migrations.
    - Set `workers_dev = false` in `wrangler.toml` for all production deployments to prevent exposure via the secondary `*.workers.dev` hostname. **(Finding 15)**
    - Enforce a strict **CORS allowlist** — do not echo arbitrary `Origin` headers. `Access-Control-Allow-Origin` must only be set when the `Origin` matches an entry in `ALLOWED_ORIGINS` (e.g., `["https://claude.ai"]`). `Access-Control-Allow-Credentials: true` must never be paired with a wildcard origin. **(Finding 2)**
    - Implement per-IP rate limiting on `/auth/login` and `/auth/callback` (10 req / IP / minute) and per-token rate limiting on `/mcp` tool calls (120 req / token / minute) using KV counters with TTL. Return `429 Too Many Requests` with a `Retry-After` header. **(Finding 10)**
    - Change `/auth/logout` to `POST` and update the home page form to `method="POST"`. **(Findings 5 & 16)**
    - Add `Content-Security-Policy`, `Strict-Transport-Security`, and `Permissions-Policy` headers to all HTML responses. **(Finding 17)**
    - Mask all token values in `console.log` calls — use a truncated SHA-256 hash (first 8 hex chars) for correlation rather than the raw token. **(Finding 1)**
    - Optimize memory usage within Worker/Durable Object limits.

## 4. `cybersecurity-sec-ops`
**Expertise:** Security Review & Threat Mitigation
- **Responsibilities:**
    - Perform regular audits of OAuth flows and token storage mechanisms.
    - Own the **Security Findings & Remediation Roadmap** documented in `GEMINI.md`. Track all 20 findings to resolution; update `GEMINI.md` when a finding is closed.
    - **Priority 1 (pre-production — must fix before real user data): all complete ✅**
        - ~~Finding 1: Remove raw token logging; use SHA-256 hash prefix for correlation.~~ ✅ `tokenTag()` in `index.ts`.
        - ~~Finding 2: Replace dynamic CORS origin echo with an explicit allowlist.~~ ✅ `ALLOWED_ORIGINS` + `buildCorsHeaders()` in `index.ts`.
        - ~~Finding 3: Escape all dynamic values in HTML responses; add CSP header.~~ ✅ `escapeHtml()`, per-request nonce, and security headers in `auth.ts`.
        - ~~Finding 4: Encrypt OAuth token blobs in KV using AES-GCM (`TOKEN_ENCRYPTION_KEY`).~~ ✅ `encryptData()` / `decryptData()` in `auth.ts`.
        - ~~Finding 5: Change logout to `POST`; enforce token ownership before deletion.~~ ✅ `POST`-only `/auth/logout` reads token from body; KV existence check before delete. Also resolves Finding 16.
        - ~~Finding 6: Strip stack traces from HTTP 500 response bodies.~~ ✅ `index.ts` and `session.ts` catch blocks both return `{"error":"Internal Server Error"}` JSON.
        - ~~Finding 7: Sanitise Drive API query strings against injection.~~ ✅ `searchDocuments` strips `()'"\\`, truncates to 200 chars.
        - ~~Finding 8: Enforce 512 KB POST body limit and Markdown parser size caps.~~ ✅ `handleStreamablePost` checks `Content-Length`; `markdownToBatchUpdates` caps at 100 KB / 5 000 lines.
        - ~~Finding 9: Validate document IDs against `^[a-zA-Z0-9_-]{25,55}$`.~~ ✅ `extractDocumentId` validates against `DOC_ID_RE`.
        - ~~Finding 10: Enforce rate limits on auth and tool-call endpoints via KV counters.~~ ✅ `checkRateLimit()` in `index.ts`; 10 req/IP/min on auth, 120 req/token/min on `/mcp`.
    - **Priority 2 (Sprint 1): all complete ✅**
        - ~~Finding 11: Delete OAuth state before token exchange to close the replay window; bind state to client IP.~~ ✅ State stores `CF-Connecting-IP`; deleted before token exchange; IP verified at callback.
        - ~~Finding 12: Sanitise Google API error messages before including them in thrown errors.~~ ✅ `extractApiError()` in `google-api.ts`; token exchange error generic in `auth.ts`.
        - ~~Finding 13: Verify returned OAuth scopes against required list; reject partial grants.~~ ✅ `REQUIRED_SCOPES` checked in `handleAuthCallback`; 403 error page on mismatch.
        - ~~Finding 14: Add `createdAt`/`expiresAt` (90-day TTL) to KV token entries; reject expired tokens.~~ ✅ `TOKEN_LIFETIME_MS` constant; `expiresAt` enforced in `getAccessToken`.
        - ~~Finding 15: Set `workers_dev = false` in `wrangler.toml` for production.~~ ✅ Done.
    - **Priority 3 (Sprint 2): all complete ✅**
        - ~~Finding 16: Enforce `POST` method on `/auth/logout` to prevent CSRF logout.~~ ✅ Resolved by Finding 5.
        - ~~Finding 17: Add CSP, HSTS, and `Permissions-Policy` to all HTML responses.~~ ✅ Security headers on home page, logout page (`index.ts`) and scope-error page (`auth.ts`); auth success page already done in Finding 3.
        - ~~Finding 18: Implement per-token Google API call throttle (100 calls / token / minute).~~ ✅ `checkRateLimit()` from `utils.ts` applied in `dispatchToolCall`; 100 calls/token/min via `google:<token>` KV counter.
        - ~~Finding 19: Re-validate token against KV inside the DO's `/sse` handler.~~ ✅ KV lookup added before accepting SSE connection; returns 401 if token is revoked.
        - ~~Finding 20: Replace inline `<script>` blocks with hashed or nonce-scoped scripts under CSP.~~ ✅ Resolved by Finding 3; per-request nonce on auth success page; other pages have no scripts.
    - **Priority 4 (Post-Hardening): all complete ✅**
        - ~~Finding 21: Sensitive HTML pages cached by browser; add `Cache-Control: no-store`.~~ ✅ Added to `index.ts` and `auth.ts`.
        - ~~Finding 22: Partial revocation enforcement in DO; add KV checks to `/streamable` and `tools/list`.~~ ✅ Added to `session.ts`.
        - ~~Finding 23: Memory exhaustion from large documents; add 10MB Content-Length limit.~~ ✅ Added to `getDocument` in `google-api.ts`.
        - ~~Finding 24: Inefficient CORS preflights; add `Access-Control-Max-Age`.~~ ✅ Added to `buildCorsHeaders` in `index.ts`.
    - Validate CSRF protection (state parameter TTL, first-use deletion, IP binding).
    - Ensure the `TOKEN_ENCRYPTION_KEY` secret is rotated on a defined schedule and that re-encryption of existing KV entries is handled during rotation.
    - Review all new code changes that touch `auth.ts`, `index.ts`, `session.ts`, or `google-api.ts` before merge.
