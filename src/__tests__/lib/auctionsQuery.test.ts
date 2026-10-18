import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  auction: { findMany: vi.fn(), count: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { getAuctionsPage, MAX_IDS } from "@/lib/auctionsQuery";

const DB_AUCTION = {
  id: "auction-1",
  listingId: "card-1",
  sellerId: "seller-1",
  startingBid: 500,
  reservePrice: null,
  buyOutPrice: null,
  currentBid: null,
  highestBidderId: null,
  status: "active",
  endsAt: new Date(Date.now() + 60 * 60 * 1000),
  sellerDecisionDeadline: null,
  version: 0,
  _count: { bids: 0 },
  listing: {
    id: "card-1", imageUrls: [], condition: "Raw NM", inAuction: true,
    owner: { id: "seller-1", username: "ash" },
    pokemonCard: {
      nameEn: "Charizard", rarity: "Holo Rare", setNameEn: "Base Set",
      language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
    },
    riftboundCard: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.auction.findMany.mockResolvedValue([DB_AUCTION]);
  mockPrisma.auction.count.mockResolvedValue(1);
});

describe("getAuctionsPage", () => {
  it("returns auctions with prices converted to dollars and card title resolved", async () => {
    const result = await getAuctionsPage({});
    expect(result.auctions).toHaveLength(1);
    expect(result.auctions[0]).toMatchObject({ cardId: "card-1", startingBid: 5 });
    expect(result.auctions[0].card.title).toBe("Charizard");
    // Public response — must not leak who the leading bidder is.
    expect(result.auctions[0]).not.toHaveProperty("highestBidderId");
  });

  it("does not paginate or count when page/pageSize are omitted", async () => {
    const result = await getAuctionsPage({});
    expect(mockPrisma.auction.count).not.toHaveBeenCalled();
    expect(result.hasMore).toBeUndefined();
    expect(result.totalCount).toBeUndefined();
  });

  it("computes hasMore from totalCount when paginated", async () => {
    mockPrisma.auction.count.mockResolvedValue(50);
    const result = await getAuctionsPage({ page: 1, pageSize: 24 });
    expect(result.totalCount).toBe(50);
    expect(result.hasMore).toBe(true);
  });

  it("caps ids at MAX_IDS rather than accepting an unbounded list", async () => {
    const manyIds = Array.from({ length: MAX_IDS + 50 }, (_, i) => `id-${i}`);
    await getAuctionsPage({ ids: manyIds });

    const call = mockPrisma.auction.findMany.mock.calls[0][0];
    const idsCondition = call.where.AND.find((c: any) => c.id)?.id;
    expect(idsCondition.in.length).toBe(MAX_IDS);
    expect(idsCondition.in).toEqual(manyIds.slice(0, MAX_IDS));
  });
});
