# Project Mandates: Google Docs MCP on Cloudflare Workers

This project implements a Model Context Protocol (MCP) server for Cloudflare Workers, enabling AI clients (Claude.ai, Gemini, etc.) to read, search, and edit Google Documents.

## Core Technical Stack

- **Runtime**: Cloudflare Workers with **Durable Objects** (stateful MCP sessions per user token).
- **Transports**: Both **Streamable HTTP** (MCP 2025-03-26, primary) and **SSE** (MCP 2024-11-05, legacy).
- **Auth**: OAuth 2.0 (Google) with **automatic token refresh** via Cloudflare KV.
- **Persistence**: Cloudflare KV (user OAuth tokens, CSRF states, rate-limit counters).
- **APIs**: Google Docs REST API (`batchUpdate`) and Google Drive REST API.
- **SDK**: `@modelcontextprotocol/sdk` ^1.29 with Zod v4.

## Architectural Principles

### 1. Dual Transport Support

Two MCP transports are available, both routing through the same Durable Object:

**Streamable HTTP** (`POST /mcp?token=X`) — recommended for all new clients:
- The client POSTs a JSON-RPC message directly to the endpoint.
- The server returns the JSON-RPC response **inline** in the HTTP response body (`application/json`).
- No persistent connection required; each request is self-contained.
- Implemented via `OneShotTransport`: a `Transport` that captures the server's `send()` call and resolves a `Promise`, allowing the DO's fetch handler to `await` the result and return it directly.

**Legacy SSE** (`GET /mcp/sse?token=X`) — for backward compatibility:
- Client opens a persistent SSE stream; server sends an `event: endpoint` pointing to the POST messages URL.
- Client POSTs JSON-RPC messages to `/mcp/messages?token=X`; server responds over the SSE stream.
- Implemented via `CloudflareSSEServerTransport`: a custom `Transport` wrapping a `ReadableStream` with a `setInterval` keep-alive heartbeat (every 15 seconds) to prevent Cloudflare from severing idle connections.
- The DO must be live for POST messages to reach the correct transport instance.

### 2. Stateful Sessions via Durable Objects

Each `userToken` maps to one Durable Object instance (`MCPSession`). The DO:
- Stores the `userToken` in durable storage (`this.state.storage`) so tool calls can look up Google OAuth credentials even after the DO restarts.
- Maintains two independent server/transport pairs: one for SSE (`this.server` / `this.transport`) and one for Streamable HTTP (`this.streamableServer` / `this.streamableTransport`). This prevents the two modes from interfering with each other.
- Lazily initialises the Streamable HTTP server on first POST request (`ensureStreamableServer()`), keeping it alive for the DO's lifetime to amortise setup cost.

### 3. Shared Tool Logic

Tool definitions (`toolDefinitions` getter), tool dispatch (`dispatchToolCall`), and MCP handler registration (`registerHandlers`) are defined once on `MCPSession` and applied to both the SSE and Streamable HTTP `Server` instances. This ensures identical behaviour regardless of which transport the client uses.

### 4. Strict Cloudflare SSE Handling

For the legacy SSE transport:
- **Buffering prevention**: Responses include `Cache-Control: no-cache, no-transform` and `Content-Encoding: identity`. An initial `: connected\n\n` SSE comment is enqueued immediately to flush the stream before the `event: endpoint` payload.
- **Keep-alive**: A `setInterval` heartbeat sends `: keepalive\n\n` every 15 seconds; Cloudflare silently closes idle SSE connections without it.

### 5. CORS Policy

CORS is handled in `index.ts` before every response. The required policy is:

- **Allowed origins**: An explicit allowlist of known MCP client origins (e.g., `https://claude.ai`). The `Origin` header must match an entry in this list before `Access-Control-Allow-Origin` is echoed back.
- **Credentials**: `Access-Control-Allow-Credentials: true` is set **only** when the origin is on the allowlist. It must never be combined with a wildcard origin.
- **Preflight**: `OPTIONS` responses echo `Access-Control-Request-Headers` verbatim so client telemetry headers (`baggage`, `sentry-trace`, etc.) are not blocked.

> **Implemented**: `ALLOWED_ORIGINS` in `index.ts` lists permitted origins (`https://claude.ai`, `https://app.claude.ai`). `Access-Control-Allow-Origin` and credentials are only set when the request `Origin` matches. Unrecognised origins receive no CORS headers. See Security Finding #2.

