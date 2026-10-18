import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/auctions/[id]/bid — buyer places a binding bid.
 *
 * The auction's card reference is `listingId` (renamed from `cardId`); card
 * identity (title) for notification copy is resolved from whichever catalog
 * relation the linked listing points to.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockStripeInstance = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(),
    cancel:   vi.fn(),
  },
}));

const mockPrisma = vi.hoisted(() => ({
  auction: { findUnique: vi.fn() },
  bid:     { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  user:    { findUnique: vi.fn() }, // requireVerifiedForPurchase
  $transaction: vi.fn(),
}));

const mockGetServerSession  = vi.hoisted(() => vi.fn());
const mockSettleAuction     = vi.hoisted(() => vi.fn());
const mockCancelBidPI       = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("stripe",          () => ({ default: vi.fn(() => mockStripeInstance) }));
vi.mock("@/lib/prisma",    () => ({ prisma: mockPrisma }));
vi.mock("next-auth",       () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth",      () => ({ authOptions: {} }));
vi.mock("@/lib/notifications",      () => ({ notifyAsync: vi.fn() }));
vi.mock("@/lib/rateLimit",          () => ({ rateLimitResponse: vi.fn(() => null) }));
vi.mock("@/lib/auctionSettlement",  () => ({
  settleAuction: mockSettleAuction,
  cancelBidPI:   mockCancelBidPI,
}));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { POST } from "@/app/api/auctions/[id]/bid/route";
import { notifyAsync } from "@/lib/notifications";

// ── Helpers ───────────────────────────────────────────────────────────────────

function postReq(body: object) {
  return new NextRequest("http://localhost/api/auctions/auction-1/bid", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: "auction-1" }) };

const BUYER_SESSION  = { user: { id: "buyer-1" } };
const SELLER_SESSION = { user: { id: "seller-1" } };

// An active auction with no bids yet; all prices in cents.
const BASE_AUCTION = {
  id:              "auction-1",
  status:          "active",
  endsAt:          new Date(Date.now() + 10 * 60 * 60 * 1000), // 10 h from now
  sellerId:        "seller-1",
  version:         2,
  startingBid:     500,    // S$5.00
  currentBid:      null,
  highestBidderId: null,
  reservePrice:    null,
  buyOutPrice:     null,
  listing: {
    id: "card-1",
    pokemonCard: {
      nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
      language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
    },
    riftboundCard: null,
  },
};

// PI returned by stripe.paymentIntents.retrieve.
const PI_REQUIRES_CAPTURE = {
  status:   "requires_capture",
  metadata: { bidderId: "buyer-1", auctionId: "auction-1" },
};

// Simulates a successful $transaction: bumps the auction version and creates a bid.
function txSuccess() {
  mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => Promise<unknown>) => {
    const txClient = {
      auction: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      bid: {
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({ id: "bid-1" }),
      },
    };
    return cb(txClient as unknown as typeof mockPrisma);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ emailVerified: new Date(), phoneVerified: true });
  mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
  mockCancelBidPI.mockResolvedValue(undefined);
  mockSettleAuction.mockResolvedValue(undefined);
  // Default: the PI is not already attached to a Bid (reuse check passes)
  mockPrisma.bid.findFirst.mockResolvedValue(null);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/auctions/[id]/bid", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(401);
  });

  it("returns 400 when paymentIntentId is missing", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    const res = await POST(postReq({ amount: 10 }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 400 when amount is invalid", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 0 }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 403 when seller bids on own auction", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      ...PI_REQUIRES_CAPTURE, metadata: { bidderId: "seller-1", auctionId: "auction-1" },
    });
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("returns 400 when bid is below startingBid", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION); // startingBid = 500 cents
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(PI_REQUIRES_CAPTURE);
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 4 }), PARAMS);
    expect(res.status).toBe(400);
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("returns 400 when bid is not higher than currentBid", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({
      ...BASE_AUCTION, currentBid: 1000, highestBidderId: "other-buyer",
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(PI_REQUIRES_CAPTURE);
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(400);
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("returns 409 when PI is not in requires_capture state", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      ...PI_REQUIRES_CAPTURE,
      status: "requires_payment_method",
    });
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(409);
  });

  it("returns 409 without cancelling when the PI is already attached to a Bid", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(PI_REQUIRES_CAPTURE);
    mockPrisma.bid.findFirst.mockResolvedValueOnce({ id: "bid-existing" });

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(409);
    expect(mockPrisma.bid.findFirst).toHaveBeenCalledWith({
      where: { paymentIntentId: "pi_1" }, select: { id: true },
    });
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockCancelBidPI).not.toHaveBeenCalled();
  });

  it("returns 403 without cancelling when the PI has no bidderId (e.g. a buyer's offer PI)", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({ ...BASE_AUCTION, status: "ended" });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture", metadata: { buyerId: "victim", cardId: "card-9" }, amount: 1000,
    });
    const res = await POST(postReq({ paymentIntentId: "pi_victim", amount: 10 }), PARAMS);
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockSettleAuction).not.toHaveBeenCalled();
  });

  it("returns 403 when the PI was authorised for a different auction", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      ...PI_REQUIRES_CAPTURE, amount: 1000, metadata: { bidderId: "buyer-1", auctionId: "auction-2" },
    });
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("returns 403 when the bidder is not verified", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.user.findUnique.mockResolvedValue({ emailVerified: new Date(), phoneVerified: false });
    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("returns 409 on concurrent bid (optimistic lock miss)", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 1000 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);

    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => Promise<unknown>) => {
      const txClient = {
        auction: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        bid:     { update: vi.fn(), create: vi.fn() },
      };
      return cb(txClient as unknown as typeof mockPrisma);
    });

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/concurrent|higher bid/i);
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("does not cancel the hold when the lock was lost to a duplicate of the same request that already saved the bid", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 1000 });
    // Reuse check passes (the twin hasn't saved yet)…
    mockPrisma.bid.findFirst.mockResolvedValueOnce(null);
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: typeof mockPrisma) => Promise<unknown>) => {
      const txClient = {
        auction: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
        bid:     { update: vi.fn(), create: vi.fn() },
      };
      return cb(txClient as unknown as typeof mockPrisma);
    });
    // …but by the time this copy loses the lock, the twin's bid holds this PI.
    mockPrisma.bid.findFirst.mockResolvedValue({ id: "bid-twin" });

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(409);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("returns 409 without cancelling when the unique index rejects a duplicate PI", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 1000 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);
    mockPrisma.$transaction.mockRejectedValueOnce(Object.assign(new Error("Unique constraint"), { code: "P2002" }));

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(409);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("places bid successfully and sends notifications", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 1000 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);
    txSuccess();

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.settled).toBe(false);

    // Seller should receive bid_received notification with the resolved title
    // and cardId sourced from the listing (notifyAsync's own param stays cardId).
    expect(notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "seller-1", type: "bid_received",
        cardId: "card-1",
        title: expect.stringContaining("Charizard"),
      })
    );
  });

  it("cancels previous bidder PI and sends outbid notification", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({
      ...BASE_AUCTION, currentBid: 1000, highestBidderId: "other-buyer",
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 1500 });
    // 1st call: PI reuse check (none), 2nd call: previous highest bid
    mockPrisma.bid.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "prev-bid-1", paymentIntentId: "pi_prev", bidderId: "other-buyer" });
    txSuccess();

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 15 }), PARAMS);
    expect(res.status).toBe(200);

    expect(mockCancelBidPI).toHaveBeenCalledWith("pi_prev");

    expect(notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "other-buyer", type: "outbid" })
    );
  });

  it("settles immediately when bid >= buyOutPrice", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({
      ...BASE_AUCTION, buyOutPrice: 2000, // S$20 buy-out
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 2000 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);
    txSuccess();

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 20 }), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settled).toBe(true);
    expect(mockSettleAuction).toHaveBeenCalledWith("auction-1");
  });

  it("reports the bid as placed-but-unsettled (200) when instant settlement throws", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({ ...BASE_AUCTION, buyOutPrice: 2000 });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 2000 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);
    txSuccess();
    mockSettleAuction.mockRejectedValueOnce(new Error("capture declined"));

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 20 }), PARAMS);
    expect(res.status).toBe(200);
    expect((await res.json()).settled).toBe(false);
  });

  it("rejects a bid above the buy-out price", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({ ...BASE_AUCTION, buyOutPrice: 2000 });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 3000 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 30 }), PARAMS);
    expect(res.status).toBe(400);
    expect(mockSettleAuction).not.toHaveBeenCalled();
  });

  it("does NOT settle immediately when bid hits reservePrice — auction runs until endsAt", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({
      ...BASE_AUCTION, reservePrice: 1500, // S$15 reserve
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 1500 });
    mockPrisma.bid.findFirst.mockResolvedValue(null);
    txSuccess();

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 15 }), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settled).toBe(false);
    expect(mockSettleAuction).not.toHaveBeenCalled();
  });

  it("returns 400 and cancels the PI when its authorised amount doesn't match the claimed bid", async () => {
    mockGetServerSession.mockResolvedValue(BUYER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ ...PI_REQUIRES_CAPTURE, amount: 500 });

    const res = await POST(postReq({ paymentIntentId: "pi_1", amount: 10 }), PARAMS);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/does not match/i);
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
