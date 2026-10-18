import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/user/verify/phone/confirm — mirrors
 * src/__tests__/api/user/verify/email/confirm.test.ts; see that file for
 * the rationale behind using the real verificationCode helpers.
 */

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockCheckRateLimit = vi.hoisted(() => vi.fn().mockReturnValue({ allowed: true }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: mockCheckRateLimit }));

import { POST } from "@/app/api/user/verify/phone/confirm/route";
import { hashVerificationCode } from "@/lib/verificationCode";

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/user/verify/phone/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  }) as any;
}

const CODE = "719284";
const CODE_HASH = hashVerificationCode(CODE);

beforeEach(() => {
  mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockGetServerSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST /api/user/verify/phone/confirm", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(401);
  });

  it("returns 400 and increments attempts on a wrong code", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      phoneVerificationCodeHash: CODE_HASH,
      phoneVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      phoneVerificationAttempts: 0,
    });
    const res = await POST(postRequest({ code: "000000" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { phoneVerificationAttempts: { increment: 1 } },
    });
  });

  it("returns 409 when the phone changed (code cleared) between the check and the write", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      phoneVerificationCodeHash: CODE_HASH,
      phoneVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      phoneVerificationAttempts: 0,
    });
    mockPrisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(409);
  });

  it("verifies the phone number and clears the code on a correct match", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      phoneVerificationCodeHash: CODE_HASH,
      phoneVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      phoneVerificationAttempts: 1,
    });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(200);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", phoneVerificationCodeHash: CODE_HASH },
      data: {
        phoneVerified: true,
        phoneVerificationCodeHash: null,
        phoneVerificationCodeExpiresAt: null,
        phoneVerificationAttempts: 0,
      },
    });
  });

  it("returns 400 once the attempt cap is reached", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      phoneVerificationCodeHash: CODE_HASH,
      phoneVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      phoneVerificationAttempts: 5,
    });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
