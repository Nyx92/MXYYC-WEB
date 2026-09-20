import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/cron/report-performance pulls a p95/throughput/error-rate summary
 * from Sentry's Events API and posts it to the same Discord cron-alerts
 * channel as refresh-prices/backfill-prices (postCronResult). global.fetch
 * (Sentry's API) and Discord are both mocked — no real network call.
 */

const mockPostCronResult = vi.hoisted(() => vi.fn());
vi.mock("@/lib/discord", () => ({ postCronResult: mockPostCronResult }));

import { GET } from "@/app/api/cron/report-performance/route";

function makeRequest(authToken?: string) {
  return new NextRequest("http://localhost/api/cron/report-performance", {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
  });
}

describe("GET /api/cron/report-performance", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    mockPostCronResult.mockReset().mockResolvedValue(undefined);
    vi.stubEnv("CRON_SECRET", "test-secret");
    vi.stubEnv("SENTRY_AUTH_TOKEN", "test-token");
    vi.stubEnv("SENTRY_ORG", "test-org");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("returns 401 when the cron secret doesn't match", async () => {
    const res = await GET(makeRequest("wrong-secret"));
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns 500 and alerts Discord when SENTRY_AUTH_TOKEN is missing", async () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");
    const res = await GET(makeRequest("test-secret"));
    expect(res.status).toBe(500);
    expect(mockPostCronResult).toHaveBeenCalledWith(
      expect.objectContaining({ job: "report-performance", ok: false })
    );
  });

  it("queries Sentry and posts a success summary to Discord", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ "p95(transaction.duration)": 842.3, "count()": 1204, "failure_rate()": 0.018 }],
      }),
    });

    const res = await GET(makeRequest("test-secret"));
    expect(res.status).toBe(200);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("organizations/test-org/events/");
    expect(url).toContain("project=-1");
    expect(init.headers.Authorization).toBe("Bearer test-token");

    expect(mockPostCronResult).toHaveBeenCalledWith({
      job: "report-performance",
      ok: true,
      summary: "p95 latency: 842ms · Throughput: 1,204 transactions · Error rate: 1.8% (last 1h)",
    });
  });

  it("posts a failure alert and returns 502 when Sentry's API errors", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403, text: async () => "Forbidden" });

    const res = await GET(makeRequest("test-secret"));
    expect(res.status).toBe(502);
    expect(mockPostCronResult).toHaveBeenCalledWith(
      expect.objectContaining({ job: "report-performance", ok: false })
    );
  });

  it("posts a crash alert and returns 500 when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("network down"));

    const res = await GET(makeRequest("test-secret"));
    expect(res.status).toBe(500);
    expect(mockPostCronResult).toHaveBeenCalledWith(
      expect.objectContaining({ job: "report-performance", ok: false, summary: "Crashed: network down" })
    );
  });
});
