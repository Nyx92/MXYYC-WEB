import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * settleAuction — the core money-movement function for auctions: captures
 * the winning bid's PaymentIntent, then atomically creates the sale records
 * and transfers listing ownership. If the DB transaction fails after capture,
 * it issues a compensating Stripe refund (mirrors the webhook's
 * issueRefundOnTransferFailure and the offer-accept route's same pattern).
 *
 * cancelBidPI — a small fire-and-forget PI-cancel helper shared by the bid
 * route and expireAuction.
 *
 * expireAuction — conditional claim (fromStatus → expired) that cancels every
 * active bid, releases the card, and then releases those bids' PI holds.
 */

const mockStripeInstance = vi.hoisted(() => ({
  paymentIntents: { capture: vi.fn(), cancel: vi.fn(), retrieve: vi.fn() },
  refunds: { create: vi.fn() },
}));

const mockTx = vi.hoisted(() => ({
  order: { create: vi.fn() },
  cardTransaction: { create: vi.fn() },
  bid: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  listing: { updateMany: vi.fn(), update: vi.fn() }, // update: expireAuction's card release
  auction: { updateMany: vi.fn() },
}));

const mockPrisma = vi.hoisted(() => ({
  auction: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

const mockNotifyAsync = vi.hoisted(() => vi.fn());

vi.mock("stripe", () => ({ default: vi.fn(() => mockStripeInstance) }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/notifications", () => ({ notifyAsync: mockNotifyAsync }));

import { settleAuction, cancelBidPI, expireAuction } from "@/lib/auctionSettlement";

const WINNING_BID = { id: "bid-1", paymentIntentId: "pi_win", bidderId: "buyer-1", amount: 1500, status: "active" };
const LOSING_BID  = { id: "bid-2", paymentIntentId: "pi_lose", bidderId: "buyer-2" };

function makeAuction(overrides = {}) {
  return {
    id: "auction-1",
    listingId: "card-1",
    sellerId: "seller-1",
    status: "active",
    bids: [WINNING_BID],
    listing: {
      id: "card-1",
      pokemonCard: {
        nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
        language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
      },
      riftboundCard: null,
    },
    ...overrides,
  };
}

describe("settleAuction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStripeInstance.paymentIntents.capture.mockResolvedValue({ id: "pi_win", status: "succeeded" });
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
    mockStripeInstance.refunds.create.mockResolvedValue({ id: "re_1" });
    mockPrisma.auction.findUnique.mockResolvedValue(makeAuction());
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
    mockTx.order.create.mockResolvedValue({ id: "order-1" });
    mockTx.cardTransaction.create.mockResolvedValue({});
    mockTx.bid.update.mockResolvedValue({});
    mockTx.bid.updateMany.mockResolvedValue({ count: 0 });
    mockTx.bid.findMany.mockResolvedValue([]); // no losing bids by default
    mockTx.auction.updateMany.mockResolvedValue({ count: 1 }); // claim succeeds
    mockTx.listing.updateMany.mockResolvedValue({ count: 1 }); // seller still owns it
  });

  it("records the sale when a failed capture call had actually captured the PI", async () => {
    mockStripeInstance.paymentIntents.capture.mockRejectedValueOnce(new Error("timeout"));
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_win", status: "succeeded" });
    await settleAuction("auction-1");
    expect(mockTx.order.create).toHaveBeenCalled();
  });

  it("expires the auction instead of retrying forever when the hold was cancelled (lapsed)", async () => {
    mockStripeInstance.paymentIntents.capture.mockRejectedValueOnce(new Error("pi canceled"));
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValueOnce({ id: "pi_win", status: "canceled" });
    await expect(settleAuction("auction-1")).rejects.toThrow();
    expect(mockTx.auction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "expired" } })
    );
    expect(mockTx.order.create).not.toHaveBeenCalled();
  });

  it("returns immediately (idempotent) when the auction is already sold", async () => {
    mockPrisma.auction.findUnique.mockResolvedValue(makeAuction({ status: "sold" }));
    await settleAuction("auction-1");
    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("throws when the auction does not exist", async () => {
    mockPrisma.auction.findUnique.mockResolvedValue(null);
    await expect(settleAuction("auction-x")).rejects.toThrow(/not found/);
  });

  it("throws when there is no active bid", async () => {
    mockPrisma.auction.findUnique.mockResolvedValue(makeAuction({ bids: [] }));
    await expect(settleAuction("auction-1")).rejects.toThrow(/No active bid/);
    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("captures the winning PI, creates the sale records against the renamed listingId column, and transfers ownership", async () => {
    await settleAuction("auction-1");

    expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith("pi_win");

    expect(mockTx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          listingId: "card-1", sellerId: "seller-1", buyerId: "buyer-1",
          amount: 1500, currency: "sgd", status: "PAID", stripePaymentIntentId: "pi_win",
        }),
      })
    );

    expect(mockTx.cardTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-1", listingId: "card-1", sellerId: "seller-1", buyerId: "buyer-1",
          amount: 1500, currency: "sgd", stripeEventId: "pi_win",
          tcgPlayerId: "tcg-1",
        }),
      })
    );

    expect(mockTx.bid.update).toHaveBeenCalledWith({ where: { id: "bid-1" }, data: { status: "won" } });

    // The auction is claimed conditionally (open → sold) before anything else.
    expect(mockTx.auction.updateMany).toHaveBeenCalledWith({
      where: { id: "auction-1", status: { in: ["active", "pending_seller_decision"] } },
      data: { status: "sold", currentBid: 1500, highestBidderId: "buyer-1" },
    });

    // Ownership only transfers away from the seller.
    expect(mockTx.listing.updateMany).toHaveBeenCalledWith({
      where: { id: "card-1", ownerId: "seller-1" },
      data: { ownerId: "buyer-1", inAuction: false, forSale: false },
    });
  });

  it("cancels losing bidders' PIs and notifies them, using the renamed listingId as notifyAsync's cardId", async () => {
    mockTx.bid.findMany.mockResolvedValue([LOSING_BID]);

    await settleAuction("auction-1");

    expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith("pi_win"); // sanity

    // cancelBidPI is a same-module function reference (not imported/mockable), so the
    // observable proof of "the losing bid's PI was cancelled" is the underlying Stripe
    // call it makes, not a spy on cancelBidPI itself.
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_lose");

    // The losing bid must also be marked cancelled in the DB transaction.
    expect(mockTx.bid.updateMany).toHaveBeenCalledWith({
      where: { auctionId: "auction-1", status: "active", id: { not: "bid-1" } },
      data: { status: "cancelled" },
    });

    expect(mockNotifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "buyer-2", type: "auction_expired", cardId: "card-1" })
    );
  });

  it("stores tcgPlayerId as undefined (not empty string) when the listing's catalog has none", async () => {
    mockPrisma.auction.findUnique.mockResolvedValue(makeAuction({
      listing: {
        id: "card-1",
        pokemonCard: null,
        riftboundCard: {
          name: "Vi - Peacekeeper", rarity: "Rare", setLabel: "Unleashed",
          collectorNumber: "176", tcgPlayerId: null,
        },
      },
    }));

    await settleAuction("auction-1");

    expect(mockTx.cardTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tcgPlayerId: undefined }),
      })
    );
  });

  it("notifies the winner and seller with the resolved card title", async () => {
    await settleAuction("auction-1");

    expect(mockNotifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "buyer-1", type: "auction_won", cardId: "card-1",
        title: expect.stringContaining("Charizard"),
      })
    );
    expect(mockNotifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "seller-1", type: "auction_sold", cardId: "card-1",
        title: expect.stringContaining("Charizard"),
      })
    );
  });

  it("refunds the buyer if the DB transaction fails after PI capture", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("DB exploded"));

    await expect(settleAuction("auction-1")).rejects.toThrow("DB exploded");

    expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith("pi_win");
    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_win" });
  });

  it("refunds and throws when the auction claim matches 0 rows", async () => {
    // A concurrent settle / decline / expiry already moved the auction on.
    mockTx.auction.updateMany.mockResolvedValue({ count: 0 });

    await expect(settleAuction("auction-1")).rejects.toThrow(/no longer open/);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_win" });
    expect(mockTx.order.create).not.toHaveBeenCalled();
    expect(mockTx.listing.updateMany).not.toHaveBeenCalled();
  });

  it("refunds and throws when the listing transfer matches 0 rows (seller no longer owns it)", async () => {
    mockTx.listing.updateMany.mockResolvedValue({ count: 0 });

    await expect(settleAuction("auction-1")).rejects.toThrow(/no longer owned by the seller/);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_win" });
    expect(mockNotifyAsync).not.toHaveBeenCalled();
  });

  it("still throws the original error if the compensating refund itself fails", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("DB exploded"));
    mockStripeInstance.refunds.create.mockRejectedValue(new Error("refund also failed"));

    await expect(settleAuction("auction-1")).rejects.toThrow("DB exploded");
  });
});

