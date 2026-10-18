// src/lib/catalogDeltaImport.ts
//
// Applies a CatalogDelta (produced by the separate tcg-index-sync project,
// or a hand-written fixture in tests) to the catalog tables. Upserts by the
// stable source id (externalId for Pokemon, riftboundId for Riftbound), so
// this is safe to run repeatedly with overlapping deltas even when a card's
// tcgPlayerId changes. tcgPlayerId is also @unique, so if the incoming id is
// currently held by a different row it's cleared there first. Cards with no
// tcgPlayerId are skipped: every catalog row this app cares about requires one.
// Works in batches (see BATCH_SIZE) — a per-card import is far too slow over
// a high-latency connection.

import type { PrismaClient } from "@prisma/client";
import { mapWithConcurrency } from "./concurrency";

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
  const language = card.language ?? "English";
  return {
    externalId: card.externalId,
    tcgPlayerId: card.tcgPlayerId,
    // Japanese cards have no English name in the source — `name` is the
    // Japanese one. nameEn is required, so it holds that too, and nameJa
    // records it as what it actually is.
    nameEn: card.name,
    nameJa: language === "Japanese" ? card.name : null,
    hp: typeof card.hp === "number" ? card.hp : null,
    types: Array.isArray(card.types) ? (card.types as string[]) : [],
    stage: (card.stage as string | null | undefined) ?? null,
    language,
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

// Cards per batch. Each batch costs a handful of round trips regardless of
// size, which is what matters: from a dev machine every Supabase query is
// ~1.3 s, so a per-card import of ~31k cards (3 queries each) took over a day.
const BATCH_SIZE = 1000;
// Updates to existing rows still go one per row; run a few at once, matching
// the pooler's connection_limit (see src/lib/prisma.ts).
const UPDATE_CONCURRENCY = 5;

export async function importCatalogDelta(
  prisma: PrismaClient,
  delta: CatalogDelta
): Promise<{ created: number; updated: number; failed: number; errors: string[] }> {
  const isPokemon = delta.game === "POKEMON";
  // The two catalog models share every method used here; only the key differs.
  const model = (isPokemon ? prisma.pokemonCardCatalog : prisma.riftboundCardCatalog) as unknown as CatalogModel;
  const key = isPokemon ? "externalId" : "riftboundId";
  const toData = isPokemon ? toPokemonData : toRiftboundData;

  // Only cards with a tcgPlayerId. If two cards share one (or a card appears
  // twice), the later one wins — the same end state the old one-card-at-a-time
  // import reached, since each card took the id from whoever held it before.
  const lastByTcg = new Map<string, CatalogDeltaCard>();
  for (const card of delta.cards) if (card.tcgPlayerId) lastByTcg.set(card.tcgPlayerId, card);
  const lastByKey = new Map<string, CatalogDeltaCard>();
  for (const card of lastByTcg.values()) lastByKey.set(card.externalId, card);
  const cards = [...lastByKey.values()];

  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];
  const fail = (card: { tcgPlayerId: string | null; externalId?: string } & Record<string, unknown>, err: unknown) => {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${card.tcgPlayerId} (${card[key] ?? card.externalId}): ${msg}`);
    console.error("[importCatalogDelta] Failed to import card:", card.tcgPlayerId, msg);
  };

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const rows = cards.slice(i, i + BATCH_SIZE).map((c) => toData(c) as CatalogRow);
    const keys = rows.map((r) => r[key] as string);
    try {
      const existing = new Set(
        (await model.findMany({ where: { [key]: { in: keys } }, select: { [key]: true } })).map((r) => r[key] as string)
      );

      // tcgPlayerId is @unique: free each incoming id from any *other* row
      // that holds it (the source says that row no longer owns it). Checking
      // the holder's key — not just "not in this batch" — also handles two
      // cards in the same batch swapping ids.
      const incomingOwner = new Map(rows.map((r) => [r.tcgPlayerId as string, r[key] as string]));
      const holders = await model.findMany({
        where: { tcgPlayerId: { in: [...incomingOwner.keys()] } },
        select: { [key]: true, tcgPlayerId: true },
      });
      const toClear = holders
        .filter((h) => incomingOwner.get(h.tcgPlayerId as string) !== h[key])
        .map((h) => h[key] as string);
      if (toClear.length > 0) {
        await model.updateMany({ where: { [key]: { in: toClear } }, data: { tcgPlayerId: null } });
      }

      const creates = rows.filter((r) => !existing.has(r[key] as string));
      if (creates.length > 0) {
        try {
          created += (await model.createMany({ data: creates })).count;
        } catch {
          // One bad row fails the whole batch insert — retry this batch one
          // row at a time so only the bad row is reported.
          for (const row of creates) {
            try {
              await model.create({ data: row });
              created++;
            } catch (err) {
              fail(row, err);
            }
          }
        }
      }

      // Assumes the delta producer always emits a complete record for a
      // "changed" card (an unconditional overwrite is correct for legitimate
      // errata/art corrections) — a future partial-record producer would
      // silently blank previously-good fields here.
      const updates = rows.filter((r) => existing.has(r[key] as string));
      const results = await mapWithConcurrency(updates, UPDATE_CONCURRENCY, (row) =>
        model.update({ where: { [key]: row[key] }, data: row })
      );
      for (const r of results) r.status === "fulfilled" ? updated++ : fail(r.item, r.reason);
    } catch (err) {
      // A lookup/clear query failed: report the whole batch, keep going.
      for (const row of rows) fail(row, err);
    }
    console.log(`[importCatalogDelta] ${Math.min(i + BATCH_SIZE, cards.length)}/${cards.length} cards processed`);
  }

  return { created, updated, failed, errors };
}

type CatalogRow = Record<string, unknown> & { tcgPlayerId: string | null };
type CatalogModel = {
  findMany(args: object): Promise<CatalogRow[]>;
  updateMany(args: object): Promise<{ count: number }>;
  createMany(args: { data: CatalogRow[] }): Promise<{ count: number }>;
  create(args: { data: CatalogRow }): Promise<unknown>;
  update(args: object): Promise<unknown>;
};
