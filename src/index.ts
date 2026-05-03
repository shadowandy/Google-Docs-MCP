import { handleAuthLogin, handleAuthCallback } from "./auth";
import { MCPSession } from "./session";
import { Env } from "./types";
import { checkRateLimit, tokenTag, BASE_SECURITY_HEADERS } from "./utils";

export { MCPSession };

const ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://app.claude.ai",
];

function buildCorsHeaders(requestOrigin: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-protocol-version",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

function tooManyRequests(): Response {
  return new Response(JSON.stringify({ error: "Too Many Requests" }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": "60" },
  });
}

/** Validates that a token exists in KV. Returns the token string on success, or an error Response. */
async function resolveToken(token: string | null, env: Env): Promise<string | Response> {
  if (!token) return new Response("Missing Token", { status: 401 });
  const exists = await env.TOKENS.get(token);
  if (!exists) return new Response("Invalid Token", { status: 401 });
  return token;
}

// ── Route handlers ──────────────────────────────────────────────────────────

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!await checkRateLimit(env.TOKENS, `auth:${ip}`, 10, 60)) return tooManyRequests();
  return handleAuthLogin(request, env);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!await checkRateLimit(env.TOKENS, `auth:${ip}`, 10, 60)) return tooManyRequests();
  return handleAuthCallback(request, env);
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
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

  if (!userToken) return new Response("Missing token.", { status: 400 });

  const exists = await env.TOKENS.get(userToken);
  if (!exists) return new Response("Token not found.", { status: 404 });
  await env.TOKENS.delete(userToken);

  return new Response(logoutSuccessHtml(), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      ...BASE_SECURITY_HEADERS,
    },
  });
}

async function handleMcp(request: Request, env: Env, url: URL): Promise<Response> {
  const resolved = await resolveToken(url.searchParams.get("token"), env);
  if (resolved instanceof Response) return resolved;
  if (!await checkRateLimit(env.TOKENS, `mcp:${resolved}`, 120, 60)) return tooManyRequests();

  const id = env.MCP_SESSION.idFromName(resolved);
  const obj = env.MCP_SESSION.get(id);
  const doUrl = new URL(request.url);
  doUrl.pathname = "/streamable";
  doUrl.searchParams.set("userToken", resolved);

  console.log(`[Edge] Routing ${request.method} /mcp to DO streamable. token:${await tokenTag(resolved)}`);
  return obj.fetch(new Request(doUrl.toString(), request));
}

async function handleMcpSse(request: Request, env: Env, url: URL): Promise<Response> {
  const resolved = await resolveToken(url.searchParams.get("token"), env);
  if (resolved instanceof Response) return resolved;
  if (!await checkRateLimit(env.TOKENS, `mcp:${resolved}`, 120, 60)) return tooManyRequests();

  const id = env.MCP_SESSION.idFromName(resolved);
  const obj = env.MCP_SESSION.get(id);
  const doUrl = new URL(request.url);

  if (request.method === "POST") {
    doUrl.pathname = "/messages";
  } else {
    doUrl.pathname = "/sse";
    doUrl.searchParams.set("userToken", resolved);
  }

  console.log(`[Edge] Routing ${request.method} /mcp/sse to DO. token:${await tokenTag(resolved)} DO ID: ${id.toString()}`);
  return obj.fetch(new Request(doUrl.toString(), request));
}

async function handleMcpMessages(request: Request, env: Env, url: URL): Promise<Response> {
  let token = url.searchParams.get("token");
  const auth = request.headers.get("Authorization");
  if (!token && auth?.startsWith("Bearer ")) token = auth.slice(7);

  const resolved = await resolveToken(token, env);
  if (resolved instanceof Response) return resolved;

  const id = env.MCP_SESSION.idFromName(resolved);
  const obj = env.MCP_SESSION.get(id);

  console.log(`[Edge] Routing POST /mcp/messages to DO. token:${await tokenTag(resolved)} DO ID: ${id.toString()}`);
  const msgUrl = new URL(request.url);
  msgUrl.pathname = "/messages";
  return obj.fetch(new Request(msgUrl.toString(), request));
}

function handleHomePage(): Response {
  return new Response(homePageHtml(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      ...BASE_SECURITY_HEADERS,
    },
  });
}

// ── HTML templates ──────────────────────────────────────────────────────────

function logoutSuccessHtml(): string {
  return `<!DOCTYPE html>
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
</html>`;
}

function homePageHtml(): string {
  return `<!DOCTYPE html>
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
</html>`;
}

// ── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    console.log(`[Worker Request] ${request.method} ${url.pathname}`);

    try {
      const origin = request.headers.get("Origin");
      const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
      const corsHeaders = buildCorsHeaders(
        origin,
        requestedHeaders ? { "Access-Control-Allow-Headers": requestedHeaders } : {}
      );

      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }

      let response: Response;
      const { pathname } = url;

      if (pathname === "/auth/login") {
        response = await handleLogin(request, env);
      } else if (pathname === "/auth/callback") {
        response = await handleCallback(request, env);
      } else if (pathname === "/auth/logout") {
        response = await handleLogout(request, env);
      } else if (pathname === "/mcp") {
        response = await handleMcp(request, env, url);
      } else if (pathname === "/mcp/sse") {
        response = await handleMcpSse(request, env, url);
      } else if (pathname === "/mcp/messages") {
        response = await handleMcpMessages(request, env, url);
      } else {
        response = handleHomePage();
      }

      // Append CORS headers without overwriting anything the route handler already set.
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) {
        newHeaders.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });

    } catch (e: any) {
      console.error("Worker Error:", e.stack || e.message);
      const corsHeaders = buildCorsHeaders(request.headers.get("Origin"));
      const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
      for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
      return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500, headers });
    }
  },
};
