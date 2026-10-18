import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/user/verify/email/confirm — verifies the code sent by
 * POST /api/user/verify/email/request. Uses the real verificationCode
 * helpers (pure crypto, no reason to mock) so the hash comparison here
 * matches production exactly.
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

import { POST } from "@/app/api/user/verify/email/confirm/route";
import { hashVerificationCode } from "@/lib/verificationCode";

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/user/verify/email/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  }) as any;
}

const CODE = "482910";
const CODE_HASH = hashVerificationCode(CODE);

beforeEach(() => {
  mockPrisma.user.updateMany.mockResolvedValue({ count: 1 });
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockGetServerSession.mockResolvedValue({ user: { id: "user-1" } });
});

describe("POST /api/user/verify/email/confirm", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(401);
  });

  it("returns 429 when the rate limit is exceeded", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(429);
  });

  it("returns 400 when no code was requested", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerificationCodeHash: null,
      emailVerificationCodeExpiresAt: null,
      emailVerificationAttempts: 0,
    });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the code has expired", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerificationCodeHash: CODE_HASH,
      emailVerificationCodeExpiresAt: new Date(Date.now() - 1000),
      emailVerificationAttempts: 0,
    });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/expired/i) });
  });

  it("returns 400 and increments attempts on a wrong code", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerificationCodeHash: CODE_HASH,
      emailVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      emailVerificationAttempts: 0,
    });
    const res = await POST(postRequest({ code: "000000" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { emailVerificationAttempts: { increment: 1 } },
    });
  });

  it("returns 400 once the attempt cap is reached, without checking the code", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerificationCodeHash: CODE_HASH,
      emailVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      emailVerificationAttempts: 5,
    });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/too many/i) });
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 409 when the email changed (code cleared) between the check and the write", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerificationCodeHash: CODE_HASH,
      emailVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      emailVerificationAttempts: 0,
    });
    mockPrisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(409);
  });

  it("verifies the email and clears the code on a correct match", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      emailVerificationCodeHash: CODE_HASH,
      emailVerificationCodeExpiresAt: new Date(Date.now() + 60_000),
      emailVerificationAttempts: 2,
    });
    const res = await POST(postRequest({ code: CODE }));
    expect(res.status).toBe(200);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", emailVerificationCodeHash: CODE_HASH },
      data: {
        emailVerified: expect.any(Date),
        emailVerificationCodeHash: null,
        emailVerificationCodeExpiresAt: null,
        emailVerificationAttempts: 0,
      },
    });
  });
});
