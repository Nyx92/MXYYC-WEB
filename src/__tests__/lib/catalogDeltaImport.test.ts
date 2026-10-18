import { describe, it, expect, vi, beforeEach } from "vitest";
import { importCatalogDelta } from "@/lib/catalogDeltaImport";

const mockPrisma = {
  pokemonCardCatalog: { upsert: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  riftboundCardCatalog: { upsert: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
} as any;

beforeEach(() => vi.clearAllMocks());

describe("importCatalogDelta", () => {
  it("upserts each Pokemon card by externalId, mapping delta fields to catalog columns", async () => {
    mockPrisma.pokemonCardCatalog.upsert.mockResolvedValue({});
    mockPrisma.pokemonCardCatalog.findUnique.mockResolvedValue({ id: "existing" });
    const result = await importCatalogDelta(mockPrisma, {
      game: "POKEMON",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [{
        externalId: "swsh3-136", tcgPlayerId: "192391", name: "Charizard VMAX",
        language: "English", imageUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp",
        setNameEn: "Darkness Ablaze", rarity: "Secret Rare", setId: "swsh3", localId: "136",
      }],
    });

    expect(mockPrisma.pokemonCardCatalog.upsert).toHaveBeenCalledWith({
      where: { externalId: "swsh3-136" },
      update: expect.objectContaining({ nameEn: "Charizard VMAX", imageUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp" }),
      create: expect.objectContaining({ externalId: "swsh3-136", tcgPlayerId: "192391", nameEn: "Charizard VMAX" }),
    });
    expect(result).toEqual({ created: 0, updated: 1, failed: 0, errors: [] });
  });

  it("counts created vs updated based on whether upsert returned a pre-existing id", async () => {
    // Prisma's upsert doesn't itself report created-vs-updated, so the
    // importer checks first via findUnique before upserting.
    mockPrisma.pokemonCardCatalog.upsert.mockResolvedValue({});
    mockPrisma.pokemonCardCatalog.findUnique = vi.fn()
      .mockResolvedValueOnce(null)         // card 1: doesn't exist yet -> created
      .mockResolvedValueOnce({ id: "x" }); // card 2: exists -> updated

    const result = await importCatalogDelta(mockPrisma, {
      game: "POKEMON",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [
        { externalId: "a", tcgPlayerId: "1", name: "A", imageUrl: null },
        { externalId: "b", tcgPlayerId: "2", name: "B", imageUrl: null },
      ],
    });

    expect(result).toEqual({ created: 1, updated: 1, failed: 0, errors: [] });
  });

  it("upserts Riftbound cards against riftboundCardCatalog instead", async () => {
    mockPrisma.riftboundCardCatalog.upsert.mockResolvedValue({});
    mockPrisma.riftboundCardCatalog.findUnique = vi.fn().mockResolvedValue(null);

    await importCatalogDelta(mockPrisma, {
      game: "RIFTBOUND",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [{ externalId: "unl-1-219", tcgPlayerId: "500", name: "Test Card", imageUrl: null, setLabel: "Unleashed", rarity: "Common", collectorNumber: "1", type: "Unit", supertype: "" }],
    });

    expect(mockPrisma.riftboundCardCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { riftboundId: "unl-1-219" } })
    );
    expect(mockPrisma.pokemonCardCatalog.upsert).not.toHaveBeenCalled();
  });

  it("clears the incoming tcgPlayerId from a different row before upserting (tcgPlayerId moved)", async () => {
    // Regression: upserting by tcgPlayerId hit the externalId unique
    // constraint when a card's tcgPlayerId changed or it previously had none.
    mockPrisma.pokemonCardCatalog.findUnique.mockResolvedValue({ id: "existing" });
    const calls: string[] = [];
    mockPrisma.pokemonCardCatalog.updateMany.mockImplementation(async () => { calls.push("updateMany"); return { count: 1 }; });
    mockPrisma.pokemonCardCatalog.upsert.mockImplementation(async () => { calls.push("upsert"); return {}; });

    const result = await importCatalogDelta(mockPrisma, {
      game: "POKEMON",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [{ externalId: "new-owner", tcgPlayerId: "777", name: "Moved", imageUrl: null }],
    });

    expect(mockPrisma.pokemonCardCatalog.updateMany).toHaveBeenCalledWith({
      where: { tcgPlayerId: "777", NOT: { externalId: "new-owner" } },
      data: { tcgPlayerId: null },
    });
    expect(calls).toEqual(["updateMany", "upsert"]);
    expect(mockPrisma.pokemonCardCatalog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalId: "new-owner" }, update: expect.objectContaining({ tcgPlayerId: "777" }) })
    );
    expect(result).toEqual({ created: 0, updated: 1, failed: 0, errors: [] });
  });

  it("skips a card with no tcgPlayerId — nothing to key an upsert on", async () => {
    const result = await importCatalogDelta(mockPrisma, {
      game: "POKEMON",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [{ externalId: "a", tcgPlayerId: null, name: "A", imageUrl: null }],
    });
    expect(mockPrisma.pokemonCardCatalog.upsert).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0, failed: 0, errors: [] });
  });

  it("isolates a per-card failure: one card fails, the rest still succeed and are reported", async () => {
    mockPrisma.pokemonCardCatalog.findUnique = vi.fn()
      .mockResolvedValueOnce(null) // card 1: succeeds, created
      .mockResolvedValueOnce(null) // card 2: succeeds, created
      .mockResolvedValueOnce(null); // card 3: succeeds, created
    mockPrisma.pokemonCardCatalog.upsert = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("null value in column violates not-null constraint"))
      .mockResolvedValueOnce({});

    const result = await importCatalogDelta(mockPrisma, {
      game: "POKEMON",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [
        { externalId: "a", tcgPlayerId: "1", name: "A", imageUrl: null },
        { externalId: "bad", tcgPlayerId: "2", name: "Bad Card", imageUrl: null },
        { externalId: "c", tcgPlayerId: "3", name: "C", imageUrl: null },
      ],
    });

    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("2");
    expect(result.errors[0]).toContain("bad");
    // All three cards were attempted, not just the ones before the failure.
    expect(mockPrisma.pokemonCardCatalog.upsert).toHaveBeenCalledTimes(3);
  });
});
