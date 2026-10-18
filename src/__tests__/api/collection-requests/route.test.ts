import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/collection-requests
 *
 * Marks one or more owned cards for in-person collection, joining the
 * caller's existing open request (or creating one). Cards for sale, in an
 * auction, with a pending offer, already collected, or already part of a
 * request are all rejected.
 */

const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn(), updateMany: vi.fn() },
  offer: { findFirst: vi.fn() },
  collectionRequest: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn().mockReturnValue({ allowed: true }));
const mockPostCollectionRequest = vi.hoisted(() => vi.fn().mockResolvedValue("discord-msg-1"));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/discord", () => ({ postCollectionRequest: mockPostCollectionRequest }));

import { POST } from "@/app/api/collection-requests/route";

function postRequest(body: object) {
  return new Request("http://localhost/api/collection-requests", {
    method: "POST",
    body: JSON.stringify(body),
  }) as any;
}

const SESSION = { user: { id: "user-1", email: "ash@example.com", username: "ash" } };

function makeListing(id: string, overrides = {}) {
  return {
    id,
    ownerId: "user-1",
    forSale: false,
    inAuction: false,
    collectionRequestId: null,
    collectedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockGetServerSession.mockResolvedValue(SESSION);
  mockPrisma.offer.findFirst.mockResolvedValue(null);
  mockPrisma.collectionRequest.findFirst.mockResolvedValue(null);
  mockPrisma.collectionRequest.create.mockResolvedValue({ id: "req-1", requestRef: "PU-2609-AAAA", status: "REQUESTED" });
  mockPrisma.collectionRequest.update.mockResolvedValue({ id: "req-1", requestRef: "PU-2609-AAAA", status: "REQUESTED" });
  // The route wraps the request lookup/create + listing update in an
  // interactive transaction — run the callback against the same mock so
  // every existing collectionRequest/listing assertion still applies.
  mockPrisma.$transaction.mockImplementation((cb: (tx: typeof mockPrisma) => Promise<unknown>) => cb(mockPrisma));
  // Conditional attach matches every submitted listing by default.
  mockPrisma.listing.updateMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) => ({ count: args.where.id.in.length })
  );
});

