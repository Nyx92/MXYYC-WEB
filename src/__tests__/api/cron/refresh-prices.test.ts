import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/cron/refresh-prices is the cheap, frequent half of the two-tier
 * pricing strategy. Each call is one time-bounded slice: listed cards not
 * refreshed today first, then catalog cards not refreshed in 7 days. Raw
 * prices go through JustTCG's v1 batch endpoint (100 cards/call), and graded
 * prices — v1 doesn't return those — go through one v2 call per refreshed
 * *listed* card that actually has a graded Listing. Deep history
 * backfilling is a separate route (/api/cron/backfill-prices); this route
 * only ever writes today's price.
 *
 * Prisma, the JustTCG client and JobState are all mocked — no real DB or
 * vendor call.
 */

const mockPrisma = vi.hoisted(() => ({
  pokemonCardCatalog: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  riftboundCardCatalog: { findMany: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
  listing: { findMany: vi.fn() },
  priceHistory: { findMany: vi.fn(), createMany: vi.fn(), update: vi.fn() },
}));

const mockFetchCardVariants = vi.hoisted(() => vi.fn());
const mockFetchCardVariantsBatch = vi.hoisted(() => vi.fn());
const mockRecordJobRun = vi.hoisted(() => vi.fn());
const mockSaveJustTcgQuota = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/jobState", () => ({
  recordJobRun: mockRecordJobRun,
  saveJustTcgQuota: mockSaveJustTcgQuota,
}));
vi.mock("@/lib/pricing/justtcg", () => ({
  fetchCardVariants: mockFetchCardVariants,
  fetchCardVariantsBatch: mockFetchCardVariantsBatch,
  usdMarket: (variant: any) =>
    variant.markets.find((m: any) => m.currency === "USD") ?? variant.markets[0] ?? null,
  pickPricedVariants: (variants: any[]) => {
    const picks: any[] = [];
    const nearMint = variants.find((v) => v.type === "raw" && v.condition === "Near Mint");
    if (nearMint) picks.push({ label: "RAW", variant: nearMint });
    for (const v of variants) {
      if (v.type === "graded" && v.grading) {
        const company = { PSA: "PSA", CGC: "CGC", BGS: "BECKETT" }[v.grading.company as "PSA" | "CGC" | "BGS"];
        if (company) picks.push({ label: `${company} ${v.grading.grade}`, variant: v });
      }
    }
    return picks;
  },
  chunk: (items: any[], size: number) => {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
  },
  runWithConcurrency: async (items: any[], _concurrency: number, fn: (item: any) => Promise<unknown>) => {
    await Promise.all(items.map(fn));
  },
}));

import { GET } from "@/app/api/cron/refresh-prices/route";

function makeRequest(authToken?: string) {
  return new NextRequest("http://localhost/api/cron/refresh-prices", {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
  });
}

// The route asks each catalog model twice: once for listed cards due today
// (where has `listings`), once for catalog cards due this week.
function seedCards(
  model: typeof mockPrisma.pokemonCardCatalog,
  { listed = [], catalog = [] }: { listed?: any[]; catalog?: any[] }
) {
  model.findMany.mockImplementation(async ({ where }: any) => (where.listings ? listed : catalog));
}

const gradedPokemonListing = () =>
  mockPrisma.listing.findMany.mockImplementation(async ({ where }: any) =>
    where.pokemonCardId ? [{ condition: "PSA 10", pokemonCardId: "pkm-1" }] : []
  );

const NEAR_MINT_VARIANT = {
  type: "raw",
  condition: "Near Mint",
  grading: null,
  markets: [{ currency: "USD", price: 10 }],
};
const PSA10_VARIANT = {
  type: "graded",
  condition: null,
  grading: { company: "PSA", grade: 10 },
  markets: [{ currency: "USD", price: 300 }],
};

