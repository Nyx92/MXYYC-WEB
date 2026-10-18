import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/auctions/[id]/decide — seller accepts or rejects the highest bid
 * during the pending_seller_decision window.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  auction: { findUnique: vi.fn() },
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockSettleAuction = vi.hoisted(() => vi.fn());
const mockExpireAuction = vi.hoisted(() => vi.fn());
const mockNotifyAsync = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/notifications", () => ({ notifyAsync: mockNotifyAsync }));
vi.mock("@/lib/auctionSettlement", () => ({
  settleAuction: mockSettleAuction,
  expireAuction: mockExpireAuction,
}));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { POST } from "@/app/api/auctions/[id]/decide/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function postReq(body: object) {
  return new NextRequest("http://localhost/api/auctions/auction-1/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PARAMS = { params: Promise.resolve({ id: "auction-1" }) };

const SELLER_SESSION = { user: { id: "seller-1" } };
const OTHER_SESSION = { user: { id: "not-seller" } };

const HIGHEST_BID = {
  id: "bid-1",
  paymentIntentId: "pi_1",
  bidderId: "buyer-1",
  amount: 1500,
};

const BASE_AUCTION = {
  id: "auction-1",
  sellerId: "seller-1",
  status: "pending_seller_decision",
  sellerDecisionDeadline: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
  bids: [HIGHEST_BID],
  listing: {
    id: "card-1",
    pokemonCard: {
      nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
      language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
    },
    riftboundCard: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExpireAuction.mockResolvedValue(true); // default: decline claim succeeds
  mockSettleAuction.mockResolvedValue(undefined);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/auctions/[id]/decide", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(401);
  });

  it("returns 400 for an invalid action", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    const res = await POST(postReq({ action: "maybe" }), PARAMS);
    expect(res.status).toBe(400);
  });

  it("returns 404 when auction is not found", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(null);
    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns 403 when caller is not the seller", async () => {
    mockGetServerSession.mockResolvedValue(OTHER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(403);
  });

  it("returns 409 when auction is not awaiting a seller decision", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({ ...BASE_AUCTION, status: "active" });
    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(409);
  });

  it("returns 409 when the decision window has expired", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({
      ...BASE_AUCTION,
      sellerDecisionDeadline: new Date(Date.now() - 1000),
    });
    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(409);
  });

  it("returns 409 when there are no bids on the auction", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue({ ...BASE_AUCTION, bids: [] });
    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(409);
  });

  it("accept — delegates to settleAuction and returns success", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);

    const res = await POST(postReq({ action: "accept" }), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockSettleAuction).toHaveBeenCalledWith("auction-1");
  });

  it("reject — cancels the winning PI, updates bid/auction/card, and notifies the bidder with the resolved title", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);

    const res = await POST(postReq({ action: "reject" }), PARAMS);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);

    // Bid cancel + PI release + auction expire + card release all go through
    // expireAuction's conditional claim — the route no longer cancels PIs itself.
    expect(mockExpireAuction).toHaveBeenCalledWith(
      "auction-1", "card-1", "pending_seller_decision"
    );
    expect(mockNotifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "buyer-1", type: "auction_expired",
        cardId: "card-1",
        title: expect.stringContaining("Charizard"),
      })
    );
    expect(mockSettleAuction).not.toHaveBeenCalled();
  });

  it("reject — returns 409 and does not notify when the decline claim fails", async () => {
    mockGetServerSession.mockResolvedValue(SELLER_SESSION);
    mockPrisma.auction.findUnique.mockResolvedValue(BASE_AUCTION);
    // A concurrent settlement / cron expiry already moved the auction on.
    mockExpireAuction.mockResolvedValue(false);

    const res = await POST(postReq({ action: "reject" }), PARAMS);
    expect(res.status).toBe(409);

    expect(mockNotifyAsync).not.toHaveBeenCalled();
  });
});
