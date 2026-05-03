import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Streamable HTTP transport for MCP 2025-03-26.
 * Correlates each JSON-RPC request to its response by message ID so the HTTP
 * handler can return the response directly in the reply body.  Lives for the
 * Durable Object's entire lifetime and handles multiple sequential requests.
 */
export class StreamableHttpTransport implements Transport {
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

  /** Deliver a message and await the server's JSON-RPC response, or null for notifications. */
  processMessage(message: JSONRPCMessage, timeoutMs = 30_000): Promise<JSONRPCMessage | null> {
    const id = (message as any).id;
    if (id != null) {
      return new Promise<JSONRPCMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this._pendingResolvers.delete(id)) {
            reject(new Error(`Timeout waiting for response to request id=${String(id)}`));
          }
        }, timeoutMs);
        this._pendingResolvers.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        this.onmessage?.(message);
      });
    }
    this.onmessage?.(message);
    return Promise.resolve(null);
  }
}
