import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/cards
 *
 * Lets an admin create a card and assign it to ANY user (an admin tool for
 * listing cards on behalf of sellers — the `ownerId` field is deliberately
 * client-supplied so an admin can pick any user from a dropdown). Because
 * ownerId is trusted input, this route must be restricted to admins only.
 *
 * The route now creates a Listing pointed at a PokemonCardCatalog row
 * (found-or-created by tcgPlayerId) instead of storing identity fields
 * directly on the card row.
 *
 * Tests cover:
 *   - 401 unauthenticated
 *   - 403 authenticated but not an admin
 *   - 201 admin can still create a card (happy path, proves the auth gate
 *     doesn't break the legitimate flow), reusing an existing catalog row
 *   - creates a new catalog row when no existing one matches
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────

const mockPrisma = vi.hoisted(() => ({
  listing: { create: vi.fn() },
  pokemonCardCatalog: { upsert: vi.fn() },
  riftboundCardCatalog: { upsert: vi.fn() },
  user: { findUnique: vi.fn() },
}));

const mockSupabaseInstance = vi.hoisted(() => ({
  storage: {
    from: vi.fn(() => ({
      upload: vi.fn().mockResolvedValue({ data: { path: "cards/1-test.png" }, error: null }),
      getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: "https://example.com/cards/1-test.png" } }),
    })),
  },
}));

const mockGetServerSession = vi.hoisted(() => vi.fn());

// ── STEP 2: Register the fakes ────────────────────────────────────────────────

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("next-auth", () => ({ getServerSession: mockGetServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabaseInstance),
}));
// Compression is covered by imageProcessing's own tests — stub it here so
// these tests can post fake, non-decodable image bytes through the route.
vi.mock("@/lib/imageProcessing", () => ({
  compressCardImage: vi.fn(async (input: Buffer) => ({ buffer: input, contentType: "image/webp" })),
}));

// ── STEP 3: Import the code under test ───────────────────────────────────────

import { POST } from "@/app/api/cards/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("game", "POKEMON");
  fd.set("title", "Charizard");
  fd.set("condition", "NM");
  fd.set("ownerId", "target-user-1");
  fd.set("tcgPlayerId", "tcg-1");
  fd.set("language", "English");
  fd.set("forSale", "true");
  fd.set("price", "50.00");
  fd.append("images", new File(["fake"], "card.png", { type: "image/png" }));
  Object.entries(overrides).forEach(([k, v]) => fd.set(k, v));
  return fd;
}

function buildRiftboundFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("game", "RIFTBOUND");
  fd.set("title", "Vi - Peacekeeper");
  fd.set("condition", "NM");
  fd.set("ownerId", "target-user-1");
  fd.set("tcgPlayerId", "rift-tcg-1");
  fd.set("setName", "Unleashed");
  fd.set("rarity", "Rare");
  fd.set("cardNumber", "176");
  fd.set("type", "Unit");
  fd.set("supertype", "Champion");
  fd.set("forSale", "true");
  fd.set("price", "50.00");
  fd.append("images", new File(["fake"], "card.png", { type: "image/png" }));
  Object.entries(overrides).forEach(([k, v]) => fd.set(k, v));
  return fd;
}

function postRequest(formData: FormData) {
  return new NextRequest("http://localhost/api/cards", {
    method: "POST",
    body: formData,
  });
}

const ADMIN_SESSION = { user: { id: "admin-1", role: "admin" } };
const USER_SESSION = { user: { id: "user-1", role: "user" } };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the requested owner exists — POST /api/cards verifies this
  // before creating a listing (see route.ts). Individual tests can
  // override with mockResolvedValue(null) to exercise the 400 path.
  mockPrisma.user.findUnique.mockResolvedValue({ id: "owner-1" });
});

