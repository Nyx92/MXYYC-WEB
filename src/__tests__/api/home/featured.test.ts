import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/home/featured
 *
 * Public, unauthenticated homepage data source (best sellers, highest
 * transacted, newly listed, auctions ending soon). Because it has no auth
 * check at all, it must never include a listing owner's email — anyone can
 * curl this endpoint. Commit 6410447 fixed the equivalent leak on
 * /api/cards and /api/cards/[id]; this route was missed.
 *
 * Card identity (title/rarity/etc.) is resolved from whichever catalog
 * relation (pokemonCard/riftboundCard) is populated on each listing.
 */

const mockPrisma = vi.hoisted(() => ({
  bestSeller: { findMany: vi.fn() },
  listing: { findMany: vi.fn() },
  auction: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
// unstable_cache needs the Next.js server's cache. Here it only passes the
// call through, as JSON — the same plain shape the real cache returns.
vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => async () => JSON.parse(JSON.stringify(await fn())),
}));

import { GET } from "@/app/api/home/featured/route";

function makeListing(overrides: Partial<any> = {}) {
  return {
    id: "card-1",
    price: 1000,
    forSale: true,
    owner: { id: "owner-1", username: "Ash" },
    pokemonCard: {
      nameEn: "Charizard",
      rarity: "Rare Holo",
      setNameEn: "Base Set",
      language: "English",
      localId: "004",
      tcgPlayerId: "tcg-1",
    },
    riftboundCard: null,
    ...overrides,
  };
}

function makeAuction(overrides: Partial<any> = {}) {
  return {
    id: "auction-1",
    listingId: "card-1",
    sellerId: "owner-1",
    startingBid: 500,
    reservePrice: null,
    buyOutPrice: null,
    currentBid: null,
    highestBidderId: null,
    status: "active",
    endsAt: new Date("2026-01-01"),
    sellerDecisionDeadline: null,
    version: 1,
    _count: { bids: 0 },
    listing: {
      id: "card-1",
      imageUrls: [],
      condition: "NM",
      inAuction: true,
      owner: { id: "owner-1", username: "Ash" },
      pokemonCard: {
        nameEn: "Charizard",
        rarity: "Rare Holo",
        setNameEn: "Base Set",
        language: "English",
        localId: "004",
        tcgPlayerId: "tcg-1",
      },
      riftboundCard: null,
    },
    ...overrides,
  };
}

