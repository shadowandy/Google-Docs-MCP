import { handleAuthLogin, handleAuthCallback } from "./auth";
import { MCPSession } from "./session";
import { Env } from "./types";
import { checkRateLimit } from "./utils";

// Export Durable Object class
export { MCPSession };

const ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://app.claude.ai",
];

async function tokenTag(token: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}


function buildCorsHeaders(requestOrigin: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-protocol-version",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...extra,
  };
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;
    
    console.log(`[Worker Request] ${method} ${pathname}`);
    
    try {
      // Global CORS handling — only allowlisted origins receive credentials
      const origin = request.headers.get("Origin");
      const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
      const corsHeaders = buildCorsHeaders(origin, requestedHeaders ? { "Access-Control-Allow-Headers": requestedHeaders } : {});

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      const handleRequest = async () => {
        // OAuth endpoints — rate-limited by IP (10 req / IP / minute)
        if (url.pathname === "/auth/login") {
          const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
          if (!await checkRateLimit(env.TOKENS, `auth:${ip}`, 10, 60)) {
            return new Response(JSON.stringify({ error: "Too Many Requests" }), {
              status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" }
            });
          }
          return handleAuthLogin(request, env);
        }
        if (url.pathname === "/auth/callback") {
          const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
          if (!await checkRateLimit(env.TOKENS, `auth:${ip}`, 10, 60)) {
            return new Response(JSON.stringify({ error: "Too Many Requests" }), {
              status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" }
            });
          }
          return handleAuthCallback(request, env);
        }

        // Revocation: POST /auth/logout — token in request body proves ownership
        if (url.pathname === "/auth/logout") {
          if (request.method !== "POST") {
            return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
          }
          let userToken: string | null = null;
          const ct = request.headers.get("content-type") ?? "";
          if (ct.includes("application/json")) {
            const body = await request.json() as any;
            userToken = typeof body?.token === "string" ? body.token : null;
          } else {
            const form = await request.formData();
            userToken = form.get("token") as string | null;
          }
          if (userToken) {
            const exists = await env.TOKENS.get(userToken);
            if (!exists) return new Response("Token not found.", { status: 404 });
            await env.TOKENS.delete(userToken);
            return new Response(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Logout Successful</title>
    <style>body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; text-align: center; }</style>
  </head>
  <body>
    <h1>Logout Successful</h1>
    <p>Your token has been securely revoked from Cloudflare KV.</p>
    <p><a href="/">Return to Home</a></p>
  </body>
</html>`, {
              status: 200, headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
                "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
                "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "strict-origin-when-cross-origin",
              }
            });
          }
          return new Response("Missing token.", { status: 400 });
        }

        // Streamable HTTP MCP endpoint (MCP 2025-03-26)
        // Pattern: /mcp?token=<userToken>
        if (url.pathname === "/mcp") {
          const userToken = url.searchParams.get("token");
          if (!userToken) return new Response("Missing Token", { status: 401 });

          const exists = await env.TOKENS.get(userToken);
          if (!exists) return new Response("Invalid Token", { status: 401 });

          // Rate limit: 120 tool calls / token / minute
          if (!await checkRateLimit(env.TOKENS, `mcp:${userToken}`, 120, 60)) {
            return new Response(JSON.stringify({ error: "Too Many Requests" }), {
              status: 429, headers: { "Content-Type": "application/json", "Retry-After": "60" }
            });
          }

          const id = env.MCP_SESSION.idFromName(userToken);
          const obj = env.MCP_SESSION.get(id);

          const doUrl = new URL(request.url);
          doUrl.pathname = "/streamable";
          doUrl.searchParams.set("userToken", userToken);

          console.log(`[Edge] Routing ${request.method} /mcp to DO streamable. token:${await tokenTag(userToken)}`);
          return obj.fetch(new Request(doUrl.toString(), request));
        }

        // Stable MCP SSE Connection
        // Pattern: /mcp/sse?token=<userToken>
        if (url.pathname === "/mcp/sse") {
          const userToken = url.searchParams.get("token");
          if (!userToken) return new Response("Missing Token", { status: 401 });

          // Validate userToken exists
          const exists = await env.TOKENS.get(userToken);
          if (!exists) return new Response("Invalid Token", { status: 401 });

          const id = env.MCP_SESSION.idFromName(userToken);
          const obj = env.MCP_SESSION.get(id);
          console.log(`[Edge] Routing ${request.method} /mcp/sse to DO. token:${await tokenTag(userToken)} DO ID: ${id.toString()}`);
          
          const doUrl = new URL(request.url);
          
          // If it's a POST request to /mcp/sse, it's likely a fallback message post from the client
          if (request.method === "POST") {
            doUrl.pathname = "/messages";
          } else {
            doUrl.pathname = "/sse";
            doUrl.searchParams.set("userToken", userToken);
          }
          
          return obj.fetch(new Request(doUrl.toString(), request));
        }

        // Stable Messages Endpoint
        // Pattern: /mcp/messages?token=<userToken>
        if (url.pathname === "/mcp/messages") {
          let userToken = url.searchParams.get("token");
          
          // Fallback: check Authorization header
          const auth = request.headers.get("Authorization");
          if (!userToken && auth?.startsWith("Bearer ")) {
            userToken = auth.slice(7);
          }

          if (!userToken) return new Response("Missing Token", { status: 401 });

          const id = env.MCP_SESSION.idFromName(userToken);
          const obj = env.MCP_SESSION.get(id);
          console.log(`[Edge] Routing POST /mcp/messages to DO. token:${await tokenTag(userToken)} DO ID: ${id.toString()}`);

          const msgUrl = new URL(request.url);
          msgUrl.pathname = "/messages";
          
          return obj.fetch(new Request(msgUrl.toString(), request));
        }

        // Fallback for /, /auth, etc.
        return new Response(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Google Docs MCP</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 600px; margin: 40px auto; padding: 20px; line-height: 1.6; }
      .card { border: 1px solid #ddd; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
      a.button, button { display: inline-block; padding: 10px 15px; background: #0066cc; color: white; text-decoration: none; border-radius: 4px; border: none; cursor: pointer; font-size: 1rem; }
      a.button:hover, button:hover { background: #0052a3; }
      input[type="text"] { width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
    </style>
  </head>
  <body>
    <h1>Google Docs MCP Server</h1>
    <p>Status: <strong>Running</strong></p>
    <div class="card">
      <h2>1. Authenticate</h2>
      <p>Connect your Google account to generate a new MCP connection URL.</p>
      <a href="/auth/login" class="button">Login with Google</a>
    </div>
    <div class="card">
      <h2>2. Revoke Token (Logout)</h2>
      <p>Paste your connection token below to permanently revoke its access.</p>
      <form action="/auth/logout" method="POST">
        <input type="text" name="token" placeholder="Paste your token UUID here..." required>
        <button type="submit" style="background: #cc0000;">Revoke Access</button>
      </form>
    </div>
  </body>
</html>`, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
            "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          }
        });
      };

      const response = await handleRequest();

      // Cleanly append CORS headers to the response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    } catch (e: any) {
      console.error("Worker Error:", e.stack || e.message);

      const errorCors = buildCorsHeaders(request.headers.get("Origin"));
      const errorHeaders = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
      Object.entries(errorCors).forEach(([key, value]) => errorHeaders.set(key, value));

      return new Response(JSON.stringify({ error: "Internal Server Error" }), {
        status: 500,
        headers: errorHeaders
      });
    }
  },
};

