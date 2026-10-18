import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/collection-requests/[id]/otp/confirm — verifies the pickup
 * code and, on success, marks the request and every card in it COLLECTED.
 * Uses the real verificationCode helpers (pure crypto) so the hash
 * comparison here matches production exactly.
 */

const mockPrisma = vi.hoisted(() => ({
  collectionRequest: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  listing: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn().mockReturnValue({ allowed: true }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: mockCheckRateLimit }));

import { POST } from "@/app/api/collection-requests/[id]/otp/confirm/route";
import { hashVerificationCode } from "@/lib/verificationCode";

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/collection-requests/req-1/otp/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  }) as any;
}
const params = { params: Promise.resolve({ id: "req-1" }) };

const CODE = "482910";
const CODE_HASH = hashVerificationCode(CODE);

beforeEach(() => {
  vi.clearAllMocks();
  // Interactive transaction — run the callback against the same mock.
  mockPrisma.$transaction.mockImplementation((cb: (tx: typeof mockPrisma) => Promise<unknown>) => cb(mockPrisma));
  mockPrisma.collectionRequest.updateMany.mockResolvedValue({ count: 1 });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockGetServerSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST /api/collection-requests/[id]/otp/confirm", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(401);
  });

  it("returns 429 when rate limited", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(429);
  });

  it("returns 400 when no code is given in the body", async () => {
    const res = await POST(postRequest({}), params);
    expect(res.status).toBe(400);
    expect(mockPrisma.collectionRequest.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the request doesn't exist", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue(null);
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the request doesn't belong to the caller", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({ id: "req-1", userId: "someone-else", status: "PACKED" });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(404);
  });

  it("returns 400 when no code was requested", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "PACKED", pickupCodeHash: null, pickupCodeExpiresAt: null,
    });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the code has expired", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "PACKED",
      pickupCodeHash: CODE_HASH, pickupCodeExpiresAt: new Date(Date.now() - 1000), pickupCodeAttempts: 0,
    });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expired/i);
  });

  it("returns 400 and increments attempts on a wrong code", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "PACKED",
      pickupCodeHash: CODE_HASH, pickupCodeExpiresAt: new Date(Date.now() + 60_000), pickupCodeAttempts: 0,
    });
    const res = await POST(postRequest({ code: "000000" }), params);
    expect(res.status).toBe(400);
    expect(mockPrisma.collectionRequest.update).toHaveBeenCalledWith({
      where: { id: "req-1" },
      data: { pickupCodeAttempts: { increment: 1 } },
    });
  });

  it("returns 400 once the attempt cap is reached", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "PACKED",
      pickupCodeHash: CODE_HASH, pickupCodeExpiresAt: new Date(Date.now() + 60_000), pickupCodeAttempts: 5,
    });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(400);
    expect(mockPrisma.collectionRequest.update).not.toHaveBeenCalled();
  });

  it("returns 409 when already collected", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({ id: "req-1", userId: "user-1", status: "COLLECTED" });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(409);
  });

  it("marks the request and every listing in it COLLECTED on a correct code", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "PACKED",
      pickupCodeHash: CODE_HASH, pickupCodeExpiresAt: new Date(Date.now() + 60_000), pickupCodeAttempts: 1,
    });

    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(200);

    expect(mockPrisma.collectionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: "PACKED" },
      data: expect.objectContaining({ status: "COLLECTED", collectedAt: expect.any(Date), pickupCodeHash: null }),
    });
    expect(mockPrisma.listing.updateMany).toHaveBeenCalledWith({
      where: { collectionRequestId: "req-1", ownerId: "user-1" },
      data: { collectedAt: expect.any(Date) },
    });
  });

  it("returns 409 when a top-up reverted the request to REQUESTED, even with a still-valid code", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "REQUESTED",
      pickupCodeHash: CODE_HASH, pickupCodeExpiresAt: new Date(Date.now() + 60_000), pickupCodeAttempts: 0,
    });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(409);
    expect(mockPrisma.listing.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 without stamping cards when the request stops being PACKED mid-confirm (race)", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({
      id: "req-1", userId: "user-1", status: "PACKED",
      pickupCodeHash: CODE_HASH, pickupCodeExpiresAt: new Date(Date.now() + 60_000), pickupCodeAttempts: 0,
    });
    mockPrisma.collectionRequest.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(postRequest({ code: CODE }), params);
    expect(res.status).toBe(409);
    expect(mockPrisma.listing.updateMany).not.toHaveBeenCalled();
  });
});
