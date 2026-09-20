import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/internal/log-error relays a browser-captured Sentry error to
 * Discord (see instrumentation-client.ts's beforeSend, which can't hold the
 * webhook URL directly). Discord and the rate limiter are both mocked — no
 * real network call, no real rate-limit state.
 */

const mockPostErrorAlert = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn());
const mockGetClientIp = vi.hoisted(() => vi.fn());

vi.mock("@/lib/discord", () => ({ postErrorAlert: mockPostErrorAlert }));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: mockGetClientIp,
}));

import { POST } from "@/app/api/internal/log-error/route";

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/internal/log-error", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/log-error", () => {
  beforeEach(() => {
    mockPostErrorAlert.mockReset().mockResolvedValue(undefined);
    mockCheckRateLimit.mockReset().mockReturnValue({ allowed: true });
    mockGetClientIp.mockReset().mockReturnValue("1.2.3.4");
  });

  it("forwards a valid payload to postErrorAlert and returns ok", async () => {
    const res = await POST(
      makeRequest({ message: "TypeError: boom", environment: "production", url: "https://x.test/page" })
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(mockPostErrorAlert).toHaveBeenCalledWith({
      message: "TypeError: boom",
      runtime: "browser",
      environment: "production",
      url: "https://x.test/page",
    });
  });

  it("defaults environment to unknown and omits url when not given", async () => {
    await POST(makeRequest({ message: "boom" }));
    expect(mockPostErrorAlert).toHaveBeenCalledWith({
      message: "boom",
      runtime: "browser",
      environment: "unknown",
      url: undefined,
    });
  });

  it("rejects a missing message with 400 and does not call postErrorAlert", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockPostErrorAlert).not.toHaveBeenCalled();
  });

  it("returns 429 and skips postErrorAlert when rate limited", async () => {
    mockCheckRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 1000 });
    const res = await POST(makeRequest({ message: "boom" }));
    expect(res.status).toBe(429);
    expect(mockPostErrorAlert).not.toHaveBeenCalled();
  });

  it("truncates an overlong message to 4000 characters", async () => {
    const long = "x".repeat(5000);
    await POST(makeRequest({ message: long }));
    const call = mockPostErrorAlert.mock.calls[0][0];
    expect(call.message).toHaveLength(4000);
  });

  it("degrades quietly (ok:false, no throw) when the request body isn't valid JSON", async () => {
    const req = new NextRequest("http://localhost/api/internal/log-error", {
      method: "POST",
      body: "not json",
    });
    const res = await POST(req);
    await expect(res.json()).resolves.toEqual({ ok: false });
    expect(mockPostErrorAlert).not.toHaveBeenCalled();
  });
});
