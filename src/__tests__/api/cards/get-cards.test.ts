import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  listing: { findMany: vi.fn(), count: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
// The route module creates a Supabase client at module scope (used by POST,
// not GET) — mock it out so importing the module doesn't require real
// SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY env vars, matching the pattern in
// get-card.test.ts for this same route file.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({})),
}));

import { GET } from "@/app/api/cards/route";
import { MAX_PAGE_SIZE } from "@/lib/listingsQuery";

function cardsRequest(query: string) {
  return new Request(`http://localhost/api/cards${query}`);
}

const POKEMON_LISTING = {
  id: "listing-1",
  price: 5000,
  game: "POKEMON",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  pokemonCard: {
    nameEn: "Charizard", rarity: "Rare Holo", setNameEn: "Base Set",
    language: "English", localId: "004", tcgPlayerId: "tcg-1",
  },
  riftboundCard: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.listing.findMany.mockResolvedValue([POKEMON_LISTING]);
  mockPrisma.listing.count.mockResolvedValue(1);
});

describe("GET /api/cards — filters", () => {
  it("always restricts to for-sale listings, even with no query params (private collections stay private)", async () => {
    await GET(cardsRequest(""));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ AND: [{ forSale: true }] });
  });

  it("keeps the existing forSale=true behavior", async () => {
    await GET(cardsRequest("?forSale=true"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ AND: [{ forSale: true }] });
  });

  it("keeps the existing tcgPlayerId OR-across-games behavior", async () => {
    await GET(cardsRequest("?tcgPlayerId=tcg-1"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, {
        OR: [
          { pokemonCard: { tcgPlayerId: "tcg-1" } },
          { riftboundCard: { tcgPlayerId: "tcg-1" } },
        ],
      }],
    });
  });

  it("filters by game", async () => {
    await GET(cardsRequest("?game=RIFTBOUND"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ AND: [{ forSale: true }, { game: "RIFTBOUND" }] });
  });

  it("ignores an unrecognized game value rather than erroring", async () => {
    await GET(cardsRequest("?game=MAGIC"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ AND: [{ forSale: true }] });
  });

  it("filters by one or more setName values, OR'd across both games' set fields", async () => {
    await GET(cardsRequest("?setName=Base+Set&setName=Jungle"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, {
        OR: [
          { pokemonCard: { setNameEn: { in: ["Base Set", "Jungle"] } } },
          { riftboundCard: { setLabel: { in: ["Base Set", "Jungle"] } } },
        ],
      }],
    });
  });

  it("filters by one or more rarity values, OR'd across both games' rarity fields", async () => {
    await GET(cardsRequest("?rarity=Rare&rarity=Rare+Holo"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, {
        OR: [
          { pokemonCard: { rarity: { in: ["Rare", "Rare Holo"] } } },
          { riftboundCard: { rarity: { in: ["Rare", "Rare Holo"] } } },
        ],
      }],
    });
  });

  it("filters by Riftbound type (no Pokemon equivalent, so no OR needed)", async () => {
    await GET(cardsRequest("?type=Unit&type=Legend"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, { riftboundCard: { type: { in: ["Unit", "Legend"] } } }],
    });
  });

  it("filters by condition (a plain scalar column on Listing)", async () => {
    await GET(cardsRequest("?condition=Near+Mint&condition=PSA+10"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, { condition: { in: ["Near Mint", "PSA 10"] } }],
    });
  });

  it("filters by language, treating every RIFTBOUND listing as English since it has no real language column", async () => {
    await GET(cardsRequest("?language=English&language=Japanese"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, {
        OR: [
          { pokemonCard: { language: { in: ["English", "Japanese"] } } },
          { game: "RIFTBOUND" },
        ],
      }],
    });
  });

  it("filters by language without the RIFTBOUND carve-out when English isn't selected", async () => {
    await GET(cardsRequest("?language=Japanese"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, {
        OR: [{ pokemonCard: { language: { in: ["Japanese"] } } }],
      }],
    });
  });

  it("filters by a list of ids", async () => {
    await GET(cardsRequest("?ids=id-1&ids=id-2"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ AND: [{ forSale: true }, { id: { in: ["id-1", "id-2"] } }] });
  });

  it("combines multiple facets with AND", async () => {
    await GET(cardsRequest("?forSale=true&game=POKEMON&rarity=Rare"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [
        { forSale: true },
        { game: "POKEMON" },
        {
          OR: [
            { pokemonCard: { rarity: { in: ["Rare"] } } },
            { riftboundCard: { rarity: { in: ["Rare"] } } },
          ],
        },
      ],
    });
  });

  it("orders by createdAt desc with id asc as a deterministic tiebreaker", async () => {
    await GET(cardsRequest(""));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.orderBy).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
  });
});