describe("GET /api/cron/refresh-prices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.pokemonCardCatalog.findMany.mockResolvedValue([]);
    mockPrisma.riftboundCardCatalog.findMany.mockResolvedValue([]);
    mockPrisma.listing.findMany.mockResolvedValue([]);
    mockPrisma.pokemonCardCatalog.count.mockResolvedValue(0);
    mockPrisma.riftboundCardCatalog.count.mockResolvedValue(0);
    mockPrisma.priceHistory.findMany.mockResolvedValue([]);
    mockFetchCardVariantsBatch.mockResolvedValue(new Map());
  });

  it("returns 401 when the bearer token is wrong", async () => {
    const res = await GET(makeRequest("wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("batches a due catalog card's raw price through fetchCardVariantsBatch", async () => {
    const card = { id: "pkm-1", tcgPlayerId: "42360", language: "English" };
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: [card] });
    mockFetchCardVariantsBatch.mockResolvedValue(
      new Map([["42360", [NEAR_MINT_VARIANT]]])
    );

    const res = await GET(makeRequest("test-cron-secret"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.rawRefreshed).toBe(1);
    expect(mockFetchCardVariantsBatch).toHaveBeenCalledWith(["42360"]);
    expect(mockPrisma.priceHistory.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({
            game: "POKEMON",
            pokemonCardId: "pkm-1",
            variant: "RAW",
            priceCents: Math.round(10 * 1.29 * 100),
          }),
        ]),
      })
    );
  });

  it("splits more than 100 cards into multiple batch calls", async () => {
    const cards = Array.from({ length: 150 }, (_, i) => ({
      id: `pkm-${i}`,
      tcgPlayerId: `id-${i}`,
      language: "English",
    }));
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: cards });

    await GET(makeRequest("test-cron-secret"));

    expect(mockFetchCardVariantsBatch).toHaveBeenCalledTimes(2);
    expect(mockFetchCardVariantsBatch.mock.calls[0][0]).toHaveLength(100);
    expect(mockFetchCardVariantsBatch.mock.calls[1][0]).toHaveLength(50);
  });

  it("only calls fetchCardVariants (v2) for cards with an actual graded listing", async () => {
    const gradedCard = { id: "pkm-1", tcgPlayerId: "42360", language: "English" };
    const rawOnlyCard = { id: "pkm-2", tcgPlayerId: "99999", language: "English" };
    seedCards(mockPrisma.pokemonCardCatalog, { listed: [gradedCard, rawOnlyCard] });
    gradedPokemonListing();
    mockFetchCardVariants.mockResolvedValue([PSA10_VARIANT]);

    const res = await GET(makeRequest("test-cron-secret"));
    const data = await res.json();

    expect(mockFetchCardVariants).toHaveBeenCalledTimes(1);
    expect(mockFetchCardVariants).toHaveBeenCalledWith({
      tcgPlayerId: "42360",
      game: "POKEMON",
      language: "English",
    });
    expect(data.gradedRefreshed).toBe(1);
    expect(mockPrisma.priceHistory.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([
          expect.objectContaining({ variant: "PSA 10", priceCents: Math.round(300 * 1.29 * 100) }),
        ]),
      })
    );
  });

  it("does not re-write RAW from the graded (v2) call — that's the batch pass's job", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { listed: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    gradedPokemonListing();
    mockFetchCardVariants.mockResolvedValue([NEAR_MINT_VARIANT, PSA10_VARIANT]);

    await GET(makeRequest("test-cron-secret"));

    const rawWrites = mockPrisma.priceHistory.createMany.mock.calls
      .flatMap((c: any) => c[0].data)
      .filter((row: any) => row.variant === "RAW");
    expect(rawWrites).toHaveLength(0);
  });

  it("continues when a raw batch fails, counting every card in it as failed", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { listed: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    mockFetchCardVariantsBatch.mockRejectedValue(new Error("JustTCG batch request failed: 500"));

    const res = await GET(makeRequest("test-cron-secret"));
    const data = await res.json();

    expect(data.failed).toBe(1);
    expect(data.errors[0]).toContain("500");
  });

  it("doesn't count a batch as refreshed when its price write fails", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { listed: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    mockFetchCardVariantsBatch.mockResolvedValue(new Map([["42360", [NEAR_MINT_VARIANT]]]));
    mockPrisma.priceHistory.createMany.mockRejectedValueOnce(new Error("db write failed"));

    const data = await (await GET(makeRequest("test-cron-secret"))).json();

    expect(data.rawRefreshed).toBe(0);
    expect(data.failed).toBe(1);
  });

  it("continues when one graded card's v2 call fails", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { listed: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    gradedPokemonListing();
    mockFetchCardVariants.mockRejectedValue(new Error("JustTCG request failed: 500"));

    const res = await GET(makeRequest("test-cron-secret"));
    const data = await res.json();

    expect(data.failed).toBe(1);
    expect(data.errors[0]).toContain("pkm-1");
  });

  it("queries catalog cards with a tcgPlayerId, not just ones with a listing", async () => {
    await GET(makeRequest("test-cron-secret"));
    const catalogQuery = mockPrisma.pokemonCardCatalog.findMany.mock.calls
      .map((c: any) => c[0].where)
      .find((where: any) => !where.listings);
    expect(catalogQuery).toMatchObject({ tcgPlayerId: { not: null } });
  });

  it("only picks listed cards not refreshed since UTC midnight today", async () => {
    await GET(makeRequest("test-cron-secret"));
    const startOfToday = new Date(new Date().toISOString().slice(0, 10));
    expect(mockPrisma.pokemonCardCatalog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tcgPlayerId: { not: null },
          listings: { some: {} },
          OR: [{ priceRefreshedAt: null }, { priceRefreshedAt: { lt: startOfToday } }],
        },
      })
    );
  });

  it("fetches listed cards due today before catalog cards (Riftbound catalog before Pokemon)", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, {
      listed: [{ id: "pkm-listed", tcgPlayerId: "listed", language: "English" }],
      catalog: [{ id: "pkm-cat", tcgPlayerId: "pkm-cat", language: "English" }],
    });
    seedCards(mockPrisma.riftboundCardCatalog, { catalog: [{ id: "rb-cat", tcgPlayerId: "rb-cat" }] });

    await GET(makeRequest("test-cron-secret"));

    expect(mockFetchCardVariantsBatch).toHaveBeenCalledTimes(1);
    expect(mockFetchCardVariantsBatch.mock.calls[0][0]).toEqual(["listed", "rb-cat", "pkm-cat"]);
  });

  it("sets priceRefreshedAt for every card in a successfully written batch", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    seedCards(mockPrisma.riftboundCardCatalog, { catalog: [{ id: "rb-1", tcgPlayerId: "77" }] });
    mockFetchCardVariantsBatch.mockResolvedValue(new Map([["42360", [NEAR_MINT_VARIANT]]]));

    await GET(makeRequest("test-cron-secret"));

    // rb-1 had no price from JustTCG, but the attempt is still recorded so it
    // isn't retried every slice.
    expect(mockPrisma.pokemonCardCatalog.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["pkm-1"] } },
      data: { priceRefreshedAt: expect.any(Date) },
    });
    expect(mockPrisma.riftboundCardCatalog.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["rb-1"] } },
      data: { priceRefreshedAt: expect.any(Date) },
    });
  });

  it("leaves priceRefreshedAt untouched for a failed batch, so it's picked up next slice", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    mockFetchCardVariantsBatch.mockRejectedValue(new Error("JustTCG batch request failed: 500"));

    await GET(makeRequest("test-cron-secret"));

    expect(mockPrisma.pokemonCardCatalog.updateMany).not.toHaveBeenCalled();
  });

  it("records a failing run via recordJobRun when a batch fails", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    mockFetchCardVariantsBatch.mockRejectedValue(new Error("JustTCG batch request failed: 500"));

    await GET(makeRequest("test-cron-secret"));

    expect(mockSaveJustTcgQuota).toHaveBeenCalled();
    expect(mockRecordJobRun).toHaveBeenCalledWith(
      "refresh-prices",
      expect.objectContaining({ ok: false, errors: [expect.stringContaining("500")] })
    );
  });

  it("records an ok run when every batch lands", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    mockFetchCardVariantsBatch.mockResolvedValue(new Map([["42360", [NEAR_MINT_VARIANT]]]));

    await GET(makeRequest("test-cron-secret"));

    expect(mockRecordJobRun).toHaveBeenCalledWith("refresh-prices", expect.objectContaining({ ok: true }));
  });

  it("makes no JustTCG call when nothing is due, and reports what's still due", async () => {
    mockPrisma.pokemonCardCatalog.count.mockImplementation(async ({ where }: any) => (where.listings ? 0 : 3));
    mockPrisma.riftboundCardCatalog.count.mockResolvedValue(0);

    const data = await (await GET(makeRequest("test-cron-secret"))).json();

    expect(mockFetchCardVariantsBatch).not.toHaveBeenCalled();
    expect(mockFetchCardVariants).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      rawRefreshed: 0,
      failed: 0,
      remaining: { listedDueToday: 0, catalogDue: 3 },
      stoppedForTime: false,
    });
  });

  it("skips the graded (v2) call for a graded card that's only in the catalog pass, not listed", async () => {
    seedCards(mockPrisma.pokemonCardCatalog, { catalog: [{ id: "pkm-1", tcgPlayerId: "42360", language: "English" }] });
    gradedPokemonListing();

    await GET(makeRequest("test-cron-secret"));

    expect(mockFetchCardVariants).not.toHaveBeenCalled();
  });
});