### 6. Markdown-First Document I/O

- **Reading** (`docToMarkdown`): Converts the Google Docs JSON structure to Markdown — headings, bold, italic, bullet lists, tables.
- **Writing** (`markdownToBatchUpdates`): Converts Markdown to a sequence of `insertText`, `updateParagraphStyle`, and `updateTextStyle` batch-update requests. Inline formatting (bold/italic) is processed in a **single pass** to ensure character indices remain correct regardless of marker order. Input is subject to size and line-count limits (see Security Finding #8).

### 7. Context-Based Section Editing

`edit_section` finds the target heading by case-insensitive text match, then deletes from the **end** of the header paragraph (`element.endIndex`) to the start of the next same-or-higher-level heading (or end of document). The header itself is never deleted. New content is inserted at the same position using `markdownToBatchUpdates`.

### 8. Security Architecture

The intended security posture is documented here. Items marked **[REQUIRED FIX]** are not yet implemented and must be addressed before production use. Items marked **[FIXED]** have been implemented. See the Security Findings section for full details.

- **CORS allowlist** [FIXED]: `buildCorsHeaders()` in `index.ts` enforces `ALLOWED_ORIGINS`; credentials never paired with an unknown origin.
- **Token transport** [REQUIRED FIX]: Migrate Streamable HTTP auth from query-string tokens to `Authorization: Bearer` headers. SSE requires the token in the URL due to browser `EventSource` API limitations; its logs must be masked.
- **Token storage encryption** [FIXED]: `encryptData()` / `decryptData()` in `auth.ts` wrap all KV reads and writes with AES-GCM 256-bit encryption keyed by `TOKEN_ENCRYPTION_KEY`. Decryption failure forces re-authentication.
- **Token expiry and rotation** [FIXED]: `handleAuthCallback` stores `createdAt` and `expiresAt` (90-day TTL) in the encrypted KV blob. `getAccessToken` rejects and deletes tokens past `expiresAt` before any refresh attempt.
- **Logout ownership check** [FIXED]: `/auth/logout` is `POST`-only; token read from request body; KV existence check confirms possession before deletion. Home page form uses `method="POST"`.
- **Error responses** [FIXED]: Both `index.ts` and `session.ts` catch blocks return `{"error":"Internal Server Error"}` JSON with `Cache-Control: no-store`; full stack traces go to `console.error` only.
- **Stack trace leakage** [FIXED]: `e.stack` removed from all HTTP 500 response bodies in `index.ts` and `session.ts`.
- **Log masking** [FIXED]: `tokenTag()` in `index.ts` emits a truncated SHA-256 hash (first 8 hex chars) in place of raw token values in all `console.log` calls.
- **Rate limiting** [FIXED]: `checkRateLimit()` in `utils.ts` enforces fixed-window KV counters — 10 req / IP / min on auth endpoints, 120 req / token / min on `/mcp`, 100 Google API calls / token / min in `dispatchToolCall`. Returns `429` with `Retry-After: 60`.
- **Input validation** [FIXED]: Document IDs validated against `^[a-zA-Z0-9_-]{25,55}$` in `extractDocumentId`. Drive queries stripped of `()'"\\` and capped at 200 chars in `searchDocuments`. `handleStreamablePost` rejects bodies over 512 KB. `markdownToBatchUpdates` rejects content over 100 KB or 5 000 lines.
- **Scope validation** [FIXED]: `handleAuthCallback` splits `tokens.scope` (when present) and compares against `REQUIRED_SCOPES`. Returns a 403 error page if any scope is missing; user is prompted to re-authenticate.
- **HTML escaping** [FIXED]: `escapeHtml()` in `auth.ts` applied to all dynamic values on the OAuth success page. Per-request CSP nonce on the `<script>` tag. Security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, etc.) on all HTML responses.
- **CSRF Protection** [FIXED]: State parameter bound to client IP at generation time (`handleAuthLogin` stores `CF-Connecting-IP` as the state value). Callback verifies IP match and deletes the state *before* the token exchange call to close the replay race window.
- **Token Isolation**: Each user gets a unique UUID token; the Durable Object ID derives from this token, preventing cross-user data access.
- **Token Refresh**: `getAccessToken` refreshes the Google OAuth token if it expires within 5 minutes. On refresh failure (revoked, network error), it returns `null` rather than a stale token.
- **Scoped OAuth**: Only `documents` (read/write) and `drive.readonly` scopes are requested.
- **`workers_dev` hardening** [FIXED]: `workers_dev = false` in `wrangler.toml`; the `*.workers.dev` secondary hostname is no longer published.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login` | Redirect to Google OAuth consent |
| `GET` | `/auth/callback` | Handle OAuth callback, store tokens, return MCP URLs |
| `POST` | `/auth/logout` | Revoke token (must be POST; body: `{ token, proof }`) |
| `POST` | `/mcp?token=X` | **Streamable HTTP** MCP endpoint (recommended) |
| `GET` | `/mcp/sse?token=X` | Legacy SSE connection |
| `POST` | `/mcp/messages?token=X` | Legacy SSE message channel |

> `/auth/logout` accepts `POST` only. The token is passed in the request body (JSON `{ "token": "…" }` or `application/x-www-form-urlencoded`). The endpoint verifies the token exists in KV before deleting it. Findings 5 and 16 are both resolved.

## Operational Workflow

1. **Auth**: User visits `/auth/login` → Google consent → `/auth/callback` → receives two MCP URLs (Streamable HTTP + legacy SSE).
2. **Registration**: User pastes the Streamable HTTP URL into Claude.ai (Settings → Integrations).
3. **Tool Discovery**: Claude POSTs `initialize` then `tools/list` to `/mcp?token=X`; the DO responds inline with the 5-tool manifest.
4. **Tool Execution**: Claude POSTs `tools/call` to `/mcp?token=X`; the DO fetches the stored OAuth token, calls the Google API, and returns the result inline.

---

## Security Findings & Remediation Roadmap

This section documents all findings from the OWASP Top 10 security review. Each finding includes its severity, affected file(s), and the required fix. Findings are grouped by implementation priority.

---

### Priority 1 — Pre-Production (Critical / High)

These must be resolved before the server handles real user data.

#### Finding 1 — Token in query string logged in plaintext
**Severity**: Critical | **OWASP**: A02 Cryptographic Failures | **Status**: ✅ Fixed  
**Files**: `index.ts:87,107,137`

`console.log` calls include the raw `userToken` value. Query-string tokens also appear in Cloudflare access logs, browser history, and HTTP `Referer` headers leaked to any external resource on the page.

**Fix**:
- Remove all `console.log` statements that include `userToken`. Use a truncated SHA-256 hash for correlation: `crypto.subtle.digest('SHA-256', encoder.encode(token))` then take the first 8 hex chars.
- For the Streamable HTTP endpoint (`/mcp`), migrate authentication from `?token=X` in the URL to an `Authorization: Bearer X` header. The SSE endpoint cannot use headers (browser `EventSource` limitation), so token-in-URL is unavoidable there — log masking is the only mitigation for that path.

**Implemented**: `tokenTag()` added to `index.ts`. All three `console.log` calls now emit `token:<8-hex-chars>`. Token URL migration remains a separate open item.

---

#### Finding 2 — CORS echoes any origin with credentials
**Severity**: Critical | **OWASP**: A01 Broken Access Control | **Status**: ✅ Fixed  
**Files**: `index.ts:27-32`

Any origin can make credentialed cross-origin requests because `Access-Control-Allow-Origin` echoes the raw `Origin` header unconditionally while `Access-Control-Allow-Credentials: true` is set. This allows malicious third-party sites to call the API on behalf of authenticated users.

**Fix**:
```typescript
const ALLOWED_ORIGINS = ["https://claude.ai"];
if (origin && ALLOWED_ORIGINS.includes(origin)) {
  corsHeaders["Access-Control-Allow-Origin"] = origin;
  corsHeaders["Access-Control-Allow-Credentials"] = "true";
}
// Do not set Allow-Origin at all for unrecognised origins
```

**Implemented**: `ALLOWED_ORIGINS` constant and `buildCorsHeaders()` helper added to `index.ts`. Both the main handler and the catch block use the same helper. The error handler catch block also now returns `{"error":"Internal Server Error"}` JSON (Finding 6 partial fix) with `Cache-Control: no-store`.

---

#### Finding 3 — XSS on OAuth success page
**Severity**: Critical | **OWASP**: A03 Injection | **Status**: ✅ Fixed  
**Files**: `auth.ts:63-99`

`mcpUrl` and `mcpUrlLegacy` are interpolated into HTML without escaping. If `origin` can be influenced by an attacker (e.g., via a malformed redirect), arbitrary JavaScript executes in the user's browser at the exact moment their token is displayed.

**Fix**:
- Add an `escapeHtml` helper and apply it to all dynamic values embedded in HTML.
- Add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-<nonce>'` to the response headers.
- Move the inline `<script>` to a static external file or replace it with a `data-*` attribute approach that does not require `unsafe-inline`.