describe("GET /api/cards — pagination", () => {
  it("returns every matching row (up to the MAX_PAGE_SIZE safety cap) with no totalCount/hasMore when page/pageSize are omitted", async () => {
    const res = await GET(cardsRequest("?forSale=true"));
    const body = await res.json();

    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.skip).toBeUndefined();
    // No skip/take from the caller doesn't mean no bound at the DB level —
    // this public, unauthenticated route still caps the unpaginated query at
    // MAX_PAGE_SIZE so an omitted page/pageSize can't force a full-catalog
    // scan-and-serialize as the listing count grows (mirrors the same
    // defensive cap getAuctionsPage already applies).
    expect(call.take).toBe(MAX_PAGE_SIZE);
    expect(mockPrisma.listing.count).not.toHaveBeenCalled();
    expect(body).not.toHaveProperty("totalCount");
    expect(body).not.toHaveProperty("hasMore");
  });

  it("applies skip/take and returns totalCount/hasMore when page/pageSize are given", async () => {
    mockPrisma.listing.count.mockResolvedValue(50);

    const res = await GET(cardsRequest("?page=2&pageSize=24"));
    const body = await res.json();

    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.skip).toBe(24);
    expect(call.take).toBe(24);
    expect(body.totalCount).toBe(50);
    expect(body.hasMore).toBe(true); // page 2 of 24 = 48 seen so far, 50 total
  });

  it("reports hasMore: false on the last page", async () => {
    mockPrisma.listing.count.mockResolvedValue(50);

    const res = await GET(cardsRequest("?page=3&pageSize=24"));
    const body = await res.json();

    expect(body.hasMore).toBe(false); // page 3 of 24 = 72 seen, only 50 exist
  });

  it("treats page=1 as the first page (skip 0)", async () => {
    await GET(cardsRequest("?page=1&pageSize=24"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
    expect(call.take).toBe(24);
  });

  it("clamps page below 1 up to 1, rather than producing a negative skip", async () => {
    await GET(cardsRequest("?page=0&pageSize=24"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
  });

  it("clamps a negative page up to 1 as well", async () => {
    await GET(cardsRequest("?page=-5&pageSize=24"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
  });

  it("clamps pageSize above 100 down to 100", async () => {
    await GET(cardsRequest("?page=1&pageSize=5000"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.take).toBe(100);
  });

  it("clamps pageSize below 1 up to 1", async () => {
    await GET(cardsRequest("?page=1&pageSize=0"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.take).toBe(1);
  });

  it("caps how many ids can be requested at once, rather than accepting an unbounded list", async () => {
    const manyIds = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    const params = new URLSearchParams();
    manyIds.forEach((id) => params.append("ids", id));

    await GET(cardsRequest(`?${params.toString()}`));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    const idsCondition = call.where.AND.find((c: any) => c.id)?.id;
    expect(idsCondition.in.length).toBe(200);
    expect(idsCondition.in).toEqual(manyIds.slice(0, 200));
  });
});

describe("GET /api/cards — combined game + language filter (regression)", () => {
  it("matches Riftbound rows when English is one of the selected languages, alongside an active game filter", async () => {
    await GET(cardsRequest("?game=RIFTBOUND&language=English"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, 
        { game: "RIFTBOUND" },
        {
          OR: [
            { pokemonCard: { language: { in: ["English"] } } },
            { game: "RIFTBOUND" },
          ],
        },
      ],
    });
  });

  it("excludes every Riftbound row when a non-English language is selected, even with game=RIFTBOUND active", async () => {
    await GET(cardsRequest("?game=RIFTBOUND&language=Japanese"));
    const call = mockPrisma.listing.findMany.mock.calls[0][0];
    expect(call.where).toEqual({
      AND: [{ forSale: true }, 
        { game: "RIFTBOUND" },
        { OR: [{ pokemonCard: { language: { in: ["Japanese"] } } }] },
      ],
    });
  });
});
