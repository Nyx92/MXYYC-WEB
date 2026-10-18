import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/collection-requests/[id]/mark-packed — staff only. Advances a
 * REQUESTED pickup to PACKED, resolves the Discord alert, and notifies
 * the customer in-app.
 */

const mockPrisma = vi.hoisted(() => ({
  collectionRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockResolveCollectionNotification = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockNotifyAsync = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/discord", () => ({ resolveCollectionNotification: mockResolveCollectionNotification }));
vi.mock("@/lib/notifications", () => ({ notifyAsync: mockNotifyAsync }));

import { POST } from "@/app/api/collection-requests/[id]/mark-packed/route";

function postRequest() {
  return new Request("http://localhost/api/collection-requests/req-1/mark-packed", { method: "POST" }) as any;
}
const params = { params: Promise.resolve({ id: "req-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue({ user: { id: "admin-1", role: "admin", username: "staff" } });
  mockPrisma.collectionRequest.findUnique.mockResolvedValue({
    id: "req-1", userId: "user-1", status: "REQUESTED", requestRef: "PU-2609-AAAA", discordMessageIds: ["msg-1"],
  });
  mockPrisma.collectionRequest.updateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/collection-requests/[id]/mark-packed", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "user-1", role: "user" } });
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(403);
  });

  it("returns 404 when the request doesn't exist", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue(null);
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(404);
    expect(mockPrisma.collectionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("returns 409 when the request isn't REQUESTED", async () => {
    mockPrisma.collectionRequest.findUnique.mockResolvedValue({ id: "req-1", status: "PACKED" });
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(409);
    expect(mockPrisma.collectionRequest.updateMany).not.toHaveBeenCalled();
  });

  it("marks PACKED, resolves the Discord alert, and notifies the customer", async () => {
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(200);

    expect(mockPrisma.collectionRequest.updateMany).toHaveBeenCalledWith({
      where: { id: "req-1", status: "REQUESTED" },
      data: { status: "PACKED", packedAt: expect.any(Date) },
    });
    expect(mockResolveCollectionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ messageIds: ["msg-1"], requestRef: "PU-2609-AAAA" })
    );
    expect(mockNotifyAsync).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", type: "collection_packed" })
    );
  });

  it("falls back to \"staff\" for the Discord admin name when the admin has none", async () => {
    mockGetServerSession.mockResolvedValue({ user: { id: "admin-1", role: "admin", username: null, firstName: null, email: null } });
    await POST(postRequest(), params);
    expect(mockResolveCollectionNotification).toHaveBeenCalledWith(
      expect.objectContaining({ adminName: "staff" })
    );
  });

  it("returns 409 and skips side effects when a concurrent change beat the update", async () => {
    mockPrisma.collectionRequest.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(postRequest(), params);
    expect(res.status).toBe(409);
    expect(mockNotifyAsync).not.toHaveBeenCalled();
    expect(mockResolveCollectionNotification).not.toHaveBeenCalled();
  });
});