**Implemented**: `escapeHtml()` added to `auth.ts` and applied to both URL values before interpolation. Per-request nonce (`crypto.randomUUID()` stripped of hyphens) placed on the `<script nonce="…">` tag and mirrored in `script-src` of the CSP header. `onclick` attributes removed; event listeners attached inside the nonce-guarded script block. Response headers now include `Content-Security-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy`.

---

#### Finding 4 — OAuth tokens stored in plaintext KV
**Severity**: Critical | **OWASP**: A02 Cryptographic Failures | **Status**: ✅ Fixed  
**Files**: `auth.ts:58`

The full token JSON — including the long-lived `refresh_token` — is stored as a plaintext JSON string in Cloudflare KV. Anyone with Cloudflare account access or a KV API key can retrieve every user's refresh token.

**Fix**: Encrypt the token blob before storing and decrypt after reading, using AES-GCM with a 256-bit key stored as a Wrangler secret (`TOKEN_ENCRYPTION_KEY`). The Web Crypto API (`crypto.subtle`) is available in Cloudflare Workers.

**Implemented**: `importAesKey()`, `encryptData()`, `decryptData()` added to `auth.ts`. `handleAuthCallback` encrypts before `TOKENS.put()`; `getAccessToken` decrypts after `TOKENS.get()` and re-encrypts after token refresh. Decryption failure (including pre-existing plaintext entries) returns `null`, forcing re-authentication. Key is generated with `openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY`.

