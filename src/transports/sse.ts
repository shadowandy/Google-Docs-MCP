import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export class CloudflareSSEServerTransport implements Transport {
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
    let keepAliveInterval: ReturnType<typeof setInterval>;

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
          } catch {
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
