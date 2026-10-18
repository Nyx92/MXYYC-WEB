import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/auth/forgot-password — always returns the same generic message,
 * whether or not the email matches an account, so the endpoint can't be used
 * to enumerate registered emails. Only sends a real reset email (and only
 * stamps a token onto the user row) when the email matches a credentials
 * account (one that actually has a password to reset).
 */

const mockPrisma = vi.hoisted(() => ({
  user: { findFirst: vi.fn(), update: vi.fn(), count: vi.fn() },
}));

const mockSendEmailAsync = vi.hoisted(() => vi.fn());
const mockBuildPasswordResetEmail = vi.hoisted(() => vi.fn().mockReturnValue("<html></html>"));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/email", () => ({
  sendEmailAsync: mockSendEmailAsync,
  buildPasswordResetEmail: mockBuildPasswordResetEmail,
}));

import { POST } from "@/app/api/auth/forgot-password/route";

function postRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/auth/forgot-password", () => {
  it("returns 400 when email is missing", async () => {
    const res = await POST(postRequest({}) as any);
    expect(res.status).toBe(400);
  });

  it("returns the generic message, does a dummy DB op, and sends no email when the address doesn't match any account", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);

    const res = await POST(postRequest({ email: "nobody@example.com" }) as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toMatch(/if an account exists/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockSendEmailAsync).not.toHaveBeenCalled();
    // Equalizes timing with the found-user branch's extra awaited DB write —
    // without this, a faster response would itself leak that the email
    // isn't registered.
    expect(mockPrisma.user.count).toHaveBeenCalledTimes(1);
  });

  it("returns the same generic message, does a dummy DB op, and sends no email for a Google-only account (no password set)", async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: "user-1", password: null });

    const res = await POST(postRequest({ email: "google-user@example.com" }) as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toMatch(/if an account exists/i);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockSendEmailAsync).not.toHaveBeenCalled();
    expect(mockPrisma.user.count).toHaveBeenCalledTimes(1);
  });

  it("stores a token hash + expiry and emails a reset link for a real credentials account", async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: "user-1", password: "hashed" });

    const res = await POST(postRequest({ email: "ash@example.com" }) as any);
    expect(res.status).toBe(200);

    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.count).not.toHaveBeenCalled();
    const updateArgs = mockPrisma.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "user-1" });
    // 64 hex chars = SHA-256 digest length — never the raw token itself.
    expect(updateArgs.data.passwordResetTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updateArgs.data.passwordResetTokenExpiresAt).toBeInstanceOf(Date);
    expect(updateArgs.data.passwordResetTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(mockSendEmailAsync).toHaveBeenCalledTimes(1);
    const emailArgs = mockSendEmailAsync.mock.calls[0][0];
    expect(emailArgs.to).toBe("ash@example.com");
    // The emailed link must carry the raw token, not the stored hash.
    const resetUrl = mockBuildPasswordResetEmail.mock.calls[0][0];
    expect(resetUrl).toContain("uid=user-1");
    expect(resetUrl).toMatch(/token=[0-9a-f]{64}/);
    expect(resetUrl).not.toContain(updateArgs.data.passwordResetTokenHash);
  });

  it("looks the user up case-insensitively so legacy mixed-case accounts still match", async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    await POST(postRequest({ email: " Ash@Example.com " }) as any);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: "Ash@Example.com", mode: "insensitive" } },
      select: { id: true, password: true },
    });
  });

  it("stops sending after 3 requests per target email but keeps the same generic response", async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: "user-9", password: "hashed" });
    for (let i = 0; i < 4; i++) {
      const res = await POST(
        postRequest({ email: "Flooded@example.com" }, { "x-forwarded-for": `10.0.0.${i}` }) as any
      );
      expect(res.status).toBe(200);
    }
    expect(mockSendEmailAsync).toHaveBeenCalledTimes(3);
  });

  it("returns 500 on unexpected DB error", async () => {
    mockPrisma.user.findFirst.mockRejectedValue(new Error("DB down"));

    const res = await POST(postRequest({ email: "ash@example.com" }) as any);
    expect(res.status).toBe(500);
  });
});