describe("cancelBidPI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels the PI", async () => {
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
    cancelBidPI("pi_1");
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
  });

  it("swallows payment_intent_unexpected_state errors", async () => {
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue({ code: "payment_intent_unexpected_state" });
    expect(() => cancelBidPI("pi_1")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("expireAuction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
    mockTx.auction.updateMany.mockResolvedValue({ count: 1 });
    mockTx.bid.updateMany.mockResolvedValue({ count: 2 });
    mockTx.listing.update.mockResolvedValue({});
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
  });

  it("cancels ALL active bids and releases every PI hold", async () => {
    mockTx.bid.findMany.mockResolvedValue([{ paymentIntentId: "pi_a" }, { paymentIntentId: "pi_b" }]);

    const ok = await expireAuction("auction-1", "card-1", "pending_seller_decision");

    expect(ok).toBe(true);
    expect(mockTx.auction.updateMany).toHaveBeenCalledWith({
      where: { id: "auction-1", status: "pending_seller_decision" },
      data:  { status: "expired" },
    });
    expect(mockTx.bid.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { auctionId: "auction-1", status: "active" } })
    );
    expect(mockTx.bid.updateMany).toHaveBeenCalledWith({
      where: { auctionId: "auction-1", status: "active" },
      data:  { status: "cancelled" },
    });
    expect(mockTx.listing.update).toHaveBeenCalledWith({ where: { id: "card-1" }, data: { inAuction: false } });
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_a");
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_b");
  });

  it("returns false without touching bids, the card, or PIs when the claim matches 0 rows", async () => {
    mockTx.auction.updateMany.mockResolvedValue({ count: 0 });

    const ok = await expireAuction("auction-1", "card-1", "active");

    expect(ok).toBe(false);
    expect(mockTx.bid.findMany).not.toHaveBeenCalled();
    expect(mockTx.bid.updateMany).not.toHaveBeenCalled();
    expect(mockTx.listing.update).not.toHaveBeenCalled();
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });
});