describe("POST /api/collection-requests", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest({ listingIds: ["l1"] }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const res = await POST(postRequest({ listingIds: ["l1"] }));
    expect(res.status).toBe(429);
  });

  it("returns 400 when listingIds is empty or missing", async () => {
    const res = await POST(postRequest({ listingIds: [] }));
    expect(res.status).toBe(400);
  });

  it("returns 404 when a card isn't found", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([]);
    const res = await POST(postRequest({ listingIds: ["l1"] }));
    expect(res.status).toBe(404);
  });

  it("de-dupes a repeated listing id instead of wrongly 404ing", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1")]);
    const res = await POST(postRequest({ listingIds: ["l1", "l1"] }));
    expect(res.status).toBe(200);
    expect(mockPrisma.listing.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["l1"] }, ownerId: "user-1", forSale: false, inAuction: false, collectionRequestId: null, collectedAt: null },
      data: { collectionRequestId: "req-1" },
    });
  });

  it("returns 403 when a card isn't owned by the caller", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1", { ownerId: "other-user" })]);
    const res = await POST(postRequest({ listingIds: ["l1"] }));
    expect(res.status).toBe(403);
  });

  it.each([
    ["forSale", { forSale: true }, /listed for sale/i],
    ["inAuction", { inAuction: true }, /active auction/i],
    ["collectionRequestId", { collectionRequestId: "other-req" }, /pickup request/i],
    ["collectedAt", { collectedAt: new Date() }, /already been collected/i],
  ])("returns 409 when a card %s is set", async (_name, overrides, matcher) => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1", overrides)]);
    const res = await POST(postRequest({ listingIds: ["l1"] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(matcher);
  });

  it("returns 409 when a card stopped being eligible between the read and the attach (race)", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1"), makeListing("l2")]);
    mockPrisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
    const res = await POST(postRequest({ listingIds: ["l1", "l2"] }));
    expect(res.status).toBe(409);
    expect(mockPostCollectionRequest).not.toHaveBeenCalled();
  });

  it("returns 409 when a card has a pending offer", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1")]);
    mockPrisma.offer.findFirst.mockResolvedValue({ id: "offer-1" });
    const res = await POST(postRequest({ listingIds: ["l1"] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/pending offer/i);
  });

  it("creates a new request, links the listings, and posts a Discord alert", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1"), makeListing("l2")]);

    const res = await POST(postRequest({ listingIds: ["l1", "l2"] }));
    expect(res.status).toBe(200);

    expect(mockPrisma.collectionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "user-1" }) })
    );
    expect(mockPrisma.listing.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["l1", "l2"] }, ownerId: "user-1", forSale: false, inAuction: false, collectionRequestId: null, collectedAt: null },
      data: { collectionRequestId: "req-1" },
    });
    expect(mockPostCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestRef: "PU-2609-AAAA", itemCount: 2, isTopUp: false })
    );
    expect(mockPrisma.collectionRequest.update).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { discordMessageIds: { push: "discord-msg-1" } },
    });
  });

  it("skips the discordMessageIds update when Discord isn't configured", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l1")]);
    mockPostCollectionRequest.mockResolvedValueOnce(null);

    await POST(postRequest({ listingIds: ["l1"] }));

    expect(mockPrisma.collectionRequest.update).not.toHaveBeenCalled();
  });

  it("joins an existing open request instead of creating a new one", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l3")]);
    mockPrisma.collectionRequest.findFirst.mockResolvedValue({ id: "existing-req", status: "REQUESTED", requestRef: "PU-2608-ZZZZ" });
    mockPrisma.collectionRequest.update.mockResolvedValue({ id: "existing-req", status: "REQUESTED", requestRef: "PU-2608-ZZZZ" });

    const res = await POST(postRequest({ listingIds: ["l3"] }));
    expect(res.status).toBe(200);
    expect(mockPrisma.collectionRequest.create).not.toHaveBeenCalled();
    expect(mockPrisma.collectionRequest.update).toHaveBeenNthCalledWith(1, { where: { id: "existing-req", status: "REQUESTED" }, data: {} });
    // Topping up reports the just-added count, worded as an addition, not
    // the request's full size — see postCollectionRequest's isTopUp param.
    expect(mockPostCollectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ itemCount: 1, isTopUp: true })
    );
  });

  it("reverts an already-PACKED request back to REQUESTED when topped up", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l4")]);
    mockPrisma.collectionRequest.findFirst.mockResolvedValue({ id: "packed-req", status: "PACKED", requestRef: "PU-2608-ZZZZ" });

    await POST(postRequest({ listingIds: ["l4"] }));

    expect(mockPrisma.collectionRequest.update).toHaveBeenNthCalledWith(1, {
      where: { id: "packed-req", status: "PACKED" },
      // The old pickup code is cleared too — it was issued for the packed set.
      data: {
        status: "REQUESTED",
        packedAt: null,
        pickupCodeHash: null,
        pickupCodeExpiresAt: null,
        pickupCodeAttempts: 0,
      },
    });
    expect(mockPostCollectionRequest).toHaveBeenCalledWith(expect.objectContaining({ isTopUp: true }));
  });

  it("returns 409 instead of reopening a request whose status changed concurrently (e.g. just collected)", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l6")]);
    mockPrisma.collectionRequest.findFirst.mockResolvedValue({ id: "packed-req", status: "PACKED", requestRef: "PU-2608-ZZZZ" });
    mockPrisma.collectionRequest.update.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "P2025" }));
    const res = await POST(postRequest({ listingIds: ["l6"] }));
    expect(res.status).toBe(409);
  });

  it("still returns 200 when storing the Discord message id fails after the request was created", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([makeListing("l5")]);
    // The transaction's create succeeds; only the post-commit update fails.
    mockPrisma.collectionRequest.update.mockRejectedValueOnce(new Error("db blip"));

    const res = await POST(postRequest({ listingIds: ["l5"] }));
    expect(res.status).toBe(200);
  });
});
