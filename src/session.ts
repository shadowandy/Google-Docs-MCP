import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  JSONRPCMessage
} from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { getAccessToken } from "./auth";
import { Env } from "./types";
import { getDocument, createDocument, searchDocuments, replaceSection, appendText } from "./google-api";
import { docToMarkdown } from "./markdown-utils";
import { checkRateLimit } from "./utils";

/**
 * SSE transport for Cloudflare Workers.
 * Sends responses over a persistent SSE stream; client POSTs messages to a separate endpoint.
 */
class CloudflareSSEServerTransport implements Transport {
  private _controller: ReadableStreamDefaultController | null = null;
  private _encoder = new TextEncoder();
  private _endpoint: string;
  private _sessionId: string;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(endpoint: string) {
    this._endpoint = endpoint;
    this._sessionId = crypto.randomUUID();
  }

  get sessionId() { return this._sessionId; }

  async start() {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._controller) return;
    try {
      this._controller.enqueue(this._encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
    } catch (e) {
      console.error("SSE Send Error:", e);
    }
  }

  async close(): Promise<void> {
    try { this._controller?.close(); } catch {}
    this._controller = null;
    this.onclose?.();
  }

  handleSseRequest(): Response {
    let keepAliveInterval: any;

    const stream = new ReadableStream({
      start: (controller) => {
        this._controller = controller;

        const endpointUrl = new URL(this._endpoint);
        endpointUrl.searchParams.set("sessionId", this._sessionId);

        controller.enqueue(this._encoder.encode(`: connected\n\n`));
        controller.enqueue(this._encoder.encode(`event: endpoint\ndata: ${endpointUrl.toString()}\n\n`));

        keepAliveInterval = setInterval(() => {
          try {
            if (this._controller) {
              this._controller.enqueue(this._encoder.encode(`: keepalive\n\n`));
            }
          } catch (e) {
            clearInterval(keepAliveInterval);
          }
        }, 15000);
      },
      cancel: () => {
        clearInterval(keepAliveInterval);
        this._controller = null;
        this.onclose?.();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "Content-Encoding": "identity",
      }
    });
  }

  async handlePostRequest(request: Request): Promise<Response> {
    try {
      const message = await request.json();
      this.onmessage?.(message as JSONRPCMessage);
      return new Response("Accepted", { status: 202 });
    } catch (e: any) {
      return new Response(e.message, { status: 400 });
    }
  }
}

/**
 * Inline (Streamable HTTP) transport for MCP 2025-03-26.
 * Each processMessage call returns a Promise that resolves with the server's response,
 * so the HTTP handler can return it directly in the response body.
 */
class OneShotTransport implements Transport {
  private _pendingResolvers = new Map<string | number, (msg: JSONRPCMessage) => void>();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  async start() {}

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as any).id;
    if (id != null) {
      const resolve = this._pendingResolvers.get(id);
      if (resolve) {
        this._pendingResolvers.delete(id);
        resolve(message);
      }
    }
  }

  async close(): Promise<void> {
    this._pendingResolvers.clear();
    this.onclose?.();
  }

  /** Send a message and await the server's JSON-RPC response, or null for notifications. */
  processMessage(message: JSONRPCMessage): Promise<JSONRPCMessage | null> {
    const id = (message as any).id;
    if (id != null) {
      return new Promise<JSONRPCMessage>((resolve) => {
        this._pendingResolvers.set(id, resolve);
        this.onmessage?.(message);
      });
    }
    this.onmessage?.(message);
    return Promise.resolve(null);
  }
}

export class MCPSession {
  // SSE transport state
  private server!: Server;
  private transport: CloudflareSSEServerTransport | null = null;

