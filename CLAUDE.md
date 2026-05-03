# Claude AI System Instructions

This file contains instructions for Claude AI (and other LLMs) when interacting with the **Google Docs MCP Server**.

## Available Tools

The MCP server provides the following tools for interacting with Google Docs:

1. **`search_documents(query)`**: Search Google Drive for Documents matching a query by **title or content**.
2. **`read_document(documentId)`**: Retrieve the full text of a Google Document in Markdown format.
3. **`create_document(title)`**: Create a brand new, empty Google Document and return its ID.
4. **`edit_section(documentId, headerText, newContent)`**: Replace all content **beneath** a specific section header. The header line itself is preserved — only the body under it is replaced.
5. **`append_text(documentId, newContent)`**: Append new Markdown content to the very bottom of the document.

## Best Practices & Guidelines

- **Robust IDs**: The `documentId` parameter accepts either a bare Google Docs ID (e.g., `1Xy...`) or a full URL (e.g., `https://docs.google.com/document/d/.../edit`). You do not need to manually parse URLs.
- **Editing Strategy**:
    - Always prefer `append_text` if the user asks to "add to the end", "append", or "insert at the bottom".
    - Prefer `edit_section` if the user wants to update a specific part. Read the document first to confirm the exact `headerText` as it appears.
    - `edit_section` preserves the header — do **not** include the header in `newContent`.
- **Markdown Formatting**: Format all `newContent` as Markdown. The server translates headers (`#`), bold (`**`), italic (`*`), and bullet lists into Google Docs `batchUpdate` requests automatically.
- **Search**: `search_documents` searches both file names and document body text. Use it to locate documents before reading or editing. Keep queries under 200 characters and avoid special characters such as `(`, `)`, `'`, `"`.

## Security Rules for AI Assistants

These rules must be followed at all times when handling data from this server:

- **Never reproduce or log a connection token.** The MCP connection URL contains a secret token (the value after `?token=`). Do not include it in any response, summary, code snippet, or log output.
- **Treat tool error messages as internal.** Error responses may contain partial API messages. Do not relay raw error text verbatim to end users — summarise the failure instead.
- **Do not construct document URLs from IDs.** Return the `documentId` or let the user open their document through Google Drive. Do not attempt to build `https://docs.google.com/...` links by concatenating IDs, as that could expose document IDs in shared contexts.
- **Scope awareness**: The server only holds `documents` (read/write) and `drive.readonly` scopes. Do not attempt operations outside these scopes (e.g., creating Drive folders, sharing documents, managing permissions).

## Connection URL

After authenticating at `/auth/login`, you will receive a personal MCP connection URL. Register it in Claude.ai under **Settings → Integrations → Add custom MCP server**.

| Transport | URL | Protocol |
|-----------|-----|----------|
| **Streamable HTTP (recommended)** | `https://google-docs-mcp.shadowandy-net.workers.dev/mcp?token=<your-token>` | MCP 2025-03-26 |
| Legacy SSE | `https://google-docs-mcp.shadowandy-net.workers.dev/mcp/sse?token=<your-token>` | MCP 2024-11-05 |

Use the Streamable HTTP URL. It is stateless, more reliable, and does not suffer from connection-drop issues.

> **Note — known security improvement in progress**: Connection tokens are currently embedded in the URL query string. A migration to `Authorization: Bearer` headers for the Streamable HTTP endpoint is planned. Until that migration is complete, treat the full connection URL as a secret credential.

## Troubleshooting

- **Tools not appearing**: Start a new chat and ask "List the tools available on my Google Docs MCP server." Tools are deferred and only loaded on demand.
- **Network failure / "Failed to fetch"**: CORS issue. The server only allows requests from `https://claude.ai` and `https://app.claude.ai`. If you are connecting from a different client, its origin must be added to `ALLOWED_ORIGINS` in `index.ts` before redeploying. Re-adding the server connection in the client often resolves transient failures.
- **Connection drops (SSE only)**: Cloudflare severs idle SSE streams. A 15-second keep-alive heartbeat mitigates this. Switch to Streamable HTTP to eliminate the issue entirely.
- **Auth expired**: If tools fail with an auth error, re-visit `/auth/login` to generate a fresh token. Tokens expire after 90 days. They can also be invalidated if the Google refresh token is revoked or the server's encryption key has been rotated.
- **Immediate Revocation**: The server enforces session validity checks on every request. If you revoke a token via `/auth/logout`, it will immediately stop working in Claude.ai.
- **429 Too Many Requests**: The server enforces rate limits — 10 auth requests per IP per minute and 120 tool calls per token per minute. If you hit this, wait 60 seconds before retrying.
- **Memory Limits**: Extremely large documents (over 10MB JSON size) will be rejected to ensure server stability. Use more targeted searches if you encounter this.
- **Search returning unexpected results**: Avoid special characters in search queries — `(`, `)`, `'`, `"` are stripped automatically by the server. If results seem too broad, add more specific terms to narrow the query.
