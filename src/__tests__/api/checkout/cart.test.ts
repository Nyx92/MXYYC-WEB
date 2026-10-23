import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Tests for POST /api/checkout/cart.
 *
 * The route:
 *   1. Authenticates the user
 *   2. Fetches selected cart items (listing ids only) + fresh listing data
 *   3. Validates listings (for sale, not own, price > 0)
 *   4. Atomically reserves all listings and creates Orders
 *   5. Creates a Stripe Checkout Session with all items as line items
 *   6. Stamps Orders and Listings with the session ID
 *   7. Returns { url }
 */

// ── STEP 1: Create mock objects ───────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  cart: { findUnique: vi.fn() },
  listing: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  order: { create: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

const mockStripeCreate = vi.hoisted(() => vi.fn());
const mockStripe = vi.hoisted(() =>
  vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockStripeCreate } },
  }))
);

// ── STEP 2: Register fakes ────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
const mockRateLimitResponse = vi.hoisted(() => vi.fn((): Response | null => null));
vi.mock("@/lib/rateLimit", () => ({ rateLimitResponse: mockRateLimitResponse }));
const mockCloseLapsedCheckouts = vi.hoisted(() => vi.fn(async (): Promise<string[]> => []));
vi.mock("@/lib/checkoutSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/checkoutSessions")>()),
  closeLapsedCheckouts: mockCloseLapsedCheckouts,
}));
vi.mock("stripe", () => ({ default: mockStripe }));

// ── STEP 3: Import code under test ────────────────────────────────────────────

import { POST } from "@/app/api/checkout/cart/route";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SESSION = { user: { id: "buyer-1" } };

const LISTING = {
  id: "card-1",
  price: 1000,          // 1000 cents = S$10.00
  forSale: true,
  ownerId: "seller-1",
  imageUrls: ["https://example.com/charizard.jpg"],
  pokemonCard: {
    nameEn: "Charizard",
    rarity: "Rare",
    setNameEn: "Base Set",
    language: "English",
    localId: "4",
    tcgPlayerId: "tcg-1",
  },
  riftboundCard: null,
};

const CART_ITEM = {
  id: "cartitem-1",
  listingId: "card-1",
  selected: true,
};

const CART = {
  id: "cart-1",
  userId: "buyer-1",
  items: [CART_ITEM],
};

