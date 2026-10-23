import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Tests for POST /api/checkout (single-item Buy Now).
 *
 * See the module-level comment in the original version of this file for the
 * full walkthrough of vi.hoisted()/vi.mock() execution order — unchanged
 * here, only the mocked Prisma model (card → listing) and the fixture shape
 * (flat title → catalog relation) are updated.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockStripeInstance = vi.hoisted(() => ({
  checkout: {
    sessions: { create: vi.fn() },
  },
}));

const mockPrisma = vi.hoisted(() => ({
  listing: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  order: {
    create: vi.fn(),
    update: vi.fn(),
  },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("stripe", () => ({ default: vi.fn(() => mockStripeInstance) }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
const mockReleaseCheckoutReservation = vi.hoisted(() => vi.fn());
vi.mock("@/lib/webhookHelpers", () => ({ releaseCheckoutReservation: mockReleaseCheckoutReservation }));
const mockRateLimitResponse = vi.hoisted(() => vi.fn((): Response | null => null));
vi.mock("@/lib/rateLimit", () => ({ rateLimitResponse: mockRateLimitResponse }));
const mockCloseLapsedCheckouts = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
vi.mock("@/lib/checkoutSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/checkoutSessions")>()),
  closeLapsedCheckouts: mockCloseLapsedCheckouts,
}));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { POST } from "@/app/api/checkout/route";

// ── Test helpers + shared data ────────────────────────────────────────────────

function makeRequest(body: object) {
  return new NextRequest("http://localhost/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Shared test data — reused across tests. Spread and override individual
// fields to simulate different listing states (e.g. { ...LISTING, forSale: false })
const LISTING = {
  id: "card-1",
  price: 5000, // S$50.00 in cents — matches how prices are stored in the DB
  forSale: true,
  ownerId: "seller-1",
  imageUrls: ["https://example.com/img.png"],
  pokemonCard: {
    nameEn: "Charizard Base Set",
    rarity: "Rare Holo",
    setNameEn: "Base Set",
    language: "English",
    localId: "004",
    tcgPlayerId: "tcg-1",
  },
  riftboundCard: null,
};

const MOCK_ORDER = { id: "order-1" };
const MOCK_SESSION = {
  id: "cs_test_123",
  url: "https://checkout.stripe.com/pay/cs_test_123",
};

describe("POST /api/checkout", () => {
  it("returns 429 when the per-user checkout rate limit is exceeded", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });
    mockRateLimitResponse.mockReturnValueOnce(new Response(null, { status: 429 }));
    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(429);
    expect(mockRateLimitResponse).toHaveBeenCalledWith("checkout:buyer-1", expect.any(Object), expect.any(String));
  });

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated buyer
    mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });

    // Default: listing found and for sale
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);

    // Default: buyer exists. The route's transaction callback calls
    // prisma.user.findUnique (module-level client, not tx) to double-check
    // the authenticated buyer is a real DB user before reserving the listing.
    // Verified buyer by default — see the dedicated "purchase verification
    // gate" tests below for the unverified-buyer cases.
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "buyer-1",
      emailVerified: new Date(),
      phoneVerified: true,
    });

    // Default: $transaction calls the callback (interactive form) or resolves array
    mockPrisma.$transaction.mockImplementation(async (fnOrOps) => {
      if (typeof fnOrOps === "function") {
        const mockTx = {
          listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          order: { create: vi.fn().mockResolvedValue(MOCK_ORDER) },
          user: { findUnique: vi.fn().mockResolvedValue({ id: "buyer-1" }) },
        };
        return fnOrOps(mockTx);
      }
      // Sequential array form (updating order + listing with session id)
      return Promise.all(fnOrOps);
    });

    // Default: Stripe checkout session created
    mockStripeInstance.checkout.sessions.create.mockResolvedValue(MOCK_SESSION);

    // Default: order + listing updated with session id
    mockPrisma.order.update.mockResolvedValue({});
    mockPrisma.listing.update.mockResolvedValue({});
  });

  // ── Auth ────────────────────────────────────────────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);

    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "Not authenticated" });
  });

  // ── Card validation ─────────────────────────────────────────────────────────

  it("returns 404 when card does not exist", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue(null);

    const res = await POST(makeRequest({ cardId: "card-x" }));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Card not found" });
  });

  it("returns 409 when card is not for sale", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, forSale: false });

    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "Card is not for sale" });
  });

  it("returns 403 when buyer tries to buy their own card", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: LISTING.ownerId } });

    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "You cannot buy your own card" });
    expect(mockStripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("returns 400 when card has no price", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, price: null });

    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Card has invalid price" });
  });

  it("returns 400 when card price is zero", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, price: 0 });

    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(400);
  });

  // ── Race condition (card snatched by another buyer) ─────────────────────────

  it("releases the reservation and PENDING order when Stripe session creation fails", async () => {
    mockStripeInstance.checkout.sessions.create.mockRejectedValueOnce(new Error("Stripe down"));
    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(500);
    expect(mockReleaseCheckoutReservation).toHaveBeenCalledWith("buyer-1", [expect.any(String)], ["card-1"]);
  });

  it("returns 409 when a lapsed earlier checkout of the card was in fact paid", async () => {
    mockCloseLapsedCheckouts.mockResolvedValueOnce(["card-1"]);
    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This card was just sold.");
    expect(mockCloseLapsedCheckouts).toHaveBeenCalledWith(["card-1"]);
    expect(mockStripeInstance.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("returns 409 with a buyer-facing message when the card was just reserved by another buyer", async () => {
    mockPrisma.$transaction.mockImplementation(async (fnOrOps) => {
      if (typeof fnOrOps === "function") {
        const mockTx = {
          listing: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, // race lost
          order: { create: vi.fn() },
          user: { findUnique: vi.fn().mockResolvedValue({ id: "buyer-1" }) },
        };
        return fnOrOps(mockTx);
      }
      return Promise.all(fnOrOps);
    });

    const res = await POST(makeRequest({ cardId: "card-1" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Another buyer is checking out this card/);
  });

  it("reservation query's OR clause only allows never-reserved or expired reservations", async () => {
    let capturedWhere: any;
    mockPrisma.$transaction.mockImplementation(async (fnOrOps) => {
      if (typeof fnOrOps === "function") {
        const mockTx = {
          listing: {
            updateMany: vi.fn().mockImplementation((args) => {
              capturedWhere = args.where;
              return Promise.resolve({ count: 1 });
            }),
          },
          order: { create: vi.fn().mockResolvedValue(MOCK_ORDER) },
          user: { findUnique: vi.fn().mockResolvedValue({ id: "buyer-1" }) },
        };
        return fnOrOps(mockTx);
      }
      return Promise.all(fnOrOps);
    });

    await POST(makeRequest({ cardId: "card-1" }));

    expect(capturedWhere.OR).toEqual([
      { reservedUntil: null },
      { reservedUntil: { lt: expect.any(Date) } },
    ]);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("reserves listing, creates order, creates Stripe session, returns checkout URL", async () => {
    let capturedOrderData: any;
    mockPrisma.$transaction.mockImplementationOnce(async (fnOrOps) => {
      const mockTx = {
        listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        order: {
          create: vi.fn().mockImplementation((args) => {
            capturedOrderData = args.data;
            return Promise.resolve(MOCK_ORDER);
          }),
        },
        user: { findUnique: vi.fn().mockResolvedValue({ id: "buyer-1" }) },
      };
      return (fnOrOps as any)(mockTx);
    });
    mockPrisma.$transaction.mockImplementationOnce(async (ops) => Promise.all(ops as any));

    const res = await POST(makeRequest({ cardId: "card-1" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.url).toBe(MOCK_SESSION.url);

    // The Order is created against the renamed listingId column, keyed off
    // the request body's cardId value.
    expect(capturedOrderData).toMatchObject({ listingId: "card-1", sellerId: LISTING.ownerId });

    // Stripe checkout session created with correct amount, currency, and the
    // resolved title (from the catalog relation, not a flat column)
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "sgd",
              unit_amount: LISTING.price,
              product_data: expect.objectContaining({ name: "Charizard Base Set" }),
            }),
            quantity: 1,
          }),
        ],
        metadata: expect.objectContaining({
          cardId: "card-1",
          buyerId: "buyer-1",
          sellerId: LISTING.ownerId,
        }),
      })
    );
  });

  describe("purchase verification gate", () => {
    it("returns 403 when the buyer hasn't verified their email", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "buyer-1",
        emailVerified: null,
        phoneVerified: true,
      });

      const res = await POST(makeRequest({ cardId: "card-1" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: expect.stringMatching(/verify your email and phone/i),
      });
      expect(mockPrisma.listing.findUnique).not.toHaveBeenCalled();
    });

    it("returns 403 when the buyer hasn't verified their phone number", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "buyer-1",
        emailVerified: new Date(),
        phoneVerified: false,
      });

      const res = await POST(makeRequest({ cardId: "card-1" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: expect.stringMatching(/verify your email and phone/i),
      });
    });
  });
});