---

#### Finding 5 — Logout endpoint deletes any token without ownership check
**Severity**: Critical | **OWASP**: A01 Broken Access Control | **Status**: ✅ Fixed  
**Files**: `index.ts:48-73`

`GET /auth/logout?token=X` deletes any token value passed to it without verifying the caller owns that token. Any party who learns a token UUID can revoke another user's session.

**Fix**: Change to `POST /auth/logout`. Require the caller to prove ownership, for example by requiring the current session token in the request body and verifying it matches the token being revoked before deleting. Also change the revocation form in the home page HTML to use a `method="POST"` form.

**Implemented**: Handler now rejects non-`POST` requests with `405`. Token is read from the request body (JSON or form-encoded). KV existence check confirms the caller possesses a valid token before deletion. Home page form updated to `method="POST"`. This also resolves Finding 16.

---

#### Finding 6 — Stack traces returned in HTTP 500 responses
**Severity**: High | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `index.ts:197`, `session.ts` fetch handler

`e.stack || e.message` is sent directly to the HTTP client, exposing internal file paths, library versions, and variable contents that assist targeted exploitation.

**Fix**: Return `{"error":"Internal Server Error"}` (JSON) to the client in all cases. Emit the full `e.stack` to `console.error` only. Set `Cache-Control: no-store` on error responses.

**Implemented**: `index.ts` catch block fixed as part of Finding 2. `session.ts` DO `fetch()` catch block now returns `{"error":"Internal Server Error"}` JSON with `Cache-Control: no-store`; full stack logged via `this.log("error", …)` only.

---

#### Finding 7 — Google Drive query injection
**Severity**: High | **OWASP**: A03 Injection | **Status**: ✅ Fixed  
**Files**: `google-api.ts:61-62`

Single-quote doubling is insufficient for the Drive query language. Characters like `(`, `)`, `and`, `or`, `not` can break out of the `contains` context and rewrite the query predicate.

**Fix**:
```typescript
const safe = query.replace(/[()'"\\]/g, "").trim().slice(0, 200);
if (!safe) throw new Error("Query is empty after sanitisation");
```

