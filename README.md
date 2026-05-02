# Google Docs MCP Server (Cloudflare Workers)

A Model Context Protocol (MCP) server hosted on Cloudflare Workers that enables Claude.ai and other MCP clients to read, search, and edit Google Documents with structural awareness.

## Features

- **Dual MCP Transport**: Supports both **Streamable HTTP** (MCP 2025-03-26, recommended) and legacy **SSE** (MCP 2024-11-05) transports.
- **Multi-User OAuth**: Securely connects multiple Google accounts via a built-in OAuth 2.0 flow with automatic token refresh.
- **Full-Text Search**: `search_documents` matches both document titles and body content via the Google Drive API.
- **Structural Markdown**: Converts Google Docs to Markdown so the AI understands headers, lists, and tables.
- **Context-Based Editing**: Allows the AI to replace a named section (e.g., "Replace the 'Introduction' section") without touching the rest of the document. The section header is always preserved.
- **Robust Input Handling**: Accepts both bare Google Docs IDs and full `https://docs.google.com/...` URLs.
- **Serverless & Stateful**: Uses Cloudflare Durable Objects to maintain session state across requests.
- **Secure**: Built-in CSRF protection, automatic token refresh with failure handling, and scoped CORS for browser clients.

---

## Prerequisites

Before you begin, make sure you have:

- **Node.js** v18 or later
- **Cloudflare account** with Workers and Durable Objects enabled (standard tier or above)
- **Google account** with access to the Google Cloud Console
- **Wrangler CLI** — install globally if you don't have it:
  ```bash
  npm install -g wrangler
  ```

---

## Setup Guide

### Step 1 — Clone and install dependencies

```bash
git clone https://github.com/shadowandy/Google-Docs-MCP.git
cd Google-Docs-MCP
npm install
cp wrangler.toml.example wrangler.toml
```

---

### Step 2 — Log in to Cloudflare

```bash
wrangler login
```

This opens a browser window to authenticate Wrangler with your Cloudflare account.

---

### Step 3 — Create the KV namespace

Token storage requires a Cloudflare KV namespace:

```bash
npx wrangler kv namespace create TOKENS
```

The command prints something like:

```
🌀 Creating namespace with title "google-docs-mcp-TOKENS"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "TOKENS", id = "abc123..." }
```

Open `wrangler.toml` (copied from `wrangler.toml.example`) and update the `id` field under `[[kv_namespaces]]`:

```toml
[[kv_namespaces]]
binding = "TOKENS"
id = "abc123..."   # ← replace with the id from the command output
```

---

### Step 4 — Note your worker URL

Your worker URL is determined by the `name` field in `wrangler.toml` and your Cloudflare subdomain:

```
https://<name>.<your-subdomain>.workers.dev
```

For example, if `name = "google-docs-mcp"` and your subdomain is `acme`, the URL is:

```
https://google-docs-mcp.acme.workers.dev
```

You need this URL in the next step when configuring Google Cloud.

---

### Step 5 — Set up Google Cloud

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create or select a project.

2. **Enable APIs**: Navigate to **APIs & Services → Library** and enable:
   - **Google Docs API**
   - **Google Drive API**

3. **Configure the OAuth Consent Screen**: Go to **APIs & Services → OAuth consent screen**.
   - User type: **External** (or **Internal** if using Google Workspace)
   - Add the following scopes:
     - `https://www.googleapis.com/auth/documents`
     - `https://www.googleapis.com/auth/drive.readonly`

4. **Create OAuth credentials**: Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**.
   - Application type: **Web application**
   - Under **Authorised redirect URIs**, add:
     ```
     https://<your-worker-url>/auth/callback
     ```
   - Click **Create** and note the **Client ID** and **Client Secret**.

---

### Step 6 — Configure secrets and environment

Set your Google credentials as encrypted Cloudflare secrets (you will be prompted to enter the value for each):

```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

Generate and set a 256-bit AES-GCM key used to encrypt OAuth tokens at rest in Cloudflare KV:

```bash
openssl rand -base64 32 | wrangler secret put TOKEN_ENCRYPTION_KEY
```

> **Important**: If you rotate this key later, all existing tokens stored in KV become unreadable and users will need to re-authenticate. Store the key value safely — it cannot be recovered from Cloudflare once set.

Verify that `GOOGLE_REDIRECT_URI` in your `wrangler.toml` matches your worker URL:

```toml
[vars]
GOOGLE_REDIRECT_URI = "https://<your-worker-url>/auth/callback"
```

---

### Step 7 — Deploy

```bash
wrangler deploy
```

Once deployed, visit your worker URL to confirm it is running — you should see the Google Docs MCP home page.

---

### Step 8 — Authenticate your Google account

1. Visit `https://<your-worker-url>/auth/login`.
2. Complete the Google sign-in flow.
3. On success, you are shown your **MCP connection URLs** — copy the **Streamable HTTP** URL (labelled as recommended).

