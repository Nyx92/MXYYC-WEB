import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockPrisma = vi.hoisted(() => ({ listing: { findMany: vi.fn() } }));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockCloseCheckoutSession = vi.hoisted(() => vi.fn());
const mockRateLimitResponse = vi.hoisted(() => vi.fn((): Response | null => null));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rateLimit", () => ({ rateLimitResponse: mockRateLimitResponse }));
vi.mock("@/lib/checkoutSessions", () => ({ closeCheckoutSession: mockCloseCheckoutSession }));

import { POST } from "@/app/api/checkout/cancel/route";

const req = (body?: object) =>
  new NextRequest("http://localhost/api/checkout/cancel", {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetServerSession.mockResolvedValue({ user: { id: "buyer-1" } });
});

describe("POST /api/checkout/cancel", () => {
  it("returns 401 when not signed in", async () => {
    mockGetServerSession.mockResolvedValue(null);
    expect((await POST(req())).status).toBe(401);
    expect(mockPrisma.listing.findMany).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    mockRateLimitResponse.mockReturnValueOnce(new Response(null, { status: 429 }));
    expect((await POST(req())).status).toBe(429);
  });

  it("only closes the signed-in buyer's checkout for the given card", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([{ reservedCheckoutSessionId: "cs_1" }]);
    mockCloseCheckoutSession.mockResolvedValue(true);

    const res = await POST(req({ cardId: "card-1" }));
    expect(await res.json()).toEqual({ released: 1, paid: false });
    expect(mockPrisma.listing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reservedById: "buyer-1", reservedCheckoutSessionId: { not: null }, id: "card-1" },
      })
    );
  });

  it("closes a cart session once and reports a payment that already went through", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([
      { reservedCheckoutSessionId: "cs_cart" },
      { reservedCheckoutSessionId: "cs_cart" },
      { reservedCheckoutSessionId: "cs_paid" },
    ]);
    mockCloseCheckoutSession.mockImplementation(async (id: string) => id !== "cs_paid");

    const res = await POST(req());
    expect(await res.json()).toEqual({ released: 1, paid: true });
    expect(mockCloseCheckoutSession).toHaveBeenCalledTimes(2);
  });

  it("keeps closing other sessions when one fails", async () => {
    mockPrisma.listing.findMany.mockResolvedValue([
      { reservedCheckoutSessionId: "cs_broken" },
      { reservedCheckoutSessionId: "cs_ok" },
    ]);
    mockCloseCheckoutSession.mockImplementation(async (id: string) => {
      if (id === "cs_broken") throw new Error("Stripe down");
      return true;
    });

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ released: 1, paid: false });
  });
});