**Implemented**: `searchDocuments` in `google-api.ts` strips `(`, `)`, `'`, `"`, `\` from the query, trims whitespace, and truncates to 200 chars. Throws if the result is empty.

---

#### Finding 8 — No input size limits on POST handlers or Markdown parser
**Severity**: High | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `session.ts:323`, `markdown-parser.ts`

`handleStreamablePost` calls `request.json()` with no body size guard. `markdownToBatchUpdates` applies no line-count or per-line length cap. An oversized payload exhausts the DO's memory budget.

**Fix**: Check `Content-Length` before reading. Enforce a 512 KB max body and a 5 000-line / 100 KB per-line cap in the Markdown parser.
```typescript
const MAX = 512 * 1024;
if (parseInt(request.headers.get("content-length") ?? "0") > MAX)
  return jsonError(413, "Payload too large");
```

**Implemented**: `handleStreamablePost` in `session.ts` checks `Content-Length` against 512 KB and returns a `413` JSON-RPC error before reading the body. `markdownToBatchUpdates` in `markdown-parser.ts` rejects content exceeding 100 KB (byte-length) or 5 000 lines before processing.

---

#### Finding 9 — Document ID not validated against known format
**Severity**: High | **OWASP**: A03 Injection | **Status**: ✅ Fixed  
**Files**: `google-api.ts:4-11`

After the URL regex check, the bare-ID fallback returns the raw user string unmodified. Arbitrary strings — including path-traversal sequences — are passed directly to the Google API URL.

**Fix**: Enforce `^[a-zA-Z0-9_-]{25,55}$` after extraction and throw before making any API call if the ID does not match.

**Implemented**: `extractDocumentId` in `google-api.ts` validates the extracted ID against `DOC_ID_RE = /^[a-zA-Z0-9_-]{25,55}$/` and throws `"Invalid document ID format"` before any fetch call is made. All four Google API functions (`getDocument`, `batchUpdate`, `replaceSection`, `appendText`) call `extractDocumentId` as their first step.

---

#### Finding 10 — No rate limiting on auth or MCP endpoints
**Severity**: High | **OWASP**: A04 Insecure Design | **Status**: ✅ Fixed  
**Files**: `auth.ts`, `index.ts`

`/auth/login` and `/auth/callback` can be called in a tight loop, flooding KV with state entries and exhausting Google API quota. `/mcp` tool calls have no per-token throttle.

**Fix**: Use `CF-Connecting-IP` and KV counters with TTL to enforce limits:
- Auth endpoints: 10 requests / IP / minute.
- Tool calls: 120 requests / token / minute.
Return `429 Too Many Requests` with a `Retry-After` header when the limit is exceeded.

**Implemented**: `checkRateLimit(kv, key, limit, windowSecs)` added to `index.ts`. Uses fixed-window KV counters keyed by `rl:<scope>:<window-number>` with `expirationTtl = windowSecs * 2`. Applied to `/auth/login` and `/auth/callback` (10 req / `CF-Connecting-IP` / min) and `/mcp` (120 req / token / min, checked after token validation). Returns `429` JSON with `Retry-After: 60` on breach.

---

### Priority 2 — Sprint 1 (High / Medium)

#### Finding 11 — OAuth state not consumed atomically
**Severity**: High | **OWASP**: A01 Broken Access Control | **Status**: ✅ Fixed  
**Files**: `auth.ts:30-35`

The state is deleted after validation, but a narrow race window exists between the KV `get` and `delete` in a concurrent environment, allowing state replay. The state is also not bound to the requesting IP.

**Fix**: Delete the state *before* the token exchange call. Concatenate the client IP into the state value at generation time and verify it at callback.

**Implemented**: `handleAuthLogin` stores `CF-Connecting-IP` as the KV state value. `handleAuthCallback` reads the stored IP, compares it to the current `CF-Connecting-IP` (rejects with 403 on mismatch), then deletes the state at line 94 before the token exchange fetch at line 96, closing the get/delete race window.

---

#### Finding 12 — Google API error messages returned without sanitisation
**Severity**: Medium | **OWASP**: A03 Injection | **Status**: ✅ Fixed  
**Files**: `google-api.ts:19,37,55`

`await response.text()` on a Google API error may return an HTML or XML page. That raw markup is embedded in the thrown `Error`, which can reach the MCP client.

**Fix**: Parse error bodies as JSON where the content type is `application/json`; otherwise strip HTML tags and truncate to 300 characters before including in the error message.

**Implemented**: `extractApiError()` added to `google-api.ts`. Prefers the `message` field from a JSON error body; falls back to stripping HTML tags (`/<[^>]*>/g`) and truncating to 300 chars. Used by all four API call sites (`getDocument`, `createDocument`, `batchUpdate`, `searchDocuments`). The token-exchange error in `auth.ts` replaced with a generic message; details go to `console.error` only.

---

#### Finding 13 — OAuth scope not verified after token exchange
**Severity**: Medium | **OWASP**: A01 Broken Access Control | **Status**: ✅ Fixed  
**Files**: `auth.ts:49`

If the user denies one scope during Google consent, the returned token has fewer permissions than required. The current code stores the partial token and all subsequent calls silently fail.

**Fix**: After token exchange, compare `tokens.scope.split(" ")` against the required scope list. Redirect the user back to consent with an error message if any scope is missing.

**Implemented**: `REQUIRED_SCOPES` constant defined in `auth.ts`. After token exchange, if `tokens.scope` is present, it is split on whitespace and checked against `REQUIRED_SCOPES`. Missing scopes return a 403 HTML error page prompting re-authentication. If `tokens.scope` is absent, Google is confirming all requested scopes were granted (per OAuth 2.0 spec §5.1).

---

#### Finding 14 — No token expiry or rotation
**Severity**: Medium | **OWASP**: A02 Cryptographic Failures | **Status**: ✅ Fixed  
**Files**: `auth.ts:57-58`

Tokens are permanent. A token exposed in a log file months ago remains valid indefinitely.

**Fix**: Store `createdAt` and `expiresAt` (90 days from creation) in the KV metadata. On every token lookup in `getAccessToken`, reject tokens past `expiresAt` and return `null` to force re-authentication.

**Implemented**: `TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000` constant in `auth.ts`. `handleAuthCallback` writes `createdAt` and `expiresAt` into the token object before encrypting and storing. `getAccessToken` checks `expiresAt` immediately after decryption; expired tokens are deleted from KV and `null` is returned.

---

#### Finding 15 — `workers_dev = true` exposes a secondary hostname
**Severity**: Medium | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `wrangler.toml:6`

`workers_dev = true` creates a `*.workers.dev` URL that bypasses any custom-domain security policies (WAF rules, access policies) applied to the production hostname.

**Fix**: Set `workers_dev = false` in `wrangler.toml` for production deployments.

**Implemented**: `workers_dev = false` in `wrangler.toml`.

---

### Priority 3 — Sprint 2 (Medium)

#### Finding 16 — Logout is a GET endpoint (CSRF-vulnerable)
**Severity**: Medium | **OWASP**: A01 Broken Access Control | **Status**: ✅ Fixed (resolved by Finding 5)  
**Files**: `index.ts:48-73`

Revoking a token via `GET` allows CSRF attacks: `<img src="/auth/logout?token=...">` silently logs out any user who views a malicious page.

**Fix**: Change to `POST /auth/logout`. Update the revocation form to `method="POST"`. Validate the `Content-Type` header is `application/x-www-form-urlencoded` or `application/json`.

**Implemented**: Covered fully by Finding 5. The endpoint is `POST`-only, reads the token from the body (accepting both `application/json` and form-encoded), and the home page form uses `method="POST"`.

---

#### Finding 17 — Missing Content-Security-Policy and security headers on HTML pages
**Severity**: Low | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `auth.ts` (HTML responses), `index.ts` (home page)

The pages that display tokens lack CSP, HSTS, and `Permissions-Policy`. Inline `<script>` blocks run without a nonce or hash in the policy.

**Fix**: Add the following headers to all HTML responses:
```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-<precomputed-hash>'; form-action 'self'
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

