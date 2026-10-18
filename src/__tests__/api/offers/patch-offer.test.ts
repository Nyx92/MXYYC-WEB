import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * HOW THIS FILE EXECUTES (what Vitest does before a single test runs)
 *
 * 1. vi.hoisted() blocks run first — creates five mock objects in memory:
 *      mockStripeInstance   — fake Stripe client (paymentIntents.capture, cancel)
 *      mockTx               — fake Prisma transaction client (used inside $transaction)
 *      mockPrisma           — fake Prisma client (offer.findUnique, $transaction)
 *      mockGetServerSession — fake auth function
 *      mockExpireOffer      — fake expireOffer function (on-demand expiry guard)
 *
 * 2. vi.mock() factories run second — registers the fakes.
 *
 * 3. import { PATCH } runs last — the real handler is loaded with fakes in place.
 *
 * The Offer model's card reference is `listingId` (renamed from `cardId`);
 * the Card model itself is `Listing` (renamed). This route never returns an
 * offer object to the client (only { success: true }), so there's no
 * cardId/listingId wire-format concern here — only internal Prisma renames.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockStripeInstance = vi.hoisted(() => ({
  paymentIntents: {
    capture: vi.fn(), // accept: captures the held funds → actual charge
    cancel: vi.fn(),  // reject: releases the hold → no charge
  },
  refunds: {
    create: vi.fn(), // accept: compensating refund if the DB tx fails after capture
  },
}));

// mockTx is the fake Prisma client passed into the $transaction callback.
const mockTx = vi.hoisted(() => ({
  order: { create: vi.fn() },
  offer: { update: vi.fn(), updateMany: vi.fn() },
  listing: { updateMany: vi.fn() },
  cardTransaction: { create: vi.fn() },
}));

