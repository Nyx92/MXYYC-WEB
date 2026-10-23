import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStripe = vi.hoisted(() => ({
  checkout: { sessions: { expire: vi.fn(), retrieve: vi.fn() } },
}));
const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn(), updateMany: vi.fn() },
  order: { updateMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("stripe", () => ({ default: vi.fn(() => mockStripe) }));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { closeCheckoutSession, closeLapsedCheckouts } from "@/lib/checkoutSessions";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockResolvedValue([]);
});

describe("closeCheckoutSession", () => {
  it("expires an open session and releases its hold", async () => {
    mockStripe.checkout.sessions.expire.mockResolvedValue({});
    expect(await closeCheckoutSession("cs_1")).toBe(true);
    expect(mockStripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_1");
    expect(mockPrisma.listing.updateMany).toHaveBeenCalledWith({
      where: { reservedCheckoutSessionId: "cs_1" },
      data: { reservedById: null, reservedUntil: null, reservedCheckoutSessionId: null },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it("keeps the hold when the buyer already paid", async () => {
    mockStripe.checkout.sessions.expire.mockRejectedValue(new Error("not open"));
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({ status: "complete" });
    expect(await closeCheckoutSession("cs_1")).toBe(false);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("releases a session Stripe already expired", async () => {
    mockStripe.checkout.sessions.expire.mockRejectedValue(new Error("not open"));
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({ status: "expired" });
    expect(await closeCheckoutSession("cs_1")).toBe(true);
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it("releases a session this Stripe key doesn't know (made in the other mode)", async () => {
    mockStripe.checkout.sessions.expire.mockRejectedValue(
      Object.assign(new Error("No such checkout.session"), { code: "resource_missing" })
    );
    expect(await closeCheckoutSession("cs_live_x")).toBe(true);
    expect(mockStripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });

  it("rethrows when the session is still open but expire failed", async () => {
    mockStripe.checkout.sessions.expire.mockRejectedValue(new Error("Stripe down"));
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({ status: "open" });
    await expect(closeCheckoutSession("cs_1")).rejects.toThrow("Stripe down");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("closeLapsedCheckouts", () => {
  it("closes each lapsed session once and returns listings that are still not free", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([
      { id: "a", reservedCheckoutSessionId: "cs_cart" },
      { id: "b", reservedCheckoutSessionId: "cs_cart" },
      { id: "c", reservedCheckoutSessionId: "cs_paid" },
      { id: "d", reservedCheckoutSessionId: "cs_down" },
    ]);
    mockStripe.checkout.sessions.expire.mockImplementation(async (id: string) => {
      if (id !== "cs_cart") throw new Error("not open");
    });
    mockStripe.checkout.sessions.retrieve.mockImplementation(async (id: string) => ({
      status: id === "cs_paid" ? "complete" : "open",
    }));

    expect(await closeLapsedCheckouts(["a", "b", "c", "d"])).toEqual(["c", "d"]);
    expect(mockStripe.checkout.sessions.expire).toHaveBeenCalledTimes(3);
    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ reservedUntil: { lt: expect.any(Date) } }],
          reservedCheckoutSessionId: { not: null },
          id: { in: ["a", "b", "c", "d"] },
        }),
      })
    );
  });

  it("with a buyerId, also closes that buyer's own active holds", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([{ id: "a", reservedCheckoutSessionId: "cs_mine" }]);
    mockStripe.checkout.sessions.expire.mockResolvedValue({});

    expect(await closeLapsedCheckouts(["a"], "buyer-1")).toEqual([]);
    expect(mockStripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_mine");
    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ reservedUntil: { lt: expect.any(Date) } }, { reservedById: "buyer-1" }],
        }),
      })
    );
  });
});
