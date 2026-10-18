import { describe, it, expect } from "vitest";
import { checkRateLimit, rateLimitResponse } from "@/lib/rateLimit";

/**
 * rateLimitResponse — checkRateLimit + the standard 429 body in one call.
 * Buckets are in-memory and module-global, so each test uses a unique key.
 */
describe("rateLimitResponse", () => {
  it("returns null under the limit and a 429 once over it", async () => {
    const key = `test:rateLimitResponse:${Date.now()}:${Math.random()}`;
    const opts = { limit: 2, windowMs: 60_000 };

    expect(rateLimitResponse(key, opts)).toBeNull();
    expect(rateLimitResponse(key, opts)).toBeNull();

    const res = rateLimitResponse(key, opts);
    expect(res?.status).toBe(429);
    expect(await res!.json()).toMatchObject({ error: expect.any(String) });
  });
});

describe("checkRateLimit periodic sweep", () => {
  it("keeps a still-live bucket's count across a sweep of expired ones", () => {
    const key = `test:sweep:${Date.now()}:${Math.random()}`;
    const opts = { limit: 1, windowMs: 60_000 };
    expect(checkRateLimit(key, opts).allowed).toBe(true);

    // Enough short-lived one-off keys to trigger at least one sweep.
    for (let i = 0; i < 1100; i++) {
      checkRateLimit(`test:sweep-filler:${i}:${Math.random()}`, { limit: 1, windowMs: 0 });
    }

    expect(checkRateLimit(key, opts).allowed).toBe(false);
  });
});
