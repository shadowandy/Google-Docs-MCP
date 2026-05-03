// Fixed-window rate limiter backed by Cloudflare KV.
// Returns false when the caller has exceeded `limit` requests in the current window.
// Note: KV get+put is not atomic; counts may be slightly under-enforced under burst
// concurrency, which is an acceptable trade-off for this use case.
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number
): Promise<boolean> {
  const windowKey = `rl:${key}:${Math.floor(Date.now() / (windowSecs * 1000))}`;
  const current = parseInt((await kv.get(windowKey)) ?? "0");
  if (current >= limit) return false;
  await kv.put(windowKey, String(current + 1), { expirationTtl: windowSecs * 2 });
  return true;
}

/** Returns the first `length` hex characters of SHA-256(token). Used for safe logging. */
export async function tokenTag(token: string, length = 8): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

// Security headers shared across all HTML responses.
// Individual responses add Content-Security-Policy appropriate to their content.
export const BASE_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
