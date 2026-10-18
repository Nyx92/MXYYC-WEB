import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/auctions — seller starts an auction.
 *
 * Sequence:
 *   1. Auth check
 *   2. Validate inputs (startingBid, durationDays, reservePrice, buyOutPrice)
 *   3. Load listing — must be owned by seller, not already in auction, not
 *      have a pending offer, and not have an active Buy Now reservation
 *   4. Interactive prisma.$transaction: conditionally lock the listing
 *      (listing.updateMany — 0 rows → 409), then create the Auction
 *   5. Return 201 with formatted auction (prices in dollars)
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  auction: { create: vi.fn() },
  offer:   { findFirst: vi.fn() },
  $transaction: vi.fn(),
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("@/lib/prisma",  () => ({ prisma: mockPrisma }));
vi.mock("next-auth",     () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth",    () => ({ authOptions: {} }));
vi.mock("@/lib/notifications", () => ({ notifyAsync: vi.fn(), createNotification: vi.fn() }));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { POST } from "@/app/api/auctions/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function postReq(body: object) {
  return new NextRequest("http://localhost/api/auctions", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

const SELLER_SESSION = { user: { id: "seller-1" } };

const LISTING = {
  id: "card-1", ownerId: "seller-1",
  inAuction: false, reservedById: null, reservedUntil: null,
};

// A minimal DB Auction row returned by prisma.auction.create
function makeDbAuction(overrides = {}) {
  return {
    id:             "auction-1",
    listingId:      "card-1",
    sellerId:       "seller-1",
    startingBid:    500,   // cents
    reservePrice:   null,
    buyOutPrice:    null,
    currentBid:     null,
    highestBidderId: null,
    status:         "active",
    endsAt:         new Date("2099-01-01"),
    sellerDecisionDeadline: null,
    version:        0,
    _count:         { bids: 0 },
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "secret";
  mockPrisma.offer.findFirst.mockResolvedValue(null); // default: no pending offer
  // Interactive transaction: the callback receives mockPrisma as its tx client.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma));
  mockPrisma.listing.updateMany.mockResolvedValue({ count: 1 }); // default: lock succeeds
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/auctions", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when startingBid is missing", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ cardId: "card-1", durationDays: 3 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/starting bid/i);
  });

  it("returns 400 when startingBid is zero", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ cardId: "card-1", startingBid: 0, durationDays: 3 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when startingBid is not a number", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ cardId: "card-1", startingBid: "abc", durationDays: 3 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/starting bid/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 400 when reservePrice is not a number", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    const res = await POST(postReq({
      cardId: "card-1", startingBid: 5, reservePrice: "xyz", durationDays: 3,
    }));
    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 400 when buyOutPrice is not a number", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    const res = await POST(postReq({
      cardId: "card-1", startingBid: 5, buyOutPrice: "xyz", durationDays: 3,
    }));
    expect(res.status).toBe(400);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 400 when durationDays is out of range", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 7 }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/duration/i);
  });

  it("rejects 6 days — the max is 5 so a bid's ~7-day Stripe hold outlives auction + decision window", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 6 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Duration must be between 1 and 5 days");
  });

  it("returns 400 when durationDays is below 1", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 0 }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when reservePrice < startingBid", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({
      cardId: "card-1", startingBid: 10, reservePrice: 5, durationDays: 3,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/reserve/i);
  });

  it("returns 400 when buyOutPrice <= reservePrice", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({
      cardId: "card-1", startingBid: 5, reservePrice: 20, buyOutPrice: 20, durationDays: 3,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/buy-out/i);
  });

  it("returns 400 when buyOutPrice is below startingBid and no reservePrice is set", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    const res = await POST(postReq({
      cardId: "card-1", startingBid: 50, buyOutPrice: 10, durationDays: 3,
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/buy-out/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows buyOutPrice equal to startingBid when no reservePrice is set", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    const dbAuction = makeDbAuction({ startingBid: 5000, buyOutPrice: 5000 });
    mockPrisma.auction.create.mockResolvedValue(dbAuction);
    const res = await POST(postReq({
      cardId: "card-1", startingBid: 50, buyOutPrice: 50, durationDays: 3,
    }));
    expect(res.status).toBe(201);
  });

  it("returns 404 when card does not exist", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(null);
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(404);
  });

  it("returns 403 when card is owned by someone else", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, ownerId: "other-user" });
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(403);
  });

  it("returns 409 when card is already in auction", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, inAuction: true });
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already.*auction/i);
  });

  it("returns 409 when card is marked for in-person collection", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, collectionRequestId: "req-1" });
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/in-person collection/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 409 when card has a pending offer", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    mockPrisma.offer.findFirst.mockResolvedValue({ id: "offer-1" });

    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/pending offer/i);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    // The pending-offer guard must query by the renamed listingId field.
    expect(mockPrisma.offer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ listingId: "card-1" }) })
    );
  });

  it("returns 409 when card has an active Buy Now reservation", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue({
      ...LISTING,
      reservedById: "buyer-1",
      reservedUntil: new Date(Date.now() + 10 * 60_000),
    });

    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/reserved/i);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("allows auction creation when reservation has expired", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue({
      ...LISTING,
      reservedById: "buyer-1",
      reservedUntil: new Date(Date.now() - 10 * 60_000),
    });
    const dbAuction = makeDbAuction({ startingBid: 500 });
    mockPrisma.auction.create.mockResolvedValue(dbAuction);

    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(201);
  });

  it("accepts the 5-day maximum and ends the auction 5 days out", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    mockPrisma.auction.create.mockResolvedValue(makeDbAuction({ startingBid: 500 }));

    const before = Date.now();
    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 5 }));
    expect(res.status).toBe(201);
    const endsAt: Date = mockPrisma.auction.create.mock.calls.at(-1)![0].data.endsAt;
    const fiveDays = 5 * 24 * 60 * 60 * 1000;
    expect(endsAt.getTime()).toBeGreaterThanOrEqual(before + fiveDays);
    expect(endsAt.getTime()).toBeLessThanOrEqual(Date.now() + fiveDays);
  });

  it("creates auction and returns 201 with prices in dollars and cardId (not listingId)", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    const dbAuction = makeDbAuction({ startingBid: 500 }); // 500 cents = S$5.00
    mockPrisma.auction.create.mockResolvedValue(dbAuction);

    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.auction.startingBid).toBe(5);
    expect(body.auction.reservePrice).toBeNull();
    expect(body.auction.buyOutPrice).toBeNull();
    expect(body.auction.status).toBe("active");
    expect(body.auction.bidCount).toBe(0);
    expect(body.auction.cardId).toBe("card-1");
    expect(body.auction).not.toHaveProperty("listingId");

    // The auction is created against the renamed listingId column.
    expect(mockPrisma.auction.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ listingId: "card-1" }) })
    );
  });

  it("creates auction with reserve and buy-out prices", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    const dbAuction = makeDbAuction({
      startingBid:  500,
      reservePrice: 1000,
      buyOutPrice:  2000,
    });
    mockPrisma.auction.create.mockResolvedValue(dbAuction);

    const res = await POST(postReq({
      cardId: "card-1", startingBid: 5, reservePrice: 10, buyOutPrice: 20, durationDays: 3,
    }));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.auction.startingBid).toBe(5);
    expect(body.auction.reservePrice).toBe(10);
    expect(body.auction.buyOutPrice).toBe(20);
  });

  it("returns 409 when the conditional listing lock matches 0 rows", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    // A concurrent create / collection request / checkout won the race.
    mockPrisma.listing.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(postReq({ cardId: "card-1", startingBid: 5, durationDays: 3 }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/no longer available/i);

    expect(mockPrisma.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "card-1", ownerId: "seller-1", inAuction: false, collectionRequestId: null,
        }),
      })
    );
    expect(mockPrisma.auction.create).not.toHaveBeenCalled();
  });
});