describe("GET /api/home/featured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.bestSeller.findMany.mockResolvedValue([{ tcgPlayerId: "tcg-1" }]);
    mockPrisma.$queryRaw.mockResolvedValue([{ tcgPlayerId: "tcg-1", count: BigInt(3) }]);
    mockPrisma.listing.findMany.mockResolvedValue([makeListing()]);
    mockPrisma.auction.findMany.mockResolvedValue([]);
  });

  it("resolves card identity fields via the catalog relation for bestSellers, highestTransacted, and newlyListed", async () => {
    const res = await GET();
    const body = await res.json();

    for (const list of [body.bestSellers, body.highestTransacted, body.newlyListed]) {
      for (const card of list) {
        expect(card.title).toBe("Charizard");
        expect(card).not.toHaveProperty("pokemonCard");
        expect(card).not.toHaveProperty("riftboundCard");
      }
    }
  });

  it("never includes the listing owner's email in bestSellers, highestTransacted, or newlyListed", async () => {
    const res = await GET();
    const body = await res.json();

    for (const list of [body.bestSellers, body.highestTransacted, body.newlyListed]) {
      for (const card of list) {
        expect(card.owner).toEqual({ id: "owner-1", username: "Ash" });
        expect(card.owner.email).toBeUndefined();
      }
    }

    // The response-body assertions above can't actually prove the fix: the
    // mocks return an email-free owner regardless of what select the route
    // passes to Prisma, so reverting `listingInclude.owner`'s select back to
    // including `email: true` would still pass them. Assert on the actual
    // call arguments for every prisma.listing.findMany call — both the
    // batched cheapestListingPerTcgPlayerId calls driving bestSellers/
    // highestTransacted, and the direct call driving newlyListed all share
    // listingInclude — so this test fails if that select is ever widened again.
    expect(mockPrisma.listing.findMany.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of mockPrisma.listing.findMany.mock.calls) {
      expect(args.include.owner).toEqual({ select: { id: true, username: true } });
    }
  });

  it("matches bestSellers/highestTransacted against either catalog relation's tcgPlayerId, batched into one query", async () => {
    await GET();

    // Only the cheapestListingPerTcgPlayerId-driven calls have an OR clause
    // (newlyListed's call filters on forSale/createdAt only) — filter down
    // to those before asserting on the batched `in` shape.
    const batchedCalls = mockPrisma.listing.findMany.mock.calls
      .map(([args]) => args)
      .filter((args) => args.where.OR);

    expect(batchedCalls.length).toBeGreaterThan(0);
    for (const args of batchedCalls) {
      expect(args.where.OR).toEqual([
        { pokemonCard: { tcgPlayerId: { in: ["tcg-1"] } } },
        { riftboundCard: { tcgPlayerId: { in: ["tcg-1"] } } },
      ]);
      expect(args.where.forSale).toBe(true);
    }
  });

  it("batches bestSellers into a single query rather than one findMany per row", async () => {
    mockPrisma.bestSeller.findMany.mockResolvedValue([
      { tcgPlayerId: "tcg-1" },
      { tcgPlayerId: "tcg-2" },
      { tcgPlayerId: "tcg-3" },
    ]);

    await GET();

    const batchedCalls = mockPrisma.listing.findMany.mock.calls
      .map(([args]) => args)
      .filter((args) => args.where.OR);

    // One batched call carries all three tcgPlayerIds — not three separate calls.
    const bestSellersCall = batchedCalls.find((args) =>
      args.where.OR[0].pokemonCard.tcgPlayerId.in.includes("tcg-2")
    );
    expect(bestSellersCall.where.OR).toEqual([
      { pokemonCard: { tcgPlayerId: { in: ["tcg-1", "tcg-2", "tcg-3"] } } },
      { riftboundCard: { tcgPlayerId: { in: ["tcg-1", "tcg-2", "tcg-3"] } } },
    ]);
  });

  it("queries transaction counts directly off CardTransaction without joining a card table", async () => {
    await GET();

    const [sqlParts] = mockPrisma.$queryRaw.mock.calls[0];
    const sql = sqlParts.join("");
    expect(sql).toContain("CardTransaction");
    expect(sql).not.toContain("JOIN");
    expect(sql).not.toMatch(/"Card"/);
  });

  it("resolves auction card display fields and preserves the AuctionCard response shape", async () => {
    mockPrisma.auction.findMany.mockResolvedValueOnce([makeAuction()]);

    const res = await GET();
    const body = await res.json();

    expect(body.auctionsEndingSoon).toHaveLength(1);
    const auctionCard = body.auctionsEndingSoon[0].card;
    expect(auctionCard.title).toBe("Charizard");
    expect(auctionCard.owner).toEqual({ id: "owner-1", username: "Ash" });
    expect(auctionCard).not.toHaveProperty("pokemonCard");
    expect(auctionCard).not.toHaveProperty("riftboundCard");

    const auctionArgs = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(auctionArgs.include.listing.select.pokemonCard).toBe(true);
    expect(auctionArgs.include.listing.select.riftboundCard).toBe(true);
  });

  // What's being tested: the four independent query groups (bestSellers,
  // highestTransacted, newlyListed, auctionsEndingSoon) must be issued
  // concurrently, not one after another — none of them depends on another's
  // result. This test proves concurrency by using manually-controlled
  // ("deferred") promises: if the route awaited them sequentially, only the
  // first mock would be invoked before this assertion runs; if it uses
  // Promise.all (or an equivalent), all four are invoked before any resolve.

  it("issues all four independent query groups concurrently", async () => {
    const started: string[] = [];
    const finishers: Record<string, (v: any) => void> = {};

    function deferred(name: string, value: any) {
      started.push(name);
      return new Promise((resolve) => {
        finishers[name] = () => resolve(value);
      });
    }

    mockPrisma.bestSeller.findMany.mockImplementation(() => deferred("bestSeller", []));
    mockPrisma.$queryRaw.mockImplementation(() => deferred("queryRaw", []));
    mockPrisma.listing.findMany.mockImplementation(() => deferred("newlyListed", []));
    mockPrisma.auction.findMany.mockImplementation(() => deferred("endingSoon", []));

    const resPromise = GET();
    await Promise.resolve(); // let the handler run up to its first await boundary
    await Promise.resolve(); // and its microtask continuations

    expect(started.sort()).toEqual(["bestSeller", "endingSoon", "newlyListed", "queryRaw"]);

    Object.values(finishers).forEach((finish) => finish(undefined));
    await resPromise;
  });
});
