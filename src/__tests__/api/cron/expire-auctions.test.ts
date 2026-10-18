import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GET /api/cron/expire-auctions — Vercel cron that closes ended auctions.
 *
 * Two passes per run:
 *
 * Pass 1 — Active auctions whose endsAt has passed:
 *   a) No bids     → expire immediately, notify seller
 *   b) bid >= RP   → settleAuction (auto-settle)
 *   c) bid < RP (or no RP) → pending_seller_decision + 24h deadline + notify seller
 *
 * Pass 2 — pending_seller_decision auctions whose deadline has passed:
 *   → expireAuction (conditional claim; cancels bids + PIs itself), notify bidder
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  auction: {
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));

const mockSettleAuction = vi.hoisted(() => vi.fn());
const mockExpireAuction = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("@/lib/prisma",   () => ({ prisma: mockPrisma }));
vi.mock("@/lib/notifications",     () => ({ notifyAsync: vi.fn() }));
vi.mock("@/lib/auctionSettlement", () => ({
  settleAuction: mockSettleAuction,
  expireAuction: mockExpireAuction,
}));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { GET } from "@/app/api/cron/expire-auctions/route";
import { notifyAsync } from "@/lib/notifications";

// ── Helpers ───────────────────────────────────────────────────────────────────

function cronReq(token?: string) {
  return new NextRequest("http://localhost/api/cron/expire-auctions", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const LISTING = {
  id: "card-1",
  pokemonCard: {
    nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
    language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
  },
  riftboundCard: null,
};

function makeAuction(overrides = {}) {
  return {
    id:          "auction-1",
    sellerId:    "seller-1",
    reservePrice: null,
    bids:        [],
    listing:     LISTING,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  mockSettleAuction.mockResolvedValue(undefined);
  // Default: no auctions to process in either pass
  mockPrisma.auction.findMany.mockResolvedValue([]);
  mockExpireAuction.mockResolvedValue(true); // default: expiry claim succeeds
  mockPrisma.auction.updateMany.mockResolvedValue({ count: 1 }); // default: 1c flip succeeds
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/cron/expire-auctions", () => {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  it("returns 401 with no token", async () => {
    const res = await GET(cronReq());
    expect(res.status).toBe(401);
  });

  it("returns 401 with wrong token", async () => {
    const res = await GET(cronReq("wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct token when nothing to process", async () => {
    const res = await GET(cronReq("cron-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settled).toBe(0);
    expect(body.expiredNoBids).toBe(0);
  });

  // ── Pass 1a: no bids → expire ─────────────────────────────────────────────
  it("Pass 1a: expires auction with no bids and notifies seller with the resolved title", async () => {
    const auction = makeAuction({ bids: [] });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([auction])
      .mockResolvedValueOnce([]);

    const res = await GET(cronReq("cron-secret"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.expiredNoBids).toBe(1);
    expect(body.settled).toBe(0);

    expect(mockExpireAuction).toHaveBeenCalledWith("auction-1", "card-1", "active");

    expect(notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "seller-1", type: "auction_expired",
        cardId: "card-1", title: expect.stringContaining("Charizard"),
      })
    );
  });

  // ── Pass 1b: bid >= reservePrice → auto-settle ───────────────────────────
  it("Pass 1b: settles auction when bid meets reservePrice", async () => {
    const auction = makeAuction({
      reservePrice: 1000, // S$10
      bids: [{ id: "bid-1", paymentIntentId: "pi_1", bidderId: "buyer-1", amount: 1000 }],
    });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([auction])
      .mockResolvedValueOnce([]);

    const res = await GET(cronReq("cron-secret"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.settled).toBe(1);
    expect(mockSettleAuction).toHaveBeenCalledWith("auction-1");
  });

  // ── Pass 1c: bid < reservePrice → pending_seller_decision ───────────────
  it("Pass 1c: moves to pending_seller_decision when bid is below reservePrice", async () => {
    const auction = makeAuction({
      reservePrice: 2000, // S$20
      bids: [{ id: "bid-1", paymentIntentId: "pi_1", bidderId: "buyer-1", amount: 1000 }],
    });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([auction])
      .mockResolvedValueOnce([]);

    const res = await GET(cronReq("cron-secret"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.pendingDecision).toBe(1);
    expect(mockSettleAuction).not.toHaveBeenCalled();

    expect(mockPrisma.auction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "auction-1", status: "active" },
        data:  expect.objectContaining({ status: "pending_seller_decision" }),
      })
    );

    expect(notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "seller-1", type: "auction_decision_needed", cardId: "card-1" })
    );
  });

  // ── Pass 1c: no reservePrice → also pending_seller_decision ──────────────
  it("Pass 1c: moves to pending_seller_decision when no reservePrice is set", async () => {
    const auction = makeAuction({
      reservePrice: null,
      bids: [{ id: "bid-1", paymentIntentId: "pi_1", bidderId: "buyer-1", amount: 1000 }],
    });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([auction])
      .mockResolvedValueOnce([]);

    const res = await GET(cronReq("cron-secret"));
    const body = await res.json();
    expect(body.pendingDecision).toBe(1);
    expect(mockSettleAuction).not.toHaveBeenCalled();
  });

  it("Pass 1c: skips the notification when the conditional flip matches 0 rows", async () => {
    const auction = makeAuction({
      reservePrice: 2000,
      bids: [{ id: "bid-1", paymentIntentId: "pi_1", bidderId: "buyer-1", amount: 1000 }],
    });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([auction])
      .mockResolvedValueOnce([]);
    // A buy-out settled concurrently — the auction is no longer "active".
    mockPrisma.auction.updateMany.mockResolvedValue({ count: 0 });

    const res = await GET(cronReq("cron-secret"));
    const body = await res.json();
    expect(body.pendingDecision).toBe(0);
    expect(notifyAsync).not.toHaveBeenCalled();
  });

  // ── Pass 2: decision timeout → expire ────────────────────────────────────
  it("Pass 2: cancels PI and expires auction when seller decision deadline passes", async () => {
    const auction = makeAuction({
      bids: [{ id: "bid-1", paymentIntentId: "pi_expired", bidderId: "buyer-1" }],
    });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([auction]);

    const res = await GET(cronReq("cron-secret"));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.expiredDecisionTimeout).toBe(1);

    expect(mockExpireAuction).toHaveBeenCalledWith(
      "auction-1", "card-1", "pending_seller_decision"
    );

    expect(notifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "buyer-1", type: "auction_expired", cardId: "card-1" })
    );
  });

  it("Pass 2: does not notify when the expiry claim fails", async () => {
    const auction = makeAuction({
      bids: [{ id: "bid-1", paymentIntentId: "pi_expired", bidderId: "buyer-1" }],
    });
    mockPrisma.auction.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([auction]);
    // The seller accepted (settled) concurrently — the claim loses.
    mockExpireAuction.mockResolvedValue(false);

    const res = await GET(cronReq("cron-secret"));
    const body = await res.json();
    expect(body.expiredDecisionTimeout).toBe(0);

    expect(notifyAsync).not.toHaveBeenCalled();
  });

  // ── Resilience ────────────────────────────────────────────────────────────
  it("continues processing after one failure and reports it in errors[]", async () => {
    const good = makeAuction({ id: "auction-good", bids: [] });
    const bad  = makeAuction({
      id:          "auction-bad",
      reservePrice: 500,
      bids: [{ id: "bid-1", paymentIntentId: "pi_1", bidderId: "buyer-1", amount: 500 }],
    });

    mockPrisma.auction.findMany
      .mockResolvedValueOnce([good, bad])
      .mockResolvedValueOnce([]);

    mockSettleAuction.mockRejectedValueOnce(new Error("Stripe timeout"));

    const res = await GET(cronReq("cron-secret"));
    const body = await res.json();

    expect(body.failed).toBe(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("auction-bad");
    expect(body.expiredNoBids).toBe(1);
  });
});