function makeRequest() {
  return new NextRequest("http://localhost/api/checkout/cart", { method: "POST" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/checkout/cart", () => {
  it("returns 429 when the per-user checkout rate limit is exceeded", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });
    mockRateLimitResponse.mockReturnValueOnce(new Response(null, { status: 429 }));
    const res = await POST(makeRequest());
    expect(res.status).toBe(429);
    expect(mockRateLimitResponse).toHaveBeenCalledWith("checkout:buyer-1", expect.any(Object), expect.any(String));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(SESSION);
    // Verified buyer by default — see the dedicated "purchase verification
    // gate" tests below for the unverified-buyer cases.
    mockPrisma.user.findUnique.mockResolvedValue({
      id: SESSION.user.id,
      emailVerified: new Date(),
      phoneVerified: true,
    });
  });

  // What's being tested: auth gate
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
  });

  // What's being tested: empty cart / no selected items
  it("returns 400 when cart has no selected items", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce({ id: "cart-1", items: [] });
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no selected items/i);
  });

  // What's being tested: cart not found returns same 400
  it("returns 400 when cart does not exist", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(null);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
  });

  // What's being tested: listing no longer for sale is rejected with 409
  it("returns 409 when a listing is no longer for sale", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([{ ...LISTING, forSale: false }]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no longer for sale");
  });

  // What's being tested: buyer trying to purchase their own listing is blocked
  it("returns 400 when buyer tries to buy their own card", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([{ ...LISTING, ownerId: "buyer-1" }]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/own card/i);
  });

  // What's being tested: listing with no price is rejected
  it("returns 400 when a listing has no price", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([{ ...LISTING, price: null }]);
    const res = await POST(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no valid price/i);
  });

  // What's being tested: reservation conflict returns a generic 500 — the
  // route logs the specific reason server-side but never echoes err.message
  // to the client (that message text is safe here, but the route can't tell
  // a deliberately-thrown business error from a leaky Prisma/Stripe one, so
  // it treats every caught error the same way).
  it("returns a generic 500 when a listing is already reserved by another buyer", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);

    mockPrisma.$transaction.mockRejectedValueOnce(
      new Error('"Charizard" was just reserved by another buyer. Please try again.')
    );

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to create checkout session. Please try again.");
  });

  it("returns 409 with our own message when a listing is held by another buyer", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);
    const { CardUnavailableError } = await import("@/lib/checkoutSessions");
    mockPrisma.$transaction.mockRejectedValueOnce(new CardUnavailableError("held"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("held");
  });

  it("returns 409 when a lapsed earlier checkout of a listing was in fact paid", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);
    mockCloseLapsedCheckouts.mockResolvedValueOnce([LISTING.id]);

    const res = await POST(makeRequest());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/was just sold/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // What's being tested: the reservation query's OR clause only allows
  // never-reserved or expired reservations (same guard as single-item
  // checkout — see Task 4).
  it("reservation query's OR clause only allows never-reserved or expired reservations", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);

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
          order: { create: vi.fn().mockResolvedValue({ id: "order-1" }) },
        };
        return fnOrOps(mockTx);
      }
      return Promise.all(fnOrOps);
    });

    await POST(makeRequest());

    expect(capturedWhere.OR).toEqual([
      { reservedUntil: null },
      { reservedUntil: { lt: expect.any(Date) } },
    ]);
  });

  // What's being tested: the reservation window matches single-item Buy Now
  // checkout (15 minutes), not the previous 1-minute window this route used.
  // A buyer filling out a multi-item Stripe checkout page needs at least as
  // much time as a single-item buyer — there's no reason cart checkout should
  // give them less, and the mismatch let a slow-but-legitimate cart buyer's
  // reservation expire mid-payment, handing the item to another buyer and
  // triggering a spurious auto-refund on the person who actually paid.
  it("reserves listings for 15 minutes, matching single-item checkout", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);

    let capturedReservedUntil: Date | undefined;
    const before = Date.now();
    mockPrisma.$transaction.mockImplementation(async (fnOrOps) => {
      if (typeof fnOrOps === "function") {
        const mockTx = {
          listing: {
            updateMany: vi.fn().mockImplementation((args) => {
              capturedReservedUntil = args.data.reservedUntil;
              return Promise.resolve({ count: 1 });
            }),
          },
          order: { create: vi.fn().mockResolvedValue({ id: "order-1" }) },
        };
        return fnOrOps(mockTx);
      }
      return Promise.all(fnOrOps);
    });

    await POST(makeRequest());
    const after = Date.now();

    expect(capturedReservedUntil).toBeInstanceOf(Date);
    const windowMs = capturedReservedUntil!.getTime() - before;
    // Allow slack for test execution time either side of the 15-minute mark.
    expect(windowMs).toBeGreaterThan(14 * 60_000);
    expect(windowMs).toBeLessThanOrEqual(15 * 60_000 + (after - before));
  });

  // What's being tested: happy path — session created, url returned, and
  // the order is created against the renamed listingId column.
  it("creates orders, creates stripe session, returns url", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);

    let capturedOrderData: any;
    mockPrisma.$transaction.mockImplementationOnce(async (fnOrOps) => {
      const mockTx = {
        listing: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
        order: {
          create: vi.fn().mockImplementation((args) => {
            capturedOrderData = args.data;
            return Promise.resolve({ id: "order-1" });
          }),
        },
      };
      return (fnOrOps as any)(mockTx);
    });
    mockPrisma.$transaction.mockImplementationOnce(async (ops) => Promise.all(ops as any));

    mockStripeCreate.mockResolvedValueOnce({ id: "cs_test_abc", url: "https://checkout.stripe.com/pay/cs_test_abc" });

    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.com/pay/cs_test_abc");
    expect(capturedOrderData).toMatchObject({ listingId: "card-1", sellerId: "seller-1" });

    // Stripe session should be created with correct metadata and resolved title
    expect(mockStripeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ checkoutType: "cart", buyerId: "buyer-1" }),
        cancel_url: expect.stringContaining("/checkout/cancel?from=cart"),
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              product_data: expect.objectContaining({ name: "Charizard" }),
            }),
          }),
        ],
      })
    );
  });

  // What's being tested: Stripe error surfaces as 500 with message
  it("returns 500 when Stripe session creation fails", async () => {
    mockPrisma.cart.findUnique.mockResolvedValueOnce(CART);
    mockPrisma.listing.findMany.mockResolvedValueOnce([LISTING]);
    mockPrisma.$transaction.mockResolvedValueOnce([
      { orderId: "order-1", listingId: "card-1", sellerId: "seller-1", amount: 1000 },
    ]);
    mockStripeCreate.mockRejectedValueOnce(new Error("Stripe unavailable"));

    const res = await POST(makeRequest());
    expect(res.status).toBe(500);
  });

  describe("purchase verification gate", () => {
    it("returns 403 when the buyer hasn't verified their email or phone", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: SESSION.user.id,
        emailVerified: null,
        phoneVerified: false,
      });

      const res = await POST(makeRequest());
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: expect.stringMatching(/verify your email and phone/i),
      });
      expect(mockPrisma.cart.findUnique).not.toHaveBeenCalled();
    });
  });
});
