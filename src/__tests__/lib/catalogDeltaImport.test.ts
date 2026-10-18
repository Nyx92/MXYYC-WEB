import { describe, it, expect, vi, beforeEach } from "vitest";
import { importCatalogDelta, type CatalogDeltaCard } from "@/lib/catalogDeltaImport";

/**
 * importCatalogDelta works in batches: per batch it looks up which cards
 * already exist, frees incoming tcgPlayerIds held by other rows, inserts new
 * cards with one createMany, and updates existing ones individually.
 */

const model = () => ({
  findMany: vi.fn(),
  updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length })),
  create: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
});
let mockPrisma: { pokemonCardCatalog: ReturnType<typeof model>; riftboundCardCatalog: ReturnType<typeof model> };

// findMany is called twice per batch: first "which keys exist", then "who holds these ids".
function db(m: ReturnType<typeof model>, existingKeys: string[], holders: Record<string, unknown>[] = []) {
  m.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    "tcgPlayerId" in args.where ? holders : existingKeys.map((k) => ({ externalId: k, riftboundId: k }))
  );
}

const pokemon = (cards: CatalogDeltaCard[]) =>
  importCatalogDelta(mockPrisma as any, { game: "POKEMON", generatedAt: "2026-10-18T00:00:00Z", cards });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  mockPrisma = { pokemonCardCatalog: model(), riftboundCardCatalog: model() };
});

