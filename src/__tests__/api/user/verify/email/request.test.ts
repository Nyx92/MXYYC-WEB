import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/user/verify/email/request — sends a 6-digit code to the
 * signed-in user's email, storing only its hash + expiry (mirrors the
 * forgot-password flow's token-hash-only storage).
 */

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
}));
const mockGetServerSession = vi.hoisted(() => vi.fn());
const mockSendEmail = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
const mockCheckRateLimit = vi.hoisted(() => vi.fn().mockReturnValue({ allowed: true }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
  buildEmailVerificationCodeEmail: vi.fn().mockReturnValue("<html></html>"),
}));
vi.mock("@/lib/rateLimit", () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: () => "unknown",
}));

import { POST } from "@/app/api/user/verify/email/request/route";

function postRequest() {
  return new Request("http://localhost/api/user/verify/email/request", { method: "POST" }) as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockGetServerSession.mockResolvedValue({ user: { id: "user-1" } });
  mockSendEmail.mockResolvedValue({ success: true });
});

describe("POST /api/user/verify/email/request", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
  });

  it("returns 429 when the per-user rate limit is exceeded", async () => {
    mockCheckRateLimit.mockReturnValueOnce({ allowed: false });
    const res = await POST(postRequest());
    expect(res.status).toBe(429);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("short-circuits with a friendly message when already verified", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ email: "ash@example.com", emailVerified: new Date() });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("stores a code hash + expiry and emails the code", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ email: "ash@example.com", emailVerified: null });

    const res = await POST(postRequest());
    expect(res.status).toBe(200);

    const updateArgs = mockPrisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "user-1" });
    // 64 hex chars = SHA-256 digest length — never the raw code itself.
    expect(updateArgs.data.emailVerificationCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updateArgs.data.emailVerificationCodeExpiresAt).toBeInstanceOf(Date);
    expect(updateArgs.data.emailVerificationAttempts).toBe(0);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe("ash@example.com");
  });

  it("returns 502 when the email fails to send", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ email: "ash@example.com", emailVerified: null });
    mockSendEmail.mockResolvedValue({ success: false, error: "Resend down" });

    const res = await POST(postRequest());
    expect(res.status).toBe(502);
  });
});
