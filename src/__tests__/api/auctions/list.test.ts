import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/auctions — list auctions.
 *
 * Three query modes:
 *   ?cardId=xxx        — active/pending_seller_decision auction for one card (card detail page)
 *   ?expiringSoon=true — top-5 active auctions still in the future (homepage row)
 *   (no params)        — all active auctions still in the future (browse page)
 *
 * The Auction model's card reference is `listingId` (renamed from `cardId`);
 * card identity (title, rarity, etc.) is resolved from whichever catalog
 * relation (pokemonCard/riftboundCard) the listing points to. The external
 * response shape (cardId, nested card: {...}) is unchanged.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  auction: {
    findMany:  vi.fn(),
    findFirst: vi.fn(),
    count:     vi.fn(),
  },
}));

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth",    () => ({ getServerSession: vi.fn() }));
vi.mock("@/lib/auth",   () => ({ authOptions: {} }));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { GET } from "@/app/api/auctions/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Takes a raw query string (e.g. "?setName=A&setName=B") rather than a
// key-value Record — a Record can only carry one value per key, which
// structurally cannot express repeatable params like ?setName=A&setName=B.
// Mirrors get-cards.test.ts's cardsRequest for the same reason.
function getReq(query: string = "") {
  return new NextRequest(`http://localhost/api/auctions${query}`);
}

