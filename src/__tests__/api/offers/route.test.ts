import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * HOW THIS FILE EXECUTES (what Vitest does before a single test runs)
 *
 * 1. vi.hoisted() blocks run first — creates four mock objects in memory:
 *      mockStripeInstance   — fake Stripe client (paymentIntents.retrieve, cancel)
 *      mockPrisma           — fake Prisma client (listing, offer)
 *      mockGetServerSession — fake auth function
 *
 * 2. vi.mock() factories run second — registers the fakes so any module that
 *    imports these packages gets the fake version instead of the real one.
 *
 * 3. import { GET, POST } runs last — the real route is loaded with fakes in place.
 *
 * This file covers two endpoints on the same route file:
 *
 *   POST /api/offers — buyer submits an offer:
 *     a) New offer  → create a fresh offer row with a 24h expiry
 *     b) Amend offer → buyer already has a pending offer, update it in-place
 *        (cancel the old PI, issue a new one with the new price)
 *
 *   GET /api/offers — retrieve offers:
 *     a) ?cardId=&myOffer=true → buyer's own offer on a specific card
 *     b) ?cardId=              → all offers on a card (seller only)
 *     c) ?mine=true            → all of the buyer's offers across all cards
 *     d) ?received=true        → all offers received on the seller's cards (all lifecycle states)
 *
 * The Offer model's card reference is `listingId` (renamed from `cardId`), but
 * the request/response wire format still uses `cardId` — see serializeOffer()
 * in the route file for the translation.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockStripeInstance = vi.hoisted(() => ({
  paymentIntents: {
    retrieve: vi.fn(), // POST: validates PI is authorised before saving offer
    cancel: vi.fn(),   // POST: cancels old PI when buyer amends an existing offer
  },
}));

