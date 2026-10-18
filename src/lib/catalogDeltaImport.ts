// src/lib/catalogDeltaImport.ts
//
// Applies a CatalogDelta (produced by the separate tcg-index-sync project,
// or a hand-written fixture in tests) to the catalog tables. Upserts by the
// stable source id (externalId for Pokemon, riftboundId for Riftbound), so
// this is safe to run repeatedly with overlapping deltas even when a card's
// tcgPlayerId changes. tcgPlayerId is also @unique, so if the incoming id is
// currently held by a different row it's cleared there first. Cards with no
// tcgPlayerId are skipped: every catalog row this app cares about requires one.

import type { PrismaClient } from "@prisma/client";

export type CatalogDeltaCard = {
  externalId: string;
  tcgPlayerId: string | null;
  name: string;
  language?: "English" | "Japanese";
  imageUrl: string | null;
  [key: string]: unknown;
};

export type CatalogDelta = {
  game: "POKEMON" | "RIFTBOUND";
  generatedAt: string;
  cards: CatalogDeltaCard[];
};

function toPokemonData(card: CatalogDeltaCard) {
  return {
    externalId: card.externalId,
    tcgPlayerId: card.tcgPlayerId,
    nameEn: card.name,
    language: card.language ?? "English",
    imageUrl: card.imageUrl,
    setId: (card.setId as string) ?? card.externalId,
    setNameEn: (card.setNameEn as string) ?? "",
    rarity: (card.rarity as string) ?? "",
    localId: (card.localId as string) ?? null,
  };
}

function toRiftboundData(card: CatalogDeltaCard) {
  return {
    riftboundId: card.externalId,
    tcgPlayerId: card.tcgPlayerId,
    name: card.name,
    imageUrl: card.imageUrl ?? "",
    setId: (card.setId as string) ?? card.externalId,
    setLabel: (card.setLabel as string) ?? "",
    rarity: (card.rarity as string) ?? "",
    collectorNumber: (card.collectorNumber as string) ?? "",
    type: (card.type as string) ?? "",
    supertype: (card.supertype as string) ?? "",
  };
}

export async function importCatalogDelta(
  prisma: PrismaClient,
  delta: CatalogDelta
): Promise<{ created: number; updated: number; failed: number; errors: string[] }> {
  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  // Per-card isolation, matching the try/catch-and-collect pattern used by
  // the sibling cron routes (backfill-prices/route.ts, refresh-prices/route.ts):
  // one bad row (a null-violation, a type mismatch, a transient DB error)
  // must not throw away the reporting of every card already upserted before
  // it, especially at the ~34k-card scale of an initial import. The upserts
  // themselves are idempotent, so resuming after a partial run is safe.
  for (const card of delta.cards) {
    if (!card.tcgPlayerId) continue;

    try {
      if (delta.game === "POKEMON") {
        const where = { externalId: card.externalId };
        const existing = await prisma.pokemonCardCatalog.findUnique({ where });
        const data = toPokemonData(card);
        // ponytail: not transactional — if the upsert then fails, the other
        // row just loses a tcgPlayerId the source says it no longer owns.
        await prisma.pokemonCardCatalog.updateMany({
          where: { tcgPlayerId: card.tcgPlayerId, NOT: where },
          data: { tcgPlayerId: null },
        });
        await prisma.pokemonCardCatalog.upsert({
          where,
          // Assumes the delta producer always emits a complete record for a
          // "changed" card (an unconditional overwrite is correct for
          // legitimate errata/art corrections) — a future partial-record
          // producer would silently blank previously-good fields here.
          update: data,
          create: data,
        });
        existing ? updated++ : created++;
      } else {
        const where = { riftboundId: card.externalId };
        const existing = await prisma.riftboundCardCatalog.findUnique({ where });
        const data = toRiftboundData(card);
        await prisma.riftboundCardCatalog.updateMany({
          where: { tcgPlayerId: card.tcgPlayerId, NOT: where },
          data: { tcgPlayerId: null },
        });
        await prisma.riftboundCardCatalog.upsert({
          where,
          // Same complete-record assumption as the Pokemon branch above.
          update: data,
          create: data,
        });
        existing ? updated++ : created++;
      }
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${card.tcgPlayerId} (${card.externalId}): ${msg}`);
      console.error("[importCatalogDelta] Failed to import card:", card.tcgPlayerId, msg);
    }
  }

  return { created, updated, failed, errors };
}
