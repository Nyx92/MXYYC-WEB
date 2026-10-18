import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for /api/user (POST signup, PUT profile update).
 *
 * Note on password length: a parallel hardening task may raise the minimum
 * password length from 6 to 10 characters. To stay valid either way, the
 * "too short" cases below use a password well below either threshold, and
 * the "valid" cases use one well above either threshold.
 */

// ── STEP 1: Create mock objects ───────────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  user: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

const mockBcryptHash = vi.hoisted(() => vi.fn().mockResolvedValue("hashed-password"));
const mockBcryptCompare = vi.hoisted(() => vi.fn().mockResolvedValue(false));

// ── STEP 2: Register fakes ────────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("bcryptjs", () => ({ default: { hash: mockBcryptHash, compare: mockBcryptCompare } }));

// ── STEP 3: Import code under test ────────────────────────────────────────────

import { POST, PUT } from "@/app/api/user/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function postRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/user", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function putRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/user", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

const VALID_SIGNUP = {
  firstName: "Ash",
  lastName: "Ketchum",
  username: "ashketchum",
  email: "ash@example.com",
  password: "pikachu-secure-1",
  country: "SG",
  sex: "M",
  dob: "2000-01-01",
  address: "1 Pallet Town",
  phoneNumber: "12345678",
};