  // Streamable HTTP transport state (lazy-initialised, lives for the DO's lifetime)
  private streamableServer: Server | null = null;
  private streamableTransport: OneShotTransport | null = null;

  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    console.log("[DO Lifecycle] Constructor called! Instance started.");
  }

  // ─── Tool definitions ────────────────────────────────────────────────────────

  private get toolDefinitions() {
    return [
      {
        name: "read_document",
        description: "Read a Google Document and return its full content as Markdown",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
          type: "object" as const,
          properties: {
            documentId: { type: "string", description: "The ID or full URL of the Google Document" }
          },
          required: ["documentId"]
        }
      },
      {
        name: "create_document",
        description: "Create a new, empty Google Document and return its ID",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: "object" as const,
          properties: {
            title: { type: "string", description: "The title of the new Google Document" }
          },
          required: ["title"]
        }
      },
      {
        name: "search_documents",
        description: "Search Google Drive for Documents matching a query by title or content",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        inputSchema: {
          type: "object" as const,
          properties: {
            query: { type: "string", description: "The search query to match against document names and content" }
          },
          required: ["query"]
        }
      },
      {
        name: "edit_section",
        description: "Replace the content under a specific section header in a Google Document. The header itself is preserved; only the content beneath it is replaced.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: "object" as const,
          properties: {
            documentId: { type: "string", description: "The ID or full URL of the Google Document" },
            headerText: { type: "string", description: "The exact header text identifying the section to replace" },
            newContent: { type: "string", description: "The Markdown content to insert beneath the header" }
          },
          required: ["documentId", "headerText", "newContent"]
        }
      },
      {
        name: "append_text",
        description: "Append Markdown content to the very end of a Google Document",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          type: "object" as const,
          properties: {
            documentId: { type: "string", description: "The ID or full URL of the Google Document" },
            newContent: { type: "string", description: "The Markdown content to append" }
          },
          required: ["documentId", "newContent"]
        }
      }
    ];
  }

  // ─── Tool call dispatcher (shared between SSE and Streamable HTTP) ───────────

  private async dispatchToolCall(name: string, args: Record<string, any>): Promise<{ content: { type: string; text: string }[] }> {
    const userToken = await this.state.storage.get<string>("userToken");
    if (!userToken) throw new McpError(ErrorCode.InvalidRequest, "Session not initialised");

    const accessToken = await getAccessToken(userToken, this.env);
    if (!accessToken) throw new McpError(ErrorCode.InvalidRequest, "Not authenticated or token expired");

    // F18: Limit Google API calls per token to prevent quota exhaustion
    if (!await checkRateLimit(this.env.TOKENS, `google:${userToken}`, 100, 60)) {
      throw new McpError(ErrorCode.InvalidRequest, "Google API rate limit exceeded. Please wait before retrying.");
    }

    switch (name) {
      case "read_document": {
        const doc = await getDocument(args.documentId, accessToken);
        return { content: [{ type: "text", text: docToMarkdown(doc) }] };
      }
      case "create_document": {
        const documentId = await createDocument(args.title, accessToken);
        return { content: [{ type: "text", text: `Document created with ID: ${documentId}` }] };
      }
      case "search_documents": {
        const results = await searchDocuments(args.query, accessToken);
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }
      case "edit_section": {
        await replaceSection(args.documentId, args.headerText, args.newContent, accessToken);
        return { content: [{ type: "text", text: `Section "${args.headerText}" updated successfully.` }] };
      }
      case "append_text": {
        await appendText(args.documentId, args.newContent, accessToken);
        return { content: [{ type: "text", text: "Text successfully appended to the document." }] };
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${name}`);
    }
  }

  // ─── Shared handler registration ─────────────────────────────────────────────

  private registerHandlers(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      this.log("info", "tools/list request received");
      return { tools: this.toolDefinitions };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        return await this.dispatchToolCall(
          request.params.name,
          request.params.arguments as Record<string, any>
        );
      } catch (error: any) {
        if (error instanceof McpError) throw error;
        console.error(`MCP Tool Error [${request.params.name}]:`, error);
        throw new McpError(ErrorCode.InternalError, `Google API Error: ${error.message || "Unknown error"}`);
      }
    });
  }

  // ─── SSE server lifecycle ─────────────────────────────────────────────────────

  private initializeSseServer() {
    this.server = new Server(
      { name: "google-docs-mcp", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    this.registerHandlers(this.server);
  }

  // ─── Streamable HTTP server lifecycle ─────────────────────────────────────────

  private async ensureStreamableServer() {
    if (this.streamableServer && this.streamableTransport) return;

    this.streamableServer = new Server(
      { name: "google-docs-mcp", version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } } }
    );
    this.registerHandlers(this.streamableServer);
    this.streamableTransport = new OneShotTransport();
    await this.streamableServer.connect(this.streamableTransport);
    this.log("info", "Streamable HTTP server initialised");
  }

  // ─── Streamable HTTP request handler ─────────────────────────────────────────

  private async handleStreamablePost(request: Request, userToken: string): Promise<Response> {
    await this.ensureStreamableServer();

    const MAX_BODY = 512 * 1024;
    const contentLength = parseInt(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Payload too large" } }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }

    let body: JSONRPCMessage;
    try {
      body = await request.json() as JSONRPCMessage;
    } catch {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const response = await this.streamableTransport!.processMessage(body);

    if (response === null) {
      // Notification — no response body
      return new Response(null, { status: 202 });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Echo the token as session ID so the client can include it in subsequent requests
        "Mcp-Session-Id": userToken,
      }
    });
  }

  // ─── Logging helper ───────────────────────────────────────────────────────────

  private log(level: "debug" | "info" | "warning" | "error", message: string, data?: any) {
    const logData = data ? `${message} ${JSON.stringify(data)}` : message;
    if (level === "error") {
      console.error(`[MCP ${level}]`, logData);
    } else {
      console.log(`[MCP ${level}]`, logData);
    }
  }

  // ─── Durable Object fetch handler ────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      this.log("debug", `DO request: ${request.method} ${url.pathname}`);

      // ── Streamable HTTP (MCP 2025-03-26) ──
      if (url.pathname.endsWith("/streamable")) {
        const userToken = url.searchParams.get("userToken");
        if (!userToken) return new Response("Missing userToken", { status: 401 });

        if (request.method === "GET") {
          // Optional: SSE channel for server-initiated notifications
          // For now, return 405 — we don't send server-initiated notifications
          return new Response("Use POST for Streamable HTTP", { status: 405 });
        }

        if (request.method === "POST") {
          // Store token so tool calls can use it
          await this.state.storage.put("userToken", userToken);
          return this.handleStreamablePost(request, userToken);
        }

        return new Response("Method Not Allowed", { status: 405 });
      }

      // ── Legacy SSE transport ──
      if (url.pathname.endsWith("/sse")) {
        const userToken = url.searchParams.get("userToken");
        if (userToken) {
          // F19: Re-validate token inside the DO for defence-in-depth
          const valid = await this.env.TOKENS.get(userToken);
          if (!valid) return new Response("Invalid or revoked token", { status: 401 });
          await this.state.storage.put("userToken", userToken);
          this.log("info", "Stored userToken for SSE session");
        }

        // Close any existing connection
        if (this.transport && this.server) {
          this.log("info", "Closing existing SSE transport");
          try { await this.server.close(); } catch {}
          this.transport = null;
          this.server = null!;
        }

        this.initializeSseServer();

        const messagesEndpoint = userToken
          ? `${url.origin}/mcp/messages?token=${userToken}`
          : `${url.origin}/mcp/messages`;

        this.transport = new CloudflareSSEServerTransport(messagesEndpoint);
        this.transport.onclose = () => this.log("info", "SSE transport closed");

        await this.server.connect(this.transport);
        this.log("info", "SSE server connected");
        return this.transport.handleSseRequest();
      }

      if (url.pathname.endsWith("/messages")) {
        if (!this.transport || !this.server) {
          this.log("error", "POST /messages: no active SSE session");
          return new Response("No active SSE session. Please re-establish the SSE connection.", { status: 400 });
        }
        return this.transport.handlePostRequest(request);
      }

      this.log("warning", `Path not found in DO: ${url.pathname}`);
      return new Response("Not Found", { status: 404 });

    } catch (e: any) {
      this.log("error", `DO Fetch Error: ${e.message}`, { stack: e.stack });
      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }
  }
}
