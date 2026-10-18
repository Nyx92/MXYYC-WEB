import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * authOptions.callbacks.jwt — every non-login use of the token re-reads the
 * user's role + password fingerprint from the DB. A changed password (reset)
 * or a deleted user throws, which NextAuth turns into a cleared session; a
 * changed role is picked up immediately instead of after 30 days.
 */

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@next-auth/prisma-adapter", () => ({ PrismaAdapter: vi.fn(() => ({})) }));

import { authOptions } from "@/lib/auth";

const jwt = authOptions.callbacks!.jwt! as (args: any) => Promise<any>;

beforeEach(() => vi.clearAllMocks());

describe("jwt callback revalidation", () => {
  it("stamps a password fingerprint at login and keeps the session while it matches", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: "user", password: "hash-1" });
    const token = await jwt({ token: {}, user: { id: "u1", email: "a@b.c", role: "user" } });
    expect(token.pwv).toMatch(/^[0-9a-f]{16}$/);

    const next = await jwt({ token });
    expect(next.id).toBe("u1");
  });

  it("revokes the session after a password reset", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: "user", password: "hash-1" });
    const token = await jwt({ token: {}, user: { id: "u1", email: "a@b.c", role: "user" } });

    mockPrisma.user.findUnique.mockResolvedValue({ role: "user", password: "hash-2" });
    await expect(jwt({ token })).rejects.toThrow(/revoked/i);
  });

  it("revokes the session when the user no longer exists", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    await expect(jwt({ token: { id: "u1", pwv: "x" } })).rejects.toThrow(/revoked/i);
  });

  it("picks up a role change (e.g. admin demoted) on the next request", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: "admin", password: "hash-1" });
    const token = await jwt({ token: {}, user: { id: "u1", email: "a@b.c", role: "admin" } });
    mockPrisma.user.findUnique.mockResolvedValue({ role: "user", password: "hash-1" });
    const next = await jwt({ token });
    expect(next.role).toBe("user");
  });

  it("rejects legacy tokens that carry no password fingerprint", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: "user", password: "hash-1" });
    await expect(jwt({ token: { id: "u1", role: "user" } })).rejects.toThrow(/revoked/i);
  });

  it("keeps the session on a transient DB error instead of signing the user out", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ role: "user", password: "hash-1" });
    const token = await jwt({ token: {}, user: { id: "u1", email: "a@b.c", role: "user" } });
    mockPrisma.user.findUnique.mockRejectedValueOnce(new Error("pool timeout"));
    await expect(jwt({ token })).resolves.toMatchObject({ id: "u1" });
  });
});
