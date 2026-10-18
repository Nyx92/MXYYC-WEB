import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/cron/report-prices posts a daily health digest for the two
 * pricing jobs (which otherwise only alert on status changes). It turns red
 * when the data shows they aren't moving forward — e.g. no backfill progress
 * while cards are waiting and JustTCG quota is available. Prisma, JobState
 * and Discord are all mocked — no real DB or network call.
 */

const mockPrisma = vi.hoisted(() => ({
  pokemonCardCatalog: { count: vi.fn() },
  riftboundCardCatalog: { count: vi.fn() },
  jobState: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
}));
const mockPostCronResult = vi.hoisted(() => vi.fn());
const mockLoadJustTcgQuota = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/discord", () => ({ postCronResult: mockPostCronResult }));
vi.mock("@/lib/jobState", () => ({ loadJustTcgQuota: mockLoadJustTcgQuota }));

import { GET } from "@/app/api/cron/report-prices/route";

function makeRequest(authToken?: string) {
  return new NextRequest("http://localhost/api/cron/report-prices", {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
  });
}

// Answers each catalog count by the shape of its `where` (Riftbound counts 0).
function seedCounts({ pending = 0, backfilled24h = 0 }: { pending?: number; backfilled24h?: number }) {
  mockPrisma.pokemonCardCatalog.count.mockImplementation(async ({ where }: any) => {
    if (where.priceBackfilledAt === null && where.priceBackfillAttempts?.lt) return pending;
    if (where.priceBackfilledAt?.gte) return backfilled24h;
    if (where.OR) return 0; // listed cards without a recent price
    if (where.priceRefreshedAt === null || where.priceRefreshedAt?.lt) return 0; // never / overdue
    return 10;
  });
}

describe("GET /api/cron/report-prices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.riftboundCardCatalog.count.mockResolvedValue(0);
    mockPrisma.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join("").includes("AS dupes") ? [{ dupes: BigInt(0) }] : [{ history_rows: BigInt(30), history_cards: BigInt(3), today_rows: BigInt(10) }]
    );
    mockPrisma.jobState.findUnique.mockResolvedValue({ lastRunAt: new Date(), lastOk: true, lastSummary: "ok" });
    mockLoadJustTcgQuota.mockResolvedValue({ monthlyRemaining: 8000, monthlyLimit: 10000 });
    seedCounts({ pending: 5, backfilled24h: 3 });
  });

  it("returns 401 without the bearer token", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockPostCronResult).not.toHaveBeenCalled();
  });

  it("posts an ok report when both jobs are healthy", async () => {
    const res = await GET(makeRequest("test-cron-secret"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.warnings).toEqual([]);
    expect(mockPostCronResult).toHaveBeenCalledWith(
      expect.objectContaining({ job: "price report", ok: true, errors: [] })
    );
  });

  it("warns about no backfill progress when cards are waiting and quota is available", async () => {
    seedCounts({ pending: 5, backfilled24h: 0 });

    await GET(makeRequest("test-cron-secret"));

    expect(mockPostCronResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        errors: expect.arrayContaining([expect.stringContaining("No backfill progress")]),
      })
    );
  });

  it("doesn't warn about backfill progress while the backfill is paused below the quota reserve", async () => {
    seedCounts({ pending: 5, backfilled24h: 0 });
    mockLoadJustTcgQuota.mockResolvedValue({ monthlyRemaining: 1500, monthlyLimit: 10000 });

    await GET(makeRequest("test-cron-secret"));

    const { errors } = mockPostCronResult.mock.calls[0][0];
    expect(errors.some((e: string) => e.includes("No backfill progress"))).toBe(false);
  });
});