const SESSION = { user: { id: "user-1" } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/user (signup)", () => {
  it("creates a new user with a valid email/username/password", async () => {
    mockPrisma.user.create.mockResolvedValue({
      id: "user-1",
      firstName: "Ash",
      lastName: "Ketchum",
      username: "ashketchum",
      email: "ash@example.com",
      country: "SG",
      sex: "M",
      dob: new Date("2000-01-01"),
      address: "1 Pallet Town",
      phoneNumber: "12345678",
      verified: false,
      role: "user",
    });

    const res = await POST(postRequest(VALID_SIGNUP));
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.email).toBe("ash@example.com");

    expect(mockBcryptHash).toHaveBeenCalledWith(VALID_SIGNUP.password, 10);
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "ash@example.com",
          username: "ashketchum",
          password: "hashed-password",
          role: "user",
          verified: false,
        }),
      })
    );
  });

  it("stores the email trimmed and lowercased", async () => {
    mockPrisma.user.create.mockResolvedValue({ id: "user-1" });
    await POST(postRequest({ ...VALID_SIGNUP, email: " Ash@Example.COM " }));
    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ email: "ash@example.com" }) })
    );
  });

  it("stores the phone number normalized to E.164 (form sends digits only)", async () => {
    mockPrisma.user.create.mockResolvedValue({ id: "user-1" });
    const res = await POST(postRequest({ ...VALID_SIGNUP, phoneNumber: "6591234567" }));
    expect(res.status).toBe(201);
    expect(mockPrisma.user.create.mock.calls.at(-1)![0].data.phoneNumber).toBe("+6591234567");
  });

  it("returns 400 for an invalid phone number", async () => {
    const res = await POST(postRequest({ ...VALID_SIGNUP, phoneNumber: "abc" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-string (numeric) phone number", async () => {
    const res = await POST(postRequest({ ...VALID_SIGNUP, phoneNumber: 6591234567 }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("returns 400 when email or password is missing", async () => {
    const res = await POST(postRequest({ email: "", password: "" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects a password that is too short", async () => {
    const res = await POST(postRequest({ ...VALID_SIGNUP, password: "ab" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/password/i);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("returns 409 on duplicate email (P2002 on email)", async () => {
    mockPrisma.user.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["email"] },
    });

    const res = await POST(postRequest(VALID_SIGNUP));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it("returns 409 on duplicate username (P2002 on username)", async () => {
    mockPrisma.user.create.mockRejectedValue({
      code: "P2002",
      meta: { target: ["username"] },
    });

    const res = await POST(postRequest(VALID_SIGNUP));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/username/i);
  });

  it("returns 500 on an unexpected error", async () => {
    mockPrisma.user.create.mockRejectedValue(new Error("db exploded"));

    const res = await POST(postRequest(VALID_SIGNUP));
    expect(res.status).toBe(500);
  });
});

describe("PUT /api/user (profile update)", () => {
  beforeEach(() => {
    mockGetServerSession.mockResolvedValue(SESSION);
    // The PUT handler compares against the DB's current email to decide
    // whether to reset emailVerified — default to a different address so
    // most tests (which submit a new email) exercise that path.
    mockPrisma.user.findUnique.mockResolvedValue({ email: "old@example.com" });
  });

  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const res = await PUT(putRequest({ email: "new@example.com" }));
    expect(res.status).toBe(401);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("returns 400 when email is missing", async () => {
    const res = await PUT(putRequest({ firstName: "Ash" }));
    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it("updates the current session user's profile", async () => {
    mockPrisma.user.update.mockResolvedValue({
      id: "user-1",
      firstName: "Ash",
      lastName: "Ketchum",
      username: "ashketchum",
      email: "new@example.com",
      country: "SG",
      sex: "M",
      dob: null,
      address: "1 Pallet Town",
      phoneNumber: "12345678",
      verified: false,
      role: "user",
    });

    const res = await PUT(putRequest({ email: "new@example.com", firstName: "Ash" }));
    expect(res.status).toBe(200);

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } })
    );

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.user.email).toBe("new@example.com");
  });

  describe("email change on a credentials account", () => {
    beforeEach(() => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: "old@example.com", password: "stored-hash" });
      mockPrisma.user.update.mockClear();
    });

    it("returns 403 without the current password", async () => {
      const res = await PUT(putRequest({ email: "attacker@example.com" }));
      expect(res.status).toBe(403);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("returns 403 with a wrong current password", async () => {
      mockBcryptCompare.mockResolvedValueOnce(false);
      const res = await PUT(putRequest({ email: "attacker@example.com", currentPassword: "nope" }));
      expect(res.status).toBe(403);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("allows the change with the correct current password", async () => {
      mockBcryptCompare.mockResolvedValueOnce(true);
      mockPrisma.user.update.mockResolvedValue({ id: "user-1", email: "new@example.com" });
      const res = await PUT(putRequest({ email: "new@example.com", currentPassword: "right" }));
      expect(res.status).toBe(200);
      expect(mockBcryptCompare).toHaveBeenCalledWith("right", "stored-hash");
    });

    it("treats a case-only difference from a legacy mixed-case email as unchanged", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: "Old@Example.com", password: "stored-hash" });
      mockPrisma.user.update.mockResolvedValue({ id: "user-1", email: "old@example.com" });
      const res = await PUT(putRequest({ email: "OLD@example.com", firstName: "Ash" }));
      expect(res.status).toBe(200);
      expect(mockBcryptCompare).not.toHaveBeenCalled();
      expect(mockPrisma.user.update.mock.calls[0][0].data.email).toBe("old@example.com");
    });

    it("does not ask for a password when the email is unchanged", async () => {
      mockPrisma.user.update.mockResolvedValue({ id: "user-1", email: "old@example.com" });
      const res = await PUT(putRequest({ email: "old@example.com", firstName: "Ash" }));
      expect(res.status).toBe(200);
    });
  });

  it("returns 409 when the new email is already in use (P2002)", async () => {
    mockPrisma.user.update.mockRejectedValue({ code: "P2002" });

    const res = await PUT(putRequest({ email: "taken@example.com" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it("returns 409 naming the username when the username is taken (P2002 on username)", async () => {
    mockPrisma.user.update.mockRejectedValue({ code: "P2002", meta: { target: ["username"] } });
    const res = await PUT(putRequest({ email: "old@example.com", username: "taken" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/username/i);
  });

  it("returns 500 on an unexpected error", async () => {
    mockPrisma.user.update.mockRejectedValue(new Error("db exploded"));
    const res = await PUT(putRequest({ email: "new@example.com" }));
    expect(res.status).toBe(500);
  });

  describe("phone number", () => {
    it("returns 400 for a malformed phone number", async () => {
      const res = await PUT(putRequest({ email: "old@example.com", phoneNumber: "91234567" })); // missing "+"
      expect(res.status).toBe(400);
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });

    it("resets phoneVerified when the number changes", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: "old@example.com", phoneNumber: "+6591111111" });
      mockPrisma.user.update.mockResolvedValue({ id: "user-1" });

      await PUT(putRequest({ email: "old@example.com", phoneNumber: "+6592222222" }));

      const updateArgs = mockPrisma.user.update.mock.calls[0][0];
      expect(updateArgs.data.phoneNumber).toBe("+6592222222");
      expect(updateArgs.data.phoneVerified).toBe(false);
      expect(updateArgs.data.phoneVerificationCodeHash).toBeNull();
    });

    it("leaves phoneVerified untouched when the number is unchanged", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: "old@example.com", phoneNumber: "+6591111111" });
      mockPrisma.user.update.mockResolvedValue({ id: "user-1" });

      await PUT(putRequest({ email: "old@example.com", phoneNumber: "+6591111111" }));

      const updateArgs = mockPrisma.user.update.mock.calls[0][0];
      expect(updateArgs.data.phoneVerified).toBeUndefined();
    });

    it("leaves phoneNumber untouched when the field is omitted entirely", async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ email: "old@example.com", phoneNumber: "+6591111111" });
      mockPrisma.user.update.mockResolvedValue({ id: "user-1" });

      await PUT(putRequest({ email: "old@example.com", firstName: "Ash" }));

      const updateArgs = mockPrisma.user.update.mock.calls[0][0];
      expect(updateArgs.data).not.toHaveProperty("phoneNumber");
      expect(updateArgs.data.phoneVerified).toBeUndefined();
    });
  });
});