const mockPrisma = vi.hoisted(() => ({
  listing: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() }, // requireVerifiedForPurchase
  offer: {
    findFirst: vi.fn(),  // checks for an existing offer from this buyer
    findMany: vi.fn(),   // returns list of offers (GET)
    create: vi.fn(),     // new offer
    updateMany: vi.fn(), // amend existing offer (conditional PI swap)
    findUnique: vi.fn(), // who holds this PI after a lost swap — undefined = nobody
    findUniqueOrThrow: vi.fn(),
  },
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("stripe", () => ({ default: vi.fn(() => mockStripeInstance) }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
// Silence the Resend SDK — notification side-effects are tested separately.
vi.mock("@/lib/notifications", () => ({ notifyAsync: vi.fn(), createNotification: vi.fn() }));
// The in-memory limiter would trip across this file's many POST cases.
vi.mock("@/lib/rateLimit", () => ({ rateLimitResponse: vi.fn(() => null) }));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { GET, POST } from "@/app/api/offers/route";
import { notifyAsync } from "@/lib/notifications";

// ── Test helpers + shared data ────────────────────────────────────────────────

function pokemonCatalog(title = "Charizard") {
  return {
    nameEn: title, rarity: "Rare Holo", setNameEn: "Base Set",
    language: "English", localId: "4/102", tcgPlayerId: "tcg-1",
  };
}

// The route resolves listingTitle via withListingDisplay() right after
// fetching the listing (POST step 3), for use in both notification branches.
// That helper throws if neither catalog relation is set — see
// resolveListingDisplay() in src/lib/listingDisplay.ts — so, matching the
// same fixture pattern already used in checkout/route.test.ts, LISTING must
// carry a resolvable catalog relation even in tests that never assert on
// the title text.
const LISTING = {
  id: "card-1", forSale: true, ownerId: "seller-1",
  pokemonCard: pokemonCatalog(), riftboundCard: null,
};

// A PaymentIntent that has been authorised — funds held, ready to capture.
// `amount` (5000 cents = S$50) matches the default `price: 50` used by most
// POST tests below. Tests that submit a different price (the amend tests,
// which use price: 60) override this mock with a matching `amount`.
const PI_REQUIRES_CAPTURE = { status: "requires_capture", metadata: { buyerId: "buyer-1", cardId: "card-1" }, amount: 5000 };

function postRequest(body: object) {
  return new NextRequest("http://localhost/api/offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(params: Record<string, string>) {
  const url = new URL("http://localhost/api/offers");
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url.toString());
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /api/offers
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /api/offers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: authenticated buyer
    mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });
    // Default: buyer has verified email + phone
    mockPrisma.user.findUnique.mockResolvedValue({ emailVerified: new Date(), phoneVerified: true });
    // Default: listing exists and is for sale
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    // Default: PI is authorised and belongs to this buyer
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue(PI_REQUIRES_CAPTURE);
    // Default: no existing offer from this buyer
    mockPrisma.offer.findFirst.mockResolvedValue(null);
    // Default: PI cancel succeeds (used in amend path)
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
  });

  // ── Auth ──────────────────────────────────────────────────────────────────

  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(401);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it("returns 400 when cardId is missing", async () => {
    const res = await POST(postRequest({ price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid offer data" });
  });

  it("returns 400 when price is zero or negative", async () => {
    const res = await POST(postRequest({ cardId: "card-1", price: 0, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when paymentIntentId is missing", async () => {
    const res = await POST(postRequest({ cardId: "card-1", price: 50 }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Missing paymentIntentId" });
  });

  // ── Card validation ───────────────────────────────────────────────────────

  it("returns 404 when card does not exist", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue(null);
    const res = await POST(postRequest({ cardId: "x", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(404);
  });

  it("returns 409 when card is not for sale", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, forSale: false });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(409);
  });

  it("returns 400 when buyer tries to offer on their own card", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "seller-1" } });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Cannot offer on your own card" });
  });

  // ── PaymentIntent validation ──────────────────────────────────────────────

  it("returns 409 when PI is not in requires_capture state (card declined etc.)", async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "canceled",
      metadata: {},
    });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("status: canceled") });
  });

  it("returns 403 when PI buyerId metadata does not match the authenticated buyer", async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture",
      metadata: { buyerId: "someone-else" },
    });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 without cancelling when the PI has no buyerId (e.g. someone's auction bid PI)", async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture",
      metadata: { bidderId: "someone-else", auctionId: "auction-1" },
      amount: 1,
    });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("returns 403 when the PI was authorised for a different card", async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      ...PI_REQUIRES_CAPTURE,
      metadata: { buyerId: "buyer-1", cardId: "card-2" },
    });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(403);
  });

  it("returns 403 when the buyer is not verified", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ emailVerified: null, phoneVerified: true });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(403);
    expect(mockStripeInstance.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  it("returns 400 and cancels the PI when its authorised amount doesn't match the claimed price", async () => {
    const res = await POST(postRequest({ cardId: "card-1", price: 500, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("does not match") });
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_1");
    expect(mockPrisma.offer.create).not.toHaveBeenCalled();
  });

  // ── New offer (happy path) ────────────────────────────────────────────────

  it("creates a new pending offer and returns 201 with cardId (not listingId) in the response", async () => {
    const createdOffer = {
      id: "offer-1",
      listingId: "card-1",
      buyerId: "buyer-1",
      sellerId: "seller-1",
      price: 5000,
      message: null,
      status: "pending",
      paymentIntentId: "pi_1",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockPrisma.offer.create.mockResolvedValue(createdOffer);

    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    const data = await res.json();

    expect(res.status).toBe(201);
    expect(data.amended).toBe(false);
    expect(data.offer.price).toBe(50);
    expect(data.offer.status).toBe("pending");
    // Wire format: cardId present, listingId never leaked to the client.
    expect(data.offer.cardId).toBe("card-1");
    expect(data.offer).not.toHaveProperty("listingId");

    expect(mockPrisma.offer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          listingId: "card-1",
          buyerId: "buyer-1",
          sellerId: "seller-1",
          status: "pending",
          paymentIntentId: "pi_1",
          expiresAt: expect.any(Date),
        }),
      })
    );
  });

  // ── Existing accepted offer ───────────────────────────────────────────────

  it("answers a retried submission of an already-stored PI idempotently without cancelling it", async () => {
    mockPrisma.offer.findFirst.mockResolvedValueOnce({
      id: "offer-1", buyerId: "buyer-1", status: "pending", listingId: "card-1", price: 5000, paymentIntentId: "pi_1",
    });
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(200);
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockPrisma.offer.create).not.toHaveBeenCalled();
  });

  it("returns 409 when the unique index rejects a PI a simultaneous request just stored", async () => {
    mockPrisma.offer.create.mockRejectedValueOnce(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(409);
  });

  it("returns 409 when buyer already has an accepted offer (mid-capture)", async () => {
    mockPrisma.offer.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: "offer-old", status: "accepted" });

    const res = await POST(postRequest({ cardId: "card-1", price: 50, paymentIntentId: "pi_1" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("accepted offer") });
  });

  // ── Amend existing pending offer ──────────────────────────────────────────

  it("cancels the old PI and updates the existing pending offer (amended: true)", async () => {
    const existingOffer = {
      id: "offer-old",
      listingId: "card-1",
      status: "pending",
      paymentIntentId: "pi_old",
    };
    mockPrisma.offer.findFirst.mockResolvedValueOnce(null).mockResolvedValue(existingOffer);
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture", metadata: { buyerId: "buyer-1", cardId: "card-1" }, amount: 6000,
    });
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(
      postRequest({ cardId: "card-1", price: 60, message: "Can pick up in person", paymentIntentId: "pi_new" })
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.amended).toBe(true);
    expect(data.offer.cardId).toBe("card-1");
    expect(data.offer.price).toBe(60);

    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_old");

    // Swap is conditional on the offer still being pending with the PI we read
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "offer-old", status: "pending", paymentIntentId: "pi_old" },
        data: expect.objectContaining({
          paymentIntentId: "pi_new",
          expiresAt: expect.any(Date),
        }),
      })
    );

    const updateCall = mockPrisma.offer.updateMany.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("sellerId");
  });

  it("returns 409 and cancels the NEW PI (not the old one) when the conditional swap matches 0 rows", async () => {
    mockPrisma.offer.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "offer-old",
      listingId: "card-1",
      status: "pending",
      paymentIntentId: "pi_old",
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture", metadata: { buyerId: "buyer-1", cardId: "card-1" }, amount: 6000,
    });
    // Seller accepted/rejected (or another amend landed) between read and write
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 0 });

    const res = await POST(
      postRequest({ cardId: "card-1", price: 60, paymentIntentId: "pi_new" })
    );

    expect(res.status).toBe(409);
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_new");
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalledWith("pi_old");
    expect(vi.mocked(notifyAsync)).not.toHaveBeenCalled();
  });

  it("notifies the seller with the updated price when an offer is amended", async () => {
    mockPrisma.offer.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "offer-old",
      listingId: "card-1",
      status: "pending",
      paymentIntentId: "pi_old",
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture", metadata: { buyerId: "buyer-1", cardId: "card-1" }, amount: 6000,
    });
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });

    await POST(
      postRequest({ cardId: "card-1", price: 60, paymentIntentId: "pi_new" })
    );

    expect(vi.mocked(notifyAsync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyAsync)).toHaveBeenCalledWith(
      expect.objectContaining({
        userId:  "seller-1",
        type:    "offer_received",
        offerId: "offer-old",
        cardId:  "card-1",
        body:    expect.stringContaining("S$60"),
      })
    );
  });

  it("continues amending even if cancelling old PI fails (logs warning)", async () => {
    mockPrisma.offer.findFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "offer-old",
      listingId: "card-1",
      status: "pending",
      paymentIntentId: "pi_old",
    });
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({
      status: "requires_capture", metadata: { buyerId: "buyer-1", cardId: "card-1" }, amount: 6000,
    });
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(new Error("already cancelled"));
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });

    const res = await POST(
      postRequest({ cardId: "card-1", price: 60, paymentIntentId: "pi_new" })
    );
    expect(res.status).toBe(200);
    expect(mockPrisma.offer.updateMany).toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/offers
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /api/offers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(getRequest({ mine: "true" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when no recognised query param is provided", async () => {
    const res = await GET(getRequest({}));
    expect(res.status).toBe(400);
  });

  // ── Buyer: my offer on a specific card ────────────────────────────────────

  it("returns buyer's own offer when cardId + myOffer=true, with cardId in the response", async () => {
    const offer = { id: "offer-1", listingId: "card-1", price: 5000, status: "pending" };
    mockPrisma.offer.findFirst.mockResolvedValue(offer);

    const res = await GET(getRequest({ cardId: "card-1", myOffer: "true" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.offer.price).toBe(50);
    expect(data.offer.cardId).toBe("card-1");
    expect(data.offer).not.toHaveProperty("listingId");
  });

  it("returns null when buyer has no offer on the card", async () => {
    mockPrisma.offer.findFirst.mockResolvedValue(null);

    const res = await GET(getRequest({ cardId: "card-1", myOffer: "true" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.offer).toBeNull();
  });

  // ── Seller: all offers on their card ─────────────────────────────────────

  it("returns all offers for the seller who owns the card", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "seller-1" } });
    mockPrisma.listing.findUnique.mockResolvedValue({ ownerId: "seller-1" });
    mockPrisma.offer.findMany.mockResolvedValue([
      { id: "offer-1", listingId: "card-1", price: 5000, status: "pending", buyer: { id: "buyer-1", username: "bob", email: "bob@x.com" } },
    ]);

    const res = await GET(getRequest({ cardId: "card-1" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.offers).toHaveLength(1);
    expect(data.offers[0].price).toBe(50);
    expect(data.offers[0].cardId).toBe("card-1");
    // Buyer email IS expected here — this route deliberately keeps it (see
    // Global Constraints), unlike the public card-browsing routes.
    expect(data.offers[0].buyer.email).toBe("bob@x.com");
  });

  it("returns 403 when a non-owner tries to view offers on a card", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ownerId: "seller-1" });

    const res = await GET(getRequest({ cardId: "card-1" }));
    expect(res.status).toBe(403);
  });

  it("returns 404 when the card does not exist (seller view)", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "seller-1" } });
    mockPrisma.listing.findUnique.mockResolvedValue(null);

    const res = await GET(getRequest({ cardId: "missing-card" }));
    expect(res.status).toBe(404);
  });

  // ── Buyer: full offer history ─────────────────────────────────────────────

  it("returns all of the buyer's offers when mine=true, with resolved catalog fields", async () => {
    mockPrisma.offer.findMany.mockResolvedValue([
      {
        id: "offer-1", listingId: "card-1", price: 5000, status: "pending",
        listing: {
          id: "card-1", imageUrls: [], condition: "NM", forSale: true,
          owner: { id: "seller-1", username: "alice", email: "a@x.com" },
          pokemonCard: pokemonCatalog("Charizard"), riftboundCard: null,
        },
      },
      {
        id: "offer-2", listingId: "card-2", price: 3000, status: "expired",
        listing: {
          id: "card-2", imageUrls: [], condition: "LP", forSale: false,
          owner: { id: "seller-1", username: "alice", email: "a@x.com" },
          pokemonCard: pokemonCatalog("Blastoise"), riftboundCard: null,
        },
      },
    ]);

    const res = await GET(getRequest({ mine: "true" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.offers).toHaveLength(2);
    expect(data.offers[0].price).toBe(50);
    expect(data.offers[1].price).toBe(30);
    expect(data.offers[0].cardId).toBe("card-1");
    expect(data.offers[0].card.title).toBe("Charizard");
    expect(data.offers[1].card.title).toBe("Blastoise");
  });

  // ── Seller: received offers across all lifecycle states ──────────────────

  it("returns all lifecycle states (pending, expired, rejected, paid) for received=true", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "seller-1" } });
    mockPrisma.offer.findMany.mockResolvedValue([
      {
        id: "offer-1", listingId: "card-1", price: 5000, status: "pending", archivedAt: null,
        listing: { id: "card-1", imageUrls: [], condition: "NM", pokemonCard: pokemonCatalog("Charizard"), riftboundCard: null },
      },
      {
        id: "offer-2", listingId: "card-1", price: 3000, status: "expired", archivedAt: null,
        listing: { id: "card-1", imageUrls: [], condition: "NM", pokemonCard: pokemonCatalog("Charizard"), riftboundCard: null },
      },
      {
        id: "offer-3", listingId: "card-1", price: 4000, status: "rejected", archivedAt: null,
        listing: { id: "card-1", imageUrls: [], condition: "NM", pokemonCard: pokemonCatalog("Charizard"), riftboundCard: null },
      },
      {
        id: "offer-4", listingId: "card-2", price: 6000, status: "paid", archivedAt: new Date(),
        listing: { id: "card-2", imageUrls: [], condition: "LP", pokemonCard: pokemonCatalog("Blastoise"), riftboundCard: null },
      },
    ]);

    const res = await GET(getRequest({ received: "true" }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.offers).toHaveLength(4);
    expect(data.offers[0].price).toBe(50);
    expect(data.offers[1].price).toBe(30);
    expect(data.offers[2].price).toBe(40);
    expect(data.offers[3].price).toBe(60);
    expect(data.offers[3].card.title).toBe("Blastoise");

    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sellerId: "seller-1",
          OR: expect.arrayContaining([
            { archivedAt: null },
            { status: { in: expect.arrayContaining(["paid", "accepted"]) } },
          ]),
        }),
      }),
    );
  });
});