const mockPrisma = vi.hoisted(() => ({
  listing: { findUnique: vi.fn() }, // used by the Buy Now reservation guard (step 3)
  offer: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

const mockExpireOffer = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("stripe", () => ({ default: vi.fn(() => mockStripeInstance) }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/offerExpiry", () => ({ expireOffer: mockExpireOffer }));
vi.mock("@/lib/notifications", () => ({ notifyAsync: vi.fn(), createNotification: vi.fn() }));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { PATCH } from "@/app/api/offers/[id]/route";

// ── Test helpers + shared data ────────────────────────────────────────────────

function patchRequest(body: object) {
  return new NextRequest("http://localhost/api/offers/offer-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A valid pending offer: status is pending, not archived, not expired, has a PI
const PENDING_OFFER = {
  id: "offer-1",
  status: "pending",
  buyerId: "buyer-1",
  sellerId: "seller-1",
  paymentIntentId: "pi_123",
  price: 5000, // S$50.00 in cents
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h from now (not expired)
  archivedAt: null,
  listing: {
    id: "card-1", ownerId: "seller-1",
    pokemonCard: {
      nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
      language: "English", localId: "4/102", tcgPlayerId: "xy1-4",
    },
    riftboundCard: null,
  },
};

const MOCK_ORDER = { id: "order-1" };

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /api/offers/[id] — ACCEPT
// ═════════════════════════════════════════════════════════════════════════════
describe("PATCH /api/offers/[id] — accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: "seller-1" } });
    mockPrisma.offer.findUnique.mockResolvedValue(PENDING_OFFER);
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 }); // pending → accepted claim
    mockPrisma.listing.findUnique.mockResolvedValue({ reservedById: null, reservedUntil: null, inAuction: false });
    mockStripeInstance.paymentIntents.capture.mockResolvedValue({
      id: "pi_123",
      status: "succeeded",
    });
    mockStripeInstance.refunds.create.mockResolvedValue({ id: "re_123" });

    mockPrisma.$transaction.mockImplementation(async (fn) => {
      mockTx.order.create.mockResolvedValue(MOCK_ORDER);
      mockTx.offer.update.mockResolvedValue({});
      mockTx.offer.updateMany.mockResolvedValue({ count: 1 });
      mockTx.listing.updateMany.mockResolvedValue({ count: 1 });
      mockTx.cardTransaction.create.mockResolvedValue({});
      return fn(mockTx);
    });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("captures PI, creates order (PAID), archives all offers, transfers card, creates transaction record", async () => {
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    // 1. Stripe PI captured — funds move from hold to actual charge
    expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith("pi_123");

    // 2. Order created with PAID status and all sale details, against the
    //    renamed listingId column.
    expect(mockTx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          listingId: "card-1",
          sellerId: "seller-1",
          buyerId: "buyer-1",
          amount: 5000,
          status: "PAID",
          stripePaymentIntentId: "pi_123",
        }),
      })
    );

    // 3. Offer marked paid and linked to the order (for transaction history)
    expect(mockTx.offer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "offer-1" },
        data: expect.objectContaining({ status: "paid", orderId: "order-1" }),
      })
    );

    // 4. ALL offers on the listing archived
    expect(mockTx.offer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { listingId: "card-1", archivedAt: null },
        data: { archivedAt: expect.any(Date), expiresAt: expect.any(Date) },
      })
    );

    // 5. Card ownership transferred: buyer becomes the new owner, card unlisted
    expect(mockTx.listing.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "card-1", ownerId: "seller-1", inAuction: false, collectionRequestId: null }),
        data: expect.objectContaining({
          ownerId: "buyer-1",
          forSale: false,
          price: null,
          reservedById: null,
          reservedUntil: null,
          reservedCheckoutSessionId: null,
        }),
      })
    );

    // 6. CardTransaction audit record created against the renamed listingId
    //    column, with tcgPlayerId resolved from the listing's catalog relation
    //    (no longer a flat column, and no longer a second nested query).
    expect(mockTx.cardTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: "order-1",
          listingId: "card-1",
          sellerId: "seller-1",
          buyerId: "buyer-1",
          amount: 5000,
          currency: "sgd",
          stripeEventId: "pi_123",
          tcgPlayerId: "xy1-4",
        }),
      })
    );
  });

  // ── Refund safety net ─────────────────────────────────────────────────────

  it("returns 409 without capturing when a concurrent accept already claimed the offer", async () => {
    mockPrisma.offer.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("refunds and returns 409 when the card was transferred by a concurrent sale", async () => {
    mockPrisma.$transaction.mockImplementationOnce(async (fn) => {
      mockTx.listing.updateMany.mockResolvedValue({ count: 0 });
      return fn(mockTx);
    });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_123" });
    expect(mockTx.order.create).not.toHaveBeenCalled();
  });

  it("returns 403 when the current owner is not the seller the offer was made to", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "auction-winner" } });
    mockPrisma.offer.findUnique.mockResolvedValue({
      ...PENDING_OFFER, listing: { ...PENDING_OFFER.listing, ownerId: "auction-winner" },
    });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });

  it("refunds the buyer if the DB transaction fails after PI capture", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("DB exploded"));

    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });

    expect(res.status).toBe(500);
    expect(mockStripeInstance.paymentIntents.capture).toHaveBeenCalledWith("pi_123");
    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_123" });
  });

  it("still returns 500 (not a crash) if the compensating refund itself fails", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("DB exploded"));
    mockStripeInstance.refunds.create.mockRejectedValue(new Error("refund also failed"));

    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });

    expect(res.status).toBe(500);
    expect(mockStripeInstance.refunds.create).toHaveBeenCalled();
  });

  // ── Auth / ownership ──────────────────────────────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 when a non-owner tries to accept", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 when offer does not exist", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue(null);
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-x" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 when action is not accept or reject", async () => {
    const res = await PATCH(patchRequest({ action: "delete" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(400);
  });

  // ── Terminal states ───────────────────────────────────────────────────────

  it("returns 409 when offer is archived (already sold)", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue({ ...PENDING_OFFER, archivedAt: new Date() });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Offer is archived" });
  });

  it("returns 409 when offer is already rejected (not pending)", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue({ ...PENDING_OFFER, status: "rejected" });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Offer is not pending" });
  });

  it("returns 409 when offer is already paid", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue({ ...PENDING_OFFER, status: "paid" });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
  });

  it("returns 409 when offer has no paymentIntentId", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue({ ...PENDING_OFFER, paymentIntentId: null });
    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "No payment intent found for this offer" });
  });

  // ── Buy Now reservation guard ─────────────────────────────────────────────

  it("returns 409 when card is actively reserved by a Buy Now checkout", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({
      reservedById: "other-buyer",
      reservedUntil: new Date(Date.now() + 60_000),
    });

    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Card is currently reserved by a pending checkout" });

    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });

  // ── Auction guard ──────────────────────────────────────────────────────────

  it("returns 409 when the card is currently in an active auction", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({
      reservedById: null,
      reservedUntil: null,
      inAuction: true,
    });

    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Card is currently in an active auction" });

    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });

  // ── On-demand expiry guard ─────────────────────────────────────────────────

  it("expires the offer immediately if expiresAt is in the past (cron hasn't run yet)", async () => {
    mockPrisma.offer.findUnique.mockResolvedValue({
      ...PENDING_OFFER,
      expiresAt: new Date(Date.now() - 60_000),
    });
    mockExpireOffer.mockResolvedValue(undefined);

    const res = await PATCH(patchRequest({ action: "accept" }), { params: Promise.resolve({ id: "offer-1" }) });
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.error).toBe("This offer has expired");

    expect(mockExpireOffer).toHaveBeenCalledWith({
      id: "offer-1",
      paymentIntentId: "pi_123",
    });

    expect(mockStripeInstance.paymentIntents.capture).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH /api/offers/[id] — REJECT
// ═════════════════════════════════════════════════════════════════════════════
describe("PATCH /api/offers/[id] — reject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: "seller-1" } });
    mockPrisma.offer.findUnique.mockResolvedValue(PENDING_OFFER);
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });
  });

  it("cancels the PI and marks the offer rejected", async () => {
    const res = await PATCH(patchRequest({ action: "reject" }), { params: Promise.resolve({ id: "offer-1" }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);

    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_123");

    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer-1", status: "pending", archivedAt: null, paymentIntentId: "pi_123" },
      data: { status: "rejected" },
    });
  });

  it("returns 409 and does not cancel the PI when a concurrent accept already claimed the offer", async () => {
    mockPrisma.offer.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await PATCH(patchRequest({ action: "reject" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(res.status).toBe(409);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("binds the reject claim to the PI that was read (an amend in between misses → 409)", async () => {
    await PATCH(patchRequest({ action: "reject" }), { params: Promise.resolve({ id: "offer-1" }) });
    expect(mockPrisma.offer.updateMany.mock.calls[0][0].where).toMatchObject({ paymentIntentId: "pi_123" });
  });

  it("still marks offer rejected even if PI cancel fails (PI may already be cancelled)", async () => {
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(new Error("already cancelled"));

    const res = await PATCH(patchRequest({ action: "reject" }), { params: Promise.resolve({ id: "offer-1" }) });

    expect(res.status).toBe(200);
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer-1", status: "pending", archivedAt: null, paymentIntentId: "pi_123" },
      data: { status: "rejected" },
    });
  });
});