---

### Step 9 — Connect to Claude.ai

1. Open [Claude.ai](https://claude.ai) → **Settings** → **Integrations** → **Add custom MCP server**.
2. Paste your **Streamable HTTP URL**:
   ```
   https://<your-worker-url>/mcp?token=<your-token>
   ```
3. Click **Add Server**.

Claude will now have access to your Google Documents.

> **Legacy SSE**: If your MCP client requires the older SSE transport, use `/mcp/sse?token=<your-token>` instead. The Streamable HTTP URL is preferred — it does not require a persistent connection and is unaffected by Cloudflare idle connection timeouts.

---

## Available Tools

Once connected, Claude has access to ten tools:

### Reading & Discovery

| Tool | Description |
|------|-------------|
| `list_documents()` | List the 20 most recently modified Docs from Drive |
| `search_documents(query)` | Search Drive for documents by title or body content |
| `read_document(documentId)` | Read a document and return it as Markdown |
| `get_document_info(documentId)` | Return title, revision ID, last modified time, and file size without fetching the body |
| `list_sections(documentId)` | List all headings in a document with their level — use this before editing to confirm exact header text |

### Writing & Editing

| Tool | Description |
|------|-------------|
| `create_document(title)` | Create a new empty document |
| `append_text(documentId, newContent)` | Append Markdown to the end of a document |
| `edit_section(documentId, headerText, newContent)` | Replace all content beneath a named section header (header line is preserved) |
| `find_and_replace(documentId, findText, replaceText, matchCase?)` | Replace all occurrences of a string; returns the number of replacements made |
| `delete_section(documentId, headerText)` | Permanently remove a section — the header and all content beneath it up to the next same-or-higher-level heading |

The `documentId` parameter accepts either a bare Google Docs ID or a full `https://docs.google.com/...` URL.

> **Tip**: Run `list_sections` before `edit_section` or `delete_section` to confirm the exact heading text as it appears in the document.

---

## Usage Examples

Once connected, you can ask Claude things like:

- *"Show me my most recently modified documents."*
- *"Find my document about Project Phoenix and summarize it."*
- *"What sections are in my Project Roadmap doc?"*
- *"Create a new document titled 'Meeting Notes' and add a summary section."*
- *"In my Project Roadmap doc, replace the 'Q3 Goals' section with this updated content: ..."*
- *"Rename every occurrence of 'FY2024' to 'FY2025' in my Budget doc."*
- *"Append a conclusion paragraph to my design document."*
- *"Delete the 'Draft Notes' section from my proposal."*

---

## Revoking Access

If your connection URL is compromised or you want to disconnect a Google account:

1. Visit `https://<your-worker-url>/`.
2. In the **Revoke Token** section, paste the token UUID (the value after `?token=` in your connection URL) and click **Revoke Access**.

This immediately deletes the token from Cloudflare KV, blocking all future requests that use it.

---

## Security Notes

- Each user receives a unique UUID token embedded in their connection URL. **Do not share this URL.**
- OAuth tokens (including the long-lived refresh token) are encrypted at rest in Cloudflare KV using **AES-GCM 256-bit** encryption. The key is stored as a Wrangler secret (`TOKEN_ENCRYPTION_KEY`) and never appears in code or logs.
- Only the minimum required Google API scopes are requested (`documents` read/write, `drive` read-only).
- CSRF protection is applied to all OAuth callbacks via a time-limited state parameter stored in KV (5-minute TTL, deleted on first use).
- **CORS** is restricted to an explicit allowlist (`https://claude.ai`, `https://app.claude.ai`). Requests from other origins receive no CORS headers. To add a new MCP client, add its origin to `ALLOWED_ORIGINS` in `src/index.ts` and redeploy.
- **Rate limiting** is enforced via KV counters: 10 requests per IP per minute on the auth endpoints, and 120 requests per token per minute on the MCP tool-call endpoint.
- Token revocation uses a `POST` request; the web form on the home page handles this automatically. Direct API calls to `/auth/logout` must use `POST` with the token in the request body.
