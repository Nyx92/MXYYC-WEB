import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/user/verify/phone/request — sends a 6-digit code to whatever
 * phone number is already on the account (set via PUT /api/user in Edit
 * Profile, not here — see src/__tests__/api/user/route.test.ts for that
 * flow, which resets phoneVerified when the number changes).
 */

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockSendSms = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const mockCheckRateLimit = vi.hoisted(() => vi.fn().mockReturnValue({ allowed: true }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/sms", () => ({ sendSms: mockSendSms }));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: () => "unknown",
}));

import { POST } from "@/app/api/user/verify/phone/request/route";

function postRequest() {
  return new Request("http://localhost/api/user/verify/phone/request", { method: "POST" }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockGetServerSession.mockResolvedValue({ user: { id: "user-1" } });
  mockSendSms.mockResolvedValue({ success: true });
  mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: "+6591234567", phoneVerified: false });
});

describe("POST /api/user/verify/phone/request", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
  });

  it("returns 429 when the per-user rate limit is exceeded", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const res = await POST(postRequest());
    expect(res.status).toBe(429);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("returns 400 when there's no phone number on file", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: null, phoneVerified: false });
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/edit profile/i) });
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("short-circuits when already verified", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: "+6591234567", phoneVerified: true });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("sends a code to the number already on file", async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(200);

    const updateArgs = mockPrisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "user-1" });
    expect(updateArgs.data.phoneVerificationCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updateArgs.data.phoneVerificationAttempts).toBe(0);

    expect(mockSendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+6591234567" })
    );
  });

  it("normalizes a legacy number stored without a leading +", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: "6591234567", phoneVerified: false });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mockSendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+6591234567" })
    );
  });

  it("returns 502 when the SMS fails to send", async () => {
    mockSendSms.mockResolvedValue({ success: false, error: "Twilio down" });
    const res = await POST(postRequest());
    expect(res.status).toBe(502);
  });
});
