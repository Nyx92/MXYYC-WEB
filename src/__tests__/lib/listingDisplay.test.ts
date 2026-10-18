import { describe, it, expect } from "vitest";
import {
  listingCatalogInclude,
  resolveListingDisplay,
  withListingDisplay,
} from "@/lib/listingDisplay";

const POKEMON_LISTING = {
  id: "listing-1",
  price: 5000,
  game: "POKEMON",
  pokemonCardId: "pkc-1",
  riftboundCardId: null,
  pokemonCard: {
    id: "pkc-1",
    nameEn: "Charizard",
    rarity: "Rare Holo",
    setNameEn: "Base Set",
    language: "English",
    localId: "004",
    tcgPlayerId: "tcg-1",
  },
  riftboundCard: null,
};

const RIFTBOUND_LISTING = {
  id: "listing-2",
  price: 2500,
  game: "RIFTBOUND",
  pokemonCardId: null,
  riftboundCardId: "rbc-1",
  pokemonCard: null,
  riftboundCard: {
    id: "rbc-1",
    name: "Vi - Peacekeeper",
    rarity: "Rare",
    setLabel: "Unleashed",
    collectorNumber: "176",
    tcgPlayerId: null,
  },
};

describe("resolveListingDisplay", () => {
  it("resolves display fields from pokemonCard when set", () => {
    expect(resolveListingDisplay(POKEMON_LISTING as any)).toEqual({
      title: "Charizard",
      rarity: "Rare Holo",
      setName: "Base Set",
      language: "English",
      cardNumber: "004",
      tcgPlayerId: "tcg-1",
    });
  });

  it("resolves display fields from riftboundCard when set, defaulting language to English", () => {
    expect(resolveListingDisplay(RIFTBOUND_LISTING as any)).toEqual({
      title: "Vi - Peacekeeper",
      rarity: "Rare",
      setName: "Unleashed",
      language: "English",
      cardNumber: "176",
      tcgPlayerId: "",
    });
  });

  it("includes type and supertype when the riftboundCard has them set", () => {
    const listingWithTypes = {
      ...RIFTBOUND_LISTING,
      riftboundCard: { ...RIFTBOUND_LISTING.riftboundCard, type: "Unit", supertype: "Champion" },
    };
    const result = resolveListingDisplay(listingWithTypes as any);
    expect(result.type).toBe("Unit");
    expect(result.supertype).toBe("Champion");
  });

  it("omits type and supertype for a pokemonCard listing", () => {
    const result = resolveListingDisplay(POKEMON_LISTING as any);
    expect(result.type).toBeUndefined();
    expect(result.supertype).toBeUndefined();
  });

  it("throws when neither catalog relation is populated", () => {
    const broken = { ...POKEMON_LISTING, pokemonCard: null, riftboundCard: null };
    expect(() => resolveListingDisplay(broken as any)).toThrow(
      /has no catalog reference/
    );
  });
});

describe("withListingDisplay", () => {
  it("merges resolved display fields and strips the raw catalog relations", () => {
    const result = withListingDisplay(POKEMON_LISTING as any);
    expect(result).toMatchObject({
      id: "listing-1",
      price: 5000,
      title: "Charizard",
      rarity: "Rare Holo",
      setName: "Base Set",
      language: "English",
      cardNumber: "004",
      tcgPlayerId: "tcg-1",
    });
    expect(result).not.toHaveProperty("pokemonCard");
    expect(result).not.toHaveProperty("riftboundCard");
  });
});

describe("listingCatalogInclude", () => {
  it("includes both catalog relations", () => {
    expect(listingCatalogInclude).toEqual({ pokemonCard: true, riftboundCard: true });
  });
});