**Implemented**: Security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) added to all HTML responses: home page and logout success page in `index.ts`, scope-error page in `auth.ts`. The auth success page was already hardened in Finding 3. Home page CSP includes `form-action 'self'`; pages without scripts use `default-src 'none'; style-src 'unsafe-inline'`.

---

#### Finding 18 — No API-level rate limiting on Google calls
**Severity**: Low | **OWASP**: A04 Insecure Design | **Status**: ✅ Fixed  
**Files**: `google-api.ts`

No per-user throttle exists on Google API calls. A single token can exhaust the project's quota in seconds.

**Fix**: Implement per-token counters in KV (e.g., 100 calls / token / minute) for `getDocument`, `searchDocuments`, `batchUpdate`. Throw a descriptive `McpError` when the limit is reached.

**Implemented**: `checkRateLimit` extracted to `src/utils.ts` and imported by both `index.ts` and `session.ts`. `dispatchToolCall` in `session.ts` checks `google:<userToken>` at 100 calls / token / minute before every Google API call, throwing `McpError(InvalidRequest, "Google API rate limit exceeded…")` on breach. The existing `/mcp` endpoint rate limit (120 req / token / min) acts as an outer guard; this inner limit protects Google quota specifically.

---

#### Finding 19 — DO `/sse` handler does not re-validate token against KV
**Severity**: Low | **OWASP**: A04 Insecure Design | **Status**: ✅ Fixed  
**Files**: `session.ts:389-394`