describe("POST /api/cards", () => {
  it("returns 401 when not authenticated", async () => {
    mockGetServerSession.mockResolvedValue(null);
    const res = await POST(postRequest(buildFormData()));
    expect(res.status).toBe(401);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated but not an admin", async () => {
    mockGetServerSession.mockResolvedValue(USER_SESSION);
    const res = await POST(postRequest(buildFormData()));
    expect(res.status).toBe(403);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });

  it("returns 400 when forSale is true and price is zero (mirrors PUT)", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await POST(postRequest(buildFormData({ price: "0" })));
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });

  it("returns 400 when the selected owner does not exist", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await POST(postRequest(buildFormData({ ownerId: "ghost-user" })));
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });

  it("lets an admin create a card owned by a different user, reusing an existing catalog row", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrisma.pokemonCardCatalog.upsert.mockResolvedValue({ id: "catalog-1", tcgPlayerId: "tcg-1" });
    mockPrisma.listing.create.mockResolvedValue({
      id: "listing-1",
      ownerId: "target-user-1",
      pokemonCard: {
        nameEn: "Charizard",
        rarity: "Rare Holo",
        setNameEn: "Base Set",
        language: "English",
        localId: "004",
        tcgPlayerId: "tcg-1",
      },
      riftboundCard: null,
    });

    const res = await POST(postRequest(buildFormData()));
    expect(res.status).toBe(200);

    expect(mockPrisma.pokemonCardCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tcgPlayerId: "tcg-1" }, update: {} })
    );

    // The admin's own id must NOT silently override the chosen ownerId —
    // this route intentionally lets an admin assign the card to anyone.
    expect(mockPrisma.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          game: "POKEMON",
          pokemonCardId: "catalog-1",
          ownerId: "target-user-1",
        }),
      })
    );

    // Regression guard: the response must include resolved catalog display
    // fields, not just the raw Listing row — the admin upload UI reads
    // data.card.title directly for its success message.
    const body = await res.json();
    expect(body.card.title).toBe("Charizard");
  });

  it("creates a new catalog row when no existing one matches the submitted tcgPlayerId", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrisma.pokemonCardCatalog.upsert.mockResolvedValue({ id: "catalog-new" });
    mockPrisma.listing.create.mockResolvedValue({
      id: "listing-1",
      ownerId: "target-user-1",
      pokemonCard: {
        nameEn: "Charizard",
        rarity: "Rare Holo",
        setNameEn: "Base Set",
        language: "English",
        localId: "004",
        tcgPlayerId: "tcg-1",
      },
      riftboundCard: null,
    });

    const res = await POST(postRequest(buildFormData()));
    expect(res.status).toBe(200);

    expect(mockPrisma.pokemonCardCatalog.upsert).toHaveBeenCalled();
    expect(mockPrisma.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ pokemonCardId: "catalog-new" }),
      })
    );
  });

  it("creates a RIFTBOUND listing, reusing an existing catalog row matched by tcgPlayerId", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrisma.riftboundCardCatalog.upsert.mockResolvedValue({ id: "rbc-1", tcgPlayerId: "rift-tcg-1" });
    mockPrisma.listing.create.mockResolvedValue({
      id: "listing-2",
      ownerId: "target-user-1",
      pokemonCard: null,
      riftboundCard: {
        name: "Vi - Peacekeeper",
        rarity: "Rare",
        setLabel: "Unleashed",
        collectorNumber: "176",
        tcgPlayerId: "rift-tcg-1",
        type: "Unit",
        supertype: "Champion",
      },
    });

    const res = await POST(postRequest(buildRiftboundFormData()));
    expect(res.status).toBe(200);

    expect(mockPrisma.riftboundCardCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tcgPlayerId: "rift-tcg-1" }, update: {} })
    );
    expect(mockPrisma.pokemonCardCatalog.upsert).not.toHaveBeenCalled();

    expect(mockPrisma.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          game: "RIFTBOUND",
          riftboundCardId: "rbc-1",
          ownerId: "target-user-1",
        }),
      })
    );

    const body = await res.json();
    expect(body.card.title).toBe("Vi - Peacekeeper");
  });

  it("creates a new RIFTBOUND catalog row when no existing one matches the submitted tcgPlayerId", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    mockPrisma.riftboundCardCatalog.upsert.mockResolvedValue({ id: "rbc-new" });
    mockPrisma.listing.create.mockResolvedValue({
      id: "listing-2",
      ownerId: "target-user-1",
      pokemonCard: null,
      riftboundCard: {
        name: "Vi - Peacekeeper",
        rarity: "Rare",
        setLabel: "Unleashed",
        collectorNumber: "176",
        tcgPlayerId: "rift-tcg-1",
        type: "Unit",
        supertype: "Champion",
      },
    });

    const res = await POST(postRequest(buildRiftboundFormData()));
    expect(res.status).toBe(200);

    expect(mockPrisma.riftboundCardCatalog.upsert).toHaveBeenCalled();
    expect(mockPrisma.listing.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ riftboundCardId: "rbc-new" }),
      })
    );
  });

  it("returns 400 for an unknown RIFTBOUND type", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await POST(postRequest(buildRiftboundFormData({ type: "Trap" })));
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });

  it("returns 400 when the supertype doesn't belong to the given RIFTBOUND type", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    // Champion only belongs to Unit/Legend, not Gear.
    const res = await POST(postRequest(buildRiftboundFormData({ type: "Gear", supertype: "Champion" })));
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });

  it("returns 400 for an unrecognized game value", async () => {
    mockGetServerSession.mockResolvedValue(ADMIN_SESSION);
    const res = await POST(postRequest(buildFormData({ game: "MAGIC" })));
    expect(res.status).toBe(400);
    expect(mockPrisma.listing.create).not.toHaveBeenCalled();
  });
});
