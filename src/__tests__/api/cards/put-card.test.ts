import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PUT /api/cards/[id]
 *
 * Owner-only update path: a card owner can toggle forSale/price on their own
 * card. Tests here cover the guard that blocks re-listing a card for sale
 * while it's locked in an active auction (POST /api/auctions sets
 * inAuction: true and forSale: false — this route must not let the owner
 * silently undo that via a separate PUT while bids are live).
 */

const mockPrisma = vi.hoisted(() => ({
  listing: { findUnique: vi.fn(), update: vi.fn() },
  pokemonCardCatalog: { update: vi.fn() },
  riftboundCardCatalog: { update: vi.fn() },
  // Admin update path validates the client-supplied ownerId exists before
  // updating — see "validates ownerId exists" describe block below.
  user: { findUnique: vi.fn() },
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    authOptions: {},
  };
});
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ storage: { from: vi.fn() } })),
}));

import { PUT } from "@/app/api/cards/[id]/route";

const OWNER_SESSION = { user: { id: "owner-1", role: "user" } };

function putRequest(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/api/cards/card-1", { method: "PUT", body });
}

const LISTING = {
  id: "card-1",
  ownerId: "owner-1",
  price: 1000,
  forSale: true,
  inAuction: false,
};

describe("PUT /api/cards/[id] — owner update", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(OWNER_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    mockPrisma.listing.update.mockResolvedValue({ ...LISTING, price: 1500, forSale: true });
  });

  it("returns 409 when the owner tries to list a card for sale while it's in an active auction", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, inAuction: true, forSale: false });

    const res = await PUT(putRequest({ price: "15", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "Cannot list a card for sale while it is in an active auction",
    });
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the owner tries to list a card for sale while it's marked for in-person collection", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, forSale: false, collectionRequestId: "req-1" });

    const res = await PUT(putRequest({ price: "15", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "Cannot list a card for sale while it is marked for in-person collection",
    });
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });

  it("allows unlisting (forSale: false) even while in an active auction", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, inAuction: true, forSale: false });

    const res = await PUT(putRequest({ price: "", forSale: "false" }), { params: Promise.resolve({ id: "card-1" }) });

    expect(res.status).toBe(200);
    // Unlisting only re-checks ownership + no live Buy Now reservation
    expect(mockPrisma.listing.update).toHaveBeenCalledWith({
      where: {
        id: "card-1",
        ownerId: "owner-1",
        AND: [{ OR: [{ reservedUntil: null }, { reservedUntil: { lt: expect.any(Date) } }] }],
      },
      data: { price: null, forSale: false },
    });
  });

  it("allows the normal price/forSale update when not in an auction", async () => {
    const res = await PUT(putRequest({ price: "15", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });

    expect(res.status).toBe(200);
    expect(mockPrisma.listing.update).toHaveBeenCalledWith({
      where: {
        id: "card-1",
        ownerId: "owner-1",
        AND: [{
          inAuction: false,
          collectionRequestId: null,
          OR: [{ reservedUntil: null }, { reservedUntil: { lt: expect.any(Date) } }],
        }],
      },
      data: { price: 1500, forSale: true },
    });
  });

  it("returns 409 when the card changed (sold / auctioned / collected / reserved) between the read and the write (P2025)", async () => {
    mockPrisma.listing.update.mockRejectedValue(Object.assign(new Error("Record not found"), { code: "P2025" }));
    const res = await PUT(putRequest({ price: "15", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });
    expect(res.status).toBe(409);
  });

  it("omits the reservation columns from the success response", async () => {
    mockPrisma.listing.update.mockResolvedValue({
      ...LISTING, price: 1500, forSale: true,
      reservedById: "buyer-9", reservedUntil: new Date(), reservedCheckoutSessionId: "cs_123",
    });
    const res = await PUT(putRequest({ price: "15", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });
    const { card } = await res.json();

    expect(res.status).toBe(200);
    expect(card.price).toBe(15);
    expect(card).not.toHaveProperty("reservedById");
    expect(card).not.toHaveProperty("reservedUntil");
    expect(card).not.toHaveProperty("reservedCheckoutSessionId");
  });

  it("returns 400 when forSale is true and price is zero", async () => {
    const res = await PUT(putRequest({ price: "0", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "Price must be greater than $0 when listing a card for sale",
    });
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });

  it("returns 400 when forSale is true and price is negative", async () => {
    const res = await PUT(putRequest({ price: "-5", forSale: "true" }), { params: Promise.resolve({ id: "card-1" }) });
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });
});

describe("PUT /api/cards/[id] — admin update with shared guard", () => {
  const ADMIN_SESSION = { user: { id: "admin-1", role: "admin" } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrisma.listing.findUnique.mockResolvedValue(LISTING);
    // Happy-path default: the submitted ownerId resolves to a real user.
    // Individual tests override this to exercise the "owner doesn't exist" guard.
    mockPrisma.user.findUnique.mockResolvedValue({ id: "owner-1" });
  });

  it("returns 409 when the admin tries to list a card for sale while it's in an active auction", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({ ...LISTING, inAuction: true, forSale: false });

    // Admin request with full fields (title, condition, ownerId, etc.) — the
    // guard runs before admin-specific validation, so it should 409 before
    // image validation or catalog lookup matter, but we construct a
    // realistic request anyway.
    const adminFields = {
      title: "Charizard Holo",
      condition: "Mint",
      ownerId: "owner-1",
      tcgPlayerId: "base1-4",
      language: "English",
      forSale: "true",
      price: "100",
    };

    const res = await PUT(putRequest(adminFields), { params: Promise.resolve({ id: "card-1" }) });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: "Cannot list a card for sale while it is in an active auction",
    });
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });

  it("updates only the listing and never the shared catalog row, even if identity fields are sent", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({
      ...LISTING, game: "POKEMON", pokemonCardId: "pkc-1", riftboundCardId: null,
    });
    mockPrisma.listing.update.mockResolvedValue({
      ...LISTING,
      price: 10000,
      pokemonCard: {
        nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
        language: "English", localId: "004", tcgPlayerId: "base1-4",
      },
      riftboundCard: null,
    });

    const res = await PUT(
      putRequest({
        // An old client may still send these — they must be ignored.
        title: "Renamed",
        setName: "Other Set",
        tcgPlayerId: "other-id",
        condition: "Mint",
        ownerId: "owner-1",
        forSale: "true",
        price: "100",
        keepImageUrls: JSON.stringify(["https://example.com/old.png"]),
      }),
      { params: Promise.resolve({ id: "card-1" }) }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockPrisma.pokemonCardCatalog.update).not.toHaveBeenCalled();
    expect(mockPrisma.riftboundCardCatalog.update).not.toHaveBeenCalled();
    const data = mockPrisma.listing.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ condition: "Mint", price: 10000, ownerId: "owner-1" });
    expect(data).not.toHaveProperty("pokemonCardId");
    expect(body.card.title).toBe("Charizard");
  });

  it("returns 400 when the submitted ownerId doesn't match any user", async () => {
    mockPrisma.listing.findUnique.mockResolvedValue({
      ...LISTING, game: "POKEMON", pokemonCardId: "pkc-1", riftboundCardId: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await PUT(
      putRequest({
        title: "Charizard Holo",
        condition: "Mint",
        ownerId: "nonexistent-user",
        setName: "Base Set",
        rarity: "Mint",
        tcgPlayerId: "base1-4",
        language: "English",
        cardNumber: "004",
        forSale: "true",
        price: "100",
        keepImageUrls: JSON.stringify(["https://example.com/old.png"]),
      }),
      { params: Promise.resolve({ id: "card-1" }) }
    );

    expect(res.status).toBe(400);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "nonexistent-user" },
      select: { id: true },
    });
    expect(mockPrisma.pokemonCardCatalog.update).not.toHaveBeenCalled();
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });

  const ADMIN_FIELDS = {
    title: "Charizard Holo",
    condition: "Mint",
    ownerId: "owner-1",
    tcgPlayerId: "base1-4",
    language: "English",
    forSale: "true",
    price: "100",
    keepImageUrls: JSON.stringify(["https://example.com/old.png"]),
  };

  it("adds the auction/pickup/reservation locks when reassigning the owner, and 409s on P2025", async () => {
    mockPrisma.listing.update.mockRejectedValue(Object.assign(new Error("Record not found"), { code: "P2025" }));

    const res = await PUT(putRequest({ ...ADMIN_FIELDS, ownerId: "owner-2" }), { params: Promise.resolve({ id: "card-1" }) });

    expect(res.status).toBe(409);
    expect(mockPrisma.listing.update.mock.calls[0][0].where).toEqual({
      id: "card-1",
      AND: [{
        inAuction: false,
        collectionRequestId: null,
        OR: [{ reservedUntil: null }, { reservedUntil: { lt: expect.any(Date) } }],
      }],
    });
  });

  it("returns 400 (not 500) for malformed keepImageUrls JSON", async () => {
    const res = await PUT(putRequest({ ...ADMIN_FIELDS, keepImageUrls: "not json" }), { params: Promise.resolve({ id: "card-1" }) });
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.update).not.toHaveBeenCalled();
  });
});
