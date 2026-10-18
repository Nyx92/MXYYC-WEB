import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/admin/collection-requests — staff only. Every open
 * (REQUESTED/PACKED) pickup request with its customer and cards, or the
 * COLLECTED requests when ?status=completed.
 */

const mockPrisma = vi.hoisted(() => ({
  collectionRequest: { findMany: vi.fn() },
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

import { GET } from "@/app/api/admin/collection-requests/route";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
  mockPrisma.collectionRequest.findMany.mockResolvedValue([]);
});

describe("GET /api/admin/collection-requests", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await GET(new Request("http://localhost/api/admin/collection-requests"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "user-1", role: "user" } });
    const res = await GET(new Request("http://localhost/api/admin/collection-requests"));
    expect(res.status).toBe(403);
    expect(mockPrisma.collectionRequest.findMany).not.toHaveBeenCalled();
  });

  it("defaults to open statuses when no status param is given", async () => {
    await GET(new Request("http://localhost/api/admin/collection-requests"));
    expect(mockPrisma.collectionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: { in: ["REQUESTED", "PACKED"] } },
        orderBy: { requestedAt: "asc" },
      })
    );
  });

  it("queries COLLECTED requests, newest first, when status=completed", async () => {
    await GET(new Request("http://localhost/api/admin/collection-requests?status=completed"));
    expect(mockPrisma.collectionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "COLLECTED" },
        orderBy: { collectedAt: "desc" },
      })
    );
  });

  it("caps the completed query at 100 rows, since completed requests never leave the view", async () => {
    await GET(new Request("http://localhost/api/admin/collection-requests?status=completed"));
    expect(mockPrisma.collectionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 })
    );
  });

  it("does not cap the open query, since open requests are naturally few", async () => {
    await GET(new Request("http://localhost/api/admin/collection-requests"));
    expect(mockPrisma.collectionRequest.findMany).toHaveBeenCalledWith(
      expect.not.objectContaining({ take: expect.anything() })
    );
  });

  it("includes collectedByStaff in the response shape", async () => {
    mockPrisma.collectionRequest.findMany.mockResolvedValue([
      {
        id: "req-1", requestRef: "PU-2609-AAAA", status: "COLLECTED",
        requestedAt: new Date(), packedAt: new Date(), collectedAt: new Date(),
        collectedByStaff: { id: "admin-1", username: "staffuser" },
        user: { id: "user-1", username: "ash", firstName: "Ash", lastName: "Ketchum", email: "ash@example.com" },
        listings: [],
      },
    ]);
    const res = await GET(new Request("http://localhost/api/admin/collection-requests?status=completed"));
    const body = await res.json();
    expect(body.requests[0].collectedByStaff).toEqual({ id: "admin-1", username: "staffuser" });
  });

  it("shapes each request with customer and resolved card display fields", async () => {
    mockPrisma.collectionRequest.findMany.mockResolvedValue([
      {
        id: "req-1", requestRef: "PU-2609-AAAA", status: "REQUESTED",
        requestedAt: new Date(), packedAt: null,
        user: { id: "user-1", username: "ash", firstName: "Ash", lastName: "Ketchum", email: "ash@example.com" },
        listings: [{
          id: "l1", condition: "NM", ownerId: "user-1",
          pokemonCard: { nameEn: "Pikachu", rarity: "Common", setNameEn: "Base Set", language: "English", localId: "25", tcgPlayerId: "tcg-1" },
          riftboundCard: null,
        }],
      },
    ]);

    const res = await GET(new Request("http://localhost/api/admin/collection-requests"));
    const body = await res.json();

    expect(body.requests[0].customer.username).toBe("ash");
    expect(body.requests[0].cards[0].title).toBe("Pikachu");
  });

  it("omits cards the customer no longer owns (e.g. sold after being attached)", async () => {
    mockPrisma.collectionRequest.findMany.mockResolvedValue([
      {
        id: "req-1", requestRef: "PU-2609-AAAA", status: "REQUESTED",
        requestedAt: new Date(), packedAt: null,
        user: { id: "user-1", username: "ash", firstName: "Ash", lastName: "Ketchum", email: "ash@example.com" },
        listings: [{
          id: "l1", condition: "NM", ownerId: "buyer-9",
          pokemonCard: { nameEn: "Pikachu", rarity: "Common", setNameEn: "Base Set", language: "English", localId: "25", tcgPlayerId: "tcg-1" },
          riftboundCard: null,
        }],
      },
    ]);
    const body = await (await GET(new Request("http://localhost/api/admin/collection-requests"))).json();
    expect(body.requests[0].cards).toEqual([]);
  });

  it("returns 500 on a DB error", async () => {
    mockPrisma.collectionRequest.findMany.mockRejectedValue(new Error("DB down"));
    const res = await GET(new Request("http://localhost/api/admin/collection-requests"));
    expect(res.status).toBe(500);
  });
});
