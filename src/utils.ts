// Sliding-window counter rate limiter backed by Cloudflare KV.
// Uses two adjacent fixed windows to approximate a rolling window, preventing
// the 2× burst that a pure fixed-window allows at window boundaries.
// Formula: weighted = prev * (1 − elapsed/window) + current
// Note: KV get+put is not atomic; slight under-enforcement under concurrency is
// an acceptable trade-off compared with a Redis INCR+EXPIRE atomic operation.
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSecs: number
): Promise<boolean> {
  const now = Date.now();
  const windowMs = windowSecs * 1000;
  const currentWindow = Math.floor(now / windowMs);
  const elapsed = now - currentWindow * windowMs;
  const prevFraction = 1 - elapsed / windowMs;

  const currentKey = `rl:${key}:${currentWindow}`;
  const prevKey = `rl:${key}:${currentWindow - 1}`;

  const [currentStr, prevStr] = await Promise.all([kv.get(currentKey), kv.get(prevKey)]);
  const current = parseInt(currentStr ?? "0");
  const prev = parseInt(prevStr ?? "0");

  const weighted = prev * prevFraction + current;
  if (weighted >= limit) return false;

  await kv.put(currentKey, String(current + 1), { expirationTtl: windowSecs * 2 });
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