describe("importCatalogDelta", () => {
  it("maps delta fields to catalog columns and inserts new cards with one createMany", async () => {
    db(mockPrisma.pokemonCardCatalog, []);
    const result = await pokemon([{
      externalId: "swsh3-136", tcgPlayerId: "192391", name: "Charizard VMAX",
      language: "English", imageUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp",
      setNameEn: "Darkness Ablaze", rarity: "Secret Rare", setId: "swsh3", localId: "136",
    }]);

    expect(mockPrisma.pokemonCardCatalog.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.pokemonCardCatalog.createMany.mock.calls[0][0].data[0]).toEqual(expect.objectContaining({
      externalId: "swsh3-136", tcgPlayerId: "192391", nameEn: "Charizard VMAX",
      imageUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp", setId: "swsh3", localId: "136",
    }));
    expect(result).toEqual({ created: 1, updated: 0, failed: 0, errors: [] });
  });

  it("copies HP, types and stage, and records a Japanese card's name as nameJa too", async () => {
    db(mockPrisma.pokemonCardCatalog, []);
    await pokemon([
      { externalId: "M5-001", tcgPlayerId: "695001", name: "トロピウス", language: "Japanese", imageUrl: null,
        setId: "M5", setNameEn: "M5", rarity: "Common", localId: "001", hp: 110, types: ["Grass"], stage: "Basic" },
      { externalId: "sv08-001", tcgPlayerId: "1", name: "Exeggcute", language: "English", imageUrl: null,
        setId: "sv08", setNameEn: "Surging Sparks", rarity: "Common", localId: "001", hp: null, types: [], stage: null },
    ]);

    const [jp, en] = mockPrisma.pokemonCardCatalog.createMany.mock.calls[0][0].data;
    expect(jp).toEqual(expect.objectContaining({ nameEn: "トロピウス", nameJa: "トロピウス", hp: 110, types: ["Grass"], stage: "Basic", language: "Japanese" }));
    expect(en).toEqual(expect.objectContaining({ nameEn: "Exeggcute", nameJa: null, hp: null, types: [], stage: null }));
  });

  it("updates cards that already exist and counts created vs updated", async () => {
    db(mockPrisma.pokemonCardCatalog, ["b"]);
    const result = await pokemon([
      { externalId: "a", tcgPlayerId: "1", name: "A", imageUrl: null },
      { externalId: "b", tcgPlayerId: "2", name: "B", imageUrl: null },
    ]);

    expect(mockPrisma.pokemonCardCatalog.update).toHaveBeenCalledWith({
      where: { externalId: "b" },
      data: expect.objectContaining({ externalId: "b", tcgPlayerId: "2" }),
    });
    expect(result).toEqual({ created: 1, updated: 1, failed: 0, errors: [] });
  });

  it("writes Riftbound cards to riftboundCardCatalog keyed by riftboundId", async () => {
    db(mockPrisma.riftboundCardCatalog, []);
    await importCatalogDelta(mockPrisma as any, {
      game: "RIFTBOUND",
      generatedAt: "2026-09-16T00:00:00Z",
      cards: [{ externalId: "unl-1-219", tcgPlayerId: "500", name: "Test Card", imageUrl: null, setLabel: "Unleashed", rarity: "Common", collectorNumber: "1", type: "Unit", supertype: "" }],
    });

    expect(mockPrisma.riftboundCardCatalog.createMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ riftboundId: "unl-1-219", tcgPlayerId: "500" })
    );
    expect(mockPrisma.pokemonCardCatalog.createMany).not.toHaveBeenCalled();
  });

  it("frees an incoming tcgPlayerId from the other row holding it before writing (tcgPlayerId moved)", async () => {
    db(mockPrisma.pokemonCardCatalog, [], [{ externalId: "old-owner", tcgPlayerId: "777" }]);
    const calls: string[] = [];
    mockPrisma.pokemonCardCatalog.updateMany.mockImplementation(async () => { calls.push("clear"); return { count: 1 }; });
    mockPrisma.pokemonCardCatalog.createMany.mockImplementation(async ({ data }) => { calls.push("create"); return { count: data.length }; });

    await pokemon([{ externalId: "new-owner", tcgPlayerId: "777", name: "Moved", imageUrl: null }]);

    expect(mockPrisma.pokemonCardCatalog.updateMany).toHaveBeenCalledWith({
      where: { externalId: { in: ["old-owner"] } },
      data: { tcgPlayerId: null },
    });
    expect(calls).toEqual(["clear", "create"]);
  });

  it("does not clear a row that already holds its own incoming id", async () => {
    db(mockPrisma.pokemonCardCatalog, ["a"], [{ externalId: "a", tcgPlayerId: "1" }]);
    await pokemon([{ externalId: "a", tcgPlayerId: "1", name: "A", imageUrl: null }]);
    expect(mockPrisma.pokemonCardCatalog.updateMany).not.toHaveBeenCalled();
  });

  it("skips a card with no tcgPlayerId", async () => {
    db(mockPrisma.pokemonCardCatalog, []);
    const result = await pokemon([{ externalId: "a", tcgPlayerId: null, name: "A", imageUrl: null }]);
    expect(mockPrisma.pokemonCardCatalog.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ created: 0, updated: 0, failed: 0, errors: [] });
  });

  it("lets the later card win when two cards in the delta share a tcgPlayerId", async () => {
    db(mockPrisma.pokemonCardCatalog, []);
    await pokemon([
      { externalId: "tk-xy-latio-20", tcgPlayerId: "98338", name: "Acro Bike", imageUrl: null },
      { externalId: "tk-xy-latia-20", tcgPlayerId: "98338", name: "Acro Bike", imageUrl: null },
    ]);
    const data = mockPrisma.pokemonCardCatalog.createMany.mock.calls[0][0].data;
    expect((data as { externalId: string }[]).map((r) => r.externalId)).toEqual(["tk-xy-latia-20"]);
  });

  it("isolates a bad row: a failed batch insert is retried row by row and only the bad row is reported", async () => {
    db(mockPrisma.pokemonCardCatalog, []);
    mockPrisma.pokemonCardCatalog.createMany.mockRejectedValueOnce(new Error("batch failed"));
    mockPrisma.pokemonCardCatalog.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("null value in column violates not-null constraint"))
      .mockResolvedValueOnce({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await pokemon([
      { externalId: "a", tcgPlayerId: "1", name: "A", imageUrl: null },
      { externalId: "bad", tcgPlayerId: "2", name: "Bad Card", imageUrl: null },
      { externalId: "c", tcgPlayerId: "3", name: "C", imageUrl: null },
    ]);

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("2 (bad)");
  });

  it("splits large deltas into batches of 1000", async () => {
    db(mockPrisma.pokemonCardCatalog, []);
    const cards = Array.from({ length: 2500 }, (_, i) => ({ externalId: `c${i}`, tcgPlayerId: String(i), name: "X", imageUrl: null }));
    const result = await pokemon(cards);
    expect(mockPrisma.pokemonCardCatalog.createMany).toHaveBeenCalledTimes(3);
    expect(result.created).toBe(2500);
  });
});
