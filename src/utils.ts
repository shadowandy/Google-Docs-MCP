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
