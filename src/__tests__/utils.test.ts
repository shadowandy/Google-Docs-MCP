import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tokenTag, checkRateLimit } from "../utils";

// ── Minimal in-memory KVNamespace mock ────────────────────────────────────────

function createKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string, _opts?: unknown) { store.set(key, value); },
    async delete(key: string) { store.delete(key); },
    async list() { return { keys: [], list_complete: true, cursor: "" } as any; },
    async getWithMetadata(key: string) { return { value: store.get(key) ?? null, metadata: null } as any; },
  } as unknown as KVNamespace;
}

// ── tokenTag ──────────────────────────────────────────────────────────────────

describe("tokenTag", () => {
  it("returns an 8-character lowercase hex string by default", async () => {
    const tag = await tokenTag("any-token");
    expect(tag).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic — same input always produces the same tag", async () => {
    const a = await tokenTag("my-token");
    const b = await tokenTag("my-token");
    expect(a).toBe(b);
  });

  it("different inputs produce different tags", async () => {
    const a = await tokenTag("token-a");
    const b = await tokenTag("token-b");
    expect(a).not.toBe(b);
  });

  it("respects a custom length parameter", async () => {
    expect(await tokenTag("x", 4)).toHaveLength(4);
    expect(await tokenTag("x", 16)).toHaveLength(16);
  });
});

// ── checkRateLimit ────────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests that are under the limit", async () => {
    const kv = createKv();
    vi.setSystemTime(0);
    expect(await checkRateLimit(kv, "k", 3, 60)).toBe(true);
    expect(await checkRateLimit(kv, "k", 3, 60)).toBe(true);
    expect(await checkRateLimit(kv, "k", 3, 60)).toBe(true);
  });

  it("blocks the request that would exceed the limit", async () => {
    const kv = createKv();
    vi.setSystemTime(0);
    await checkRateLimit(kv, "k", 2, 60);
    await checkRateLimit(kv, "k", 2, 60);
    expect(await checkRateLimit(kv, "k", 2, 60)).toBe(false);
  });

  it("different keys are tracked independently", async () => {
    const kv = createKv();
    vi.setSystemTime(0);
    await checkRateLimit(kv, "a", 1, 60);                        // fills 'a'
    expect(await checkRateLimit(kv, "a", 1, 60)).toBe(false);   // 'a' blocked
    expect(await checkRateLimit(kv, "b", 1, 60)).toBe(true);    // 'b' unaffected
  });

  it("prevents the 2x boundary burst that a fixed-window allows", async () => {
    const kv = createKv();
    // Fill window 0 to the limit
    vi.setSystemTime(0);
    await checkRateLimit(kv, "k", 3, 60);
    await checkRateLimit(kv, "k", 3, 60);
    await checkRateLimit(kv, "k", 3, 60);

    // At the exact start of window 1, prevFraction = 1.0 so the full previous
    // window count still applies: weighted = 3 * 1.0 + 0 = 3 >= limit → blocked.
    vi.setSystemTime(60_000);
    expect(await checkRateLimit(kv, "k", 3, 60)).toBe(false);
  });

  it("allows requests again once the previous window no longer contributes", async () => {
    const kv = createKv();
    vi.setSystemTime(0);
    // Fill window 0 to limit
    for (let i = 0; i < 3; i++) await checkRateLimit(kv, "k", 3, 60);
    expect(await checkRateLimit(kv, "k", 3, 60)).toBe(false);

    // Two full windows later: prev key is window 1 (empty); weighted = 0 → allowed
    vi.setSystemTime(120_000);
    expect(await checkRateLimit(kv, "k", 3, 60)).toBe(true);
  });

  it("partial window: previous count is weighted by remaining overlap", async () => {
    const kv = createKv();
    vi.setSystemTime(0);
    // Put 4 requests in window 0
    for (let i = 0; i < 4; i++) await checkRateLimit(kv, "k", 5, 60);

    // At 75% into window 1, prevFraction = 0.25
    // weighted = 4 * 0.25 + 0 = 1 < 5 → allowed
    vi.setSystemTime(60_000 + 45_000);
    expect(await checkRateLimit(kv, "k", 5, 60)).toBe(true);
  });
});