The SSE handler stores `userToken` in DO durable storage without re-verifying it exists in KV. The edge worker validates the token before routing, but defence-in-depth is missing inside the DO.

**Fix**: Add a KV lookup inside the DO's `/sse` handler to confirm the token is still valid before accepting the SSE connection. Pass `env` to the DO or use a separate validation endpoint.

**Implemented**: The `/sse` path in `session.ts` now calls `this.env.TOKENS.get(userToken)` before storing the token or opening the SSE stream. Returns `401 Invalid or revoked token` if the KV entry is absent, ensuring a token revoked after the edge-worker check cannot establish a persistent SSE connection.

---

#### Finding 20 — Inline JavaScript on auth pages without a nonce
**Severity**: Low | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed (resolved by Finding 3)  
**Files**: `auth.ts:85-96`

The `copyToClipboard` function is an inline `<script>` block. Once a CSP is added (Finding 17), this will be blocked by `script-src 'none'` unless a nonce or hash is included.

**Fix**: Compute a SHA-256 hash of the script block at deploy time and include it as `'sha256-<hash>'` in the `script-src` directive. Alternatively, move the script to a separate static asset.

**Implemented**: Covered fully by Finding 3. The auth success page generates a per-request nonce via `crypto.randomUUID()`, attaches it to the `<script nonce="…">` tag, and mirrors it in `script-src` of the `Content-Security-Policy` header. The home page and logout page contain no inline scripts.

---

### Priority 4 — Post-Hardening (Medium / Low)

#### Finding 21 — Sensitive HTML pages cached by browser
**Severity**: High | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `auth.ts`, `index.ts`

Pages displaying or handling tokens (OAuth success, Logout, Home) lack `Cache-Control: no-store`. A shared machine user could see another user's token by navigating through browser history.

**Fix**: Add `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate` to all sensitive HTML responses.

**Implemented**: `Cache-Control: no-store` added to responses in `index.ts` and `auth.ts`.

#### Finding 22 — Partial revocation enforcement in Durable Objects
**Severity**: High | **OWASP**: A01 Broken Access Control | **Status**: ✅ Fixed  
**Files**: `session.ts`

The Streamable HTTP handler and `tools/list` handler in the DO do not re-validate the session token against KV. A revoked token could still discover tools or perform some operations until the next Google API call.

**Fix**: Add KV lookups in `handleStreamablePost` and `registerHandlers` to confirm the token is still valid.

**Implemented**: Token validation added to `handleStreamablePost` and the `tools/list` request handler in `session.ts`.

#### Finding 23 — Memory exhaustion from large documents
**Severity**: Medium | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `google-api.ts`

`getDocument` fetches the full JSON of a document without size limits. A massive document could crash the Durable Object.

**Fix**: Check `Content-Length` of the Google Docs response and reject if it exceeds a safety limit (e.g., 10MB).

**Implemented**: 10MB limit added to `getDocument` in `google-api.ts`.

#### Finding 24 — Inefficient CORS preflights
**Severity**: Low | **OWASP**: A05 Security Misconfiguration | **Status**: ✅ Fixed  
**Files**: `index.ts`

CORS preflight requests are not cached, increasing latency and resource usage.

**Fix**: Add `Access-Control-Max-Age` to the preflight response.

**Implemented**: `Access-Control-Max-Age: 86400` added to `buildCorsHeaders` in `index.ts`.

---

### Required Wrangler Secrets

The following secrets must be set via `wrangler secret put` before the security fixes can be deployed:

| Secret | Purpose |
|--------|---------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `TOKEN_ENCRYPTION_KEY` | 256-bit base64 key for AES-GCM encryption of KV token blobs (Finding 4) |