// Minimal DB auction row (prices in cents, as Prisma returns them)
function makeDbAuction(overrides: Partial<{
  id:      string;
  endsAt:  Date;
  status:  string;
}> = {}) {
  return {
    id:                     "auction-1",
    listingId:              "card-1",
    sellerId:               "seller-1",
    startingBid:            500,   // cents — formatAuction converts to S$5.00
    reservePrice:           null,
    buyOutPrice:            null,
    currentBid:             null,
    highestBidderId:        null,
    status:                 "active",
    endsAt:                 new Date(Date.now() + 60 * 60 * 1000), // 1 h from now
    sellerDecisionDeadline: null,
    version:                0,
    _count:                 { bids: 0 },
    listing: {
      id: "card-1", imageUrls: [], condition: "Raw NM", inAuction: true,
      owner: { id: "seller-1", username: "ash" },
      pokemonCard: {
        nameEn: "Charizard", rarity: "Holo Rare", setNameEn: "Base Set",
        language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
      },
      riftboundCard: null,
    },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/auctions", () => {
  // ── Browse page (no params) ───────────────────────────────────────────────

  it("browse: queries only active auctions whose endsAt is in the future, ordered by endsAt asc by default", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq());

    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ status: "active" }, { endsAt: { gt: expect.any(Date) } }],
    });
    expect(call.orderBy).toEqual([{ endsAt: "asc" }]);
  });

  it("browse: returns prices converted to dollars and resolves card title from the catalog", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([makeDbAuction()]);
    const res  = await GET(getReq());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.auctions).toHaveLength(1);
    expect(body.auctions[0].startingBid).toBe(5); // 500 cents → S$5.00
    expect(body.auctions[0].cardId).toBe("card-1");
    expect(body.auctions[0].card.title).toBe("Charizard");
    expect(body.auctions[0]).not.toHaveProperty("listingId");
  });

  it("browse: returns 500 on DB error", async () => {
    mockPrisma.auction.findMany.mockRejectedValue(new Error("DB failure"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
  });

  it("browse: filters by game through the linked listing", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?game=RIFTBOUND"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ listing: { game: "RIFTBOUND" } });
  });

  it("browse: buyNowOnly restricts to auctions with a buyOutPrice set", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?buyNowOnly=true"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ buyOutPrice: { not: null } });
  });

  it("browse: endingWithinHours restricts endsAt to that window", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?endingWithinHours=1"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ endsAt: { lte: expect.any(Date) } });
  });

  it("browse: sort=mostBids orders by bid count desc", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?sort=mostBids"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ bids: { _count: "desc" } }, { endsAt: "asc" }]);
  });

  it("browse: an unrecognized sort value falls back to endingSoon", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?sort=not-a-real-sort"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ endsAt: "asc" }]);
  });

  it("browse: page+pageSize paginates and reports hasMore via a count query", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([makeDbAuction()]);
    mockPrisma.auction.count.mockResolvedValue(25);
    const res = await GET(getReq("?page=1&pageSize=10"));
    const body = await res.json();

    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
    expect(call.take).toBe(10);
    expect(body.totalCount).toBe(25);
    expect(body.hasMore).toBe(true);
  });

  // ── Homepage row (?expiringSoon=true) ─────────────────────────────────────

  it("expiringSoon: queries only active auctions whose endsAt is in the future", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?expiringSoon=true"));

    expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where:   expect.objectContaining({
          status: "active",
          endsAt: { gt: expect.any(Date) },
        }),
        orderBy: { endsAt: "asc" },
        take:    5,
      })
    );
  });

  it("expiringSoon: returns formatted auctions", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([makeDbAuction()]);
    const res  = await GET(getReq("?expiringSoon=true"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.auctions).toHaveLength(1);
  });

  // ── Card detail page (?cardId=xxx) ────────────────────────────────────────

  it("cardId: queries status in [active, pending_seller_decision] with no endsAt filter, using listingId", async () => {
    mockPrisma.auction.findFirst.mockResolvedValue(null);
    await GET(getReq("?cardId=card-1"));

    expect(mockPrisma.auction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          listingId: "card-1",
          status: { in: ["active", "pending_seller_decision"] },
        },
      })
    );
  });

  it("cardId: returns null when no auction exists", async () => {
    mockPrisma.auction.findFirst.mockResolvedValue(null);
    const res  = await GET(getReq("?cardId=card-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.auction).toBeNull();
  });

  it("cardId: returns the auction even when endsAt has passed (client handles pre-cron display)", async () => {
    const pastEndsAt = new Date(Date.now() - 60 * 60 * 1000); // 1 h ago
    mockPrisma.auction.findFirst.mockResolvedValue(
      makeDbAuction({ status: "active", endsAt: pastEndsAt })
    );
    const res  = await GET(getReq("?cardId=card-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.auction).not.toBeNull();
    expect(body.auction.status).toBe("active");
  });

  it("cardId: surfaces a pending_seller_decision auction even after endsAt has passed", async () => {
    const pastEndsAt = new Date(Date.now() - 60 * 60 * 1000); // 1 h ago
    mockPrisma.auction.findFirst.mockResolvedValue(
      makeDbAuction({ status: "pending_seller_decision", endsAt: pastEndsAt })
    );
    const res  = await GET(getReq("?cardId=card-1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.auction.status).toBe("pending_seller_decision");
  });

  // ── Sort branches (buildOrderBy) ──────────────────────────────────────────

  it("browse: sort=newest orders by createdAt desc", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?sort=newest"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ createdAt: "desc" }]);
  });

  it("browse: sort=priceLow orders by currentBid then startingBid ascending", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?sort=priceLow"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ currentBid: { sort: "asc", nulls: "last" } }, { startingBid: "asc" }]);
  });

  it("browse: sort=priceHigh orders by currentBid then startingBid descending", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?sort=priceHigh"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ currentBid: { sort: "desc", nulls: "last" } }, { startingBid: "desc" }]);
  });

  // ── Facet filters (through the linked listing) ────────────────────────────

  it("browse: filters by one or more setName values, OR'd across both games' set fields", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?setName=Base+Set&setName=Jungle"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      listing: {
        OR: [
          { pokemonCard: { setNameEn: { in: ["Base Set", "Jungle"] } } },
          { riftboundCard: { setLabel: { in: ["Base Set", "Jungle"] } } },
        ],
      },
    });
  });

  it("browse: filters by one or more rarity values, OR'd across both games' rarity fields", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?rarity=Rare&rarity=Rare+Holo"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      listing: {
        OR: [
          { pokemonCard: { rarity: { in: ["Rare", "Rare Holo"] } } },
          { riftboundCard: { rarity: { in: ["Rare", "Rare Holo"] } } },
        ],
      },
    });
  });

  it("browse: filters by Riftbound type (no Pokemon equivalent, so no OR needed)", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?type=Unit&type=Legend"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      listing: { riftboundCard: { type: { in: ["Unit", "Legend"] } } },
    });
  });

  it("browse: filters by condition (a plain scalar column on Listing)", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?condition=Near+Mint&condition=PSA+10"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      listing: { condition: { in: ["Near Mint", "PSA 10"] } },
    });
  });

  it("browse: filters by language, treating every RIFTBOUND listing as English since it has no real language column", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?language=English&language=Japanese"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      listing: {
        OR: [
          { pokemonCard: { language: { in: ["English", "Japanese"] } } },
          { game: "RIFTBOUND" },
        ],
      },
    });
  });

  it("browse: filters by language without the RIFTBOUND carve-out when English isn't selected", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?language=Japanese"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({
      listing: { OR: [{ pokemonCard: { language: { in: ["Japanese"] } } }] },
    });
  });

  it("browse: combined game=RIFTBOUND + language=English still matches Riftbound rows (regression)", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?game=RIFTBOUND&language=English"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ listing: { game: "RIFTBOUND" } });
    expect(call.where.AND).toContainEqual({
      listing: {
        OR: [
          { pokemonCard: { language: { in: ["English"] } } },
          { game: "RIFTBOUND" },
        ],
      },
    });
  });

  it("browse: filters by a list of ids", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?ids=id-1&ids=id-2"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.where.AND).toContainEqual({ id: { in: ["id-1", "id-2"] } });
  });

  it("browse: caps how many ids can be requested at once, rather than accepting an unbounded list", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    const manyIds = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const params = new URLSearchParams();
    manyIds.forEach((id) => params.append("ids", id));

    await GET(getReq(`?${params.toString()}`));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    const idsCondition = call.where.AND.find((c: any) => c.id)?.id;
    expect(idsCondition.in.length).toBe(200);
    expect(idsCondition.in).toEqual(manyIds.slice(0, 200));
  });

  // ── Pagination edge cases ─────────────────────────────────────────────────

  it("browse: an invalid page value falls back to unpaginated rather than erroring", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    await GET(getReq("?page=abc&pageSize=10"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.take).toBe(100); // MAX_PAGE_SIZE, the unpaginated cap
    expect(mockPrisma.auction.count).not.toHaveBeenCalled();
  });

  it("browse: clamps page below 1 up to 1, rather than producing a negative skip", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);
    await GET(getReq("?page=0&pageSize=10"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
  });

  it("browse: clamps pageSize above 100 down to 100", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);
    await GET(getReq("?page=1&pageSize=5000"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });

  it("browse: clamps pageSize below 1 up to 1", async () => {
    mockPrisma.auction.findMany.mockResolvedValue([]);
    mockPrisma.auction.count.mockResolvedValue(0);
    await GET(getReq("?page=1&pageSize=0"));
    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    expect(call.take).toBe(1);
  });
});
