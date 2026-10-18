// src/lib/ingest.ts
//
// Scanned-card ingestion: MXYYC-TCG-IDENTIFIER sends each identified scan to
// POST /api/admin/ingest/items, an admin reviews it on /admin/ingest, and a
// published item becomes a Listing owned by the ingest owner account.

import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import type { Prisma, PrismaClient } from "@prisma/client";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToDollars } from "@/lib/money";

export type IngestGame = "POKEMON" | "RIFTBOUND";
export const INGEST_STATUSES = ["PENDING", "APPROVED", "REJECTED", "PUBLISHED"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];
/** Identifier confidences that are pre-selected by "Approve all confident". */
export const CONFIDENT = ["perfect", "high"];

/** Every ingested card is listed under this account (one shop account for now). */
export function ingestOwnerEmail(): string {
  return process.env.INGEST_OWNER_EMAIL || "admin@pokemon.com";
}

/** The review routes are admin-only. Returns an error response, or null when allowed. */
export async function adminOnly(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (session.user.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

/**
 * Checks the identifier's `Authorization: Bearer <INGEST_API_TOKEN>` header.
 * Constant-time compare; an unset token disables the endpoint entirely.
 */
export function isValidIngestToken(req: Request): boolean {
  const expected = process.env.INGEST_API_TOKEN;
  if (!expected) return false;
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Suggested sale price: the market price rounded UP to the next S$0.50, never
 * below S$1.00 — clean prices, never under market.
 */
export function suggestPriceCents(marketCents: number | null | undefined): number | null {
  if (marketCents == null || marketCents <= 0) return null;
  return Math.max(100, Math.ceil(marketCents / 50) * 50);
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Latest RAW (ungraded, Near Mint) market price for a catalog card, in SGD cents. */
export async function latestRawPriceCents(game: IngestGame, catalogId: string, db: Db = prisma): Promise<number | null> {
  const row = await db.priceHistory.findFirst({
    where: { variant: "RAW", ...(game === "POKEMON" ? { pokemonCardId: catalogId } : { riftboundCardId: catalogId }) },
    orderBy: { capturedAt: "desc" },
    select: { priceCents: true },
  });
  return row?.priceCents ?? null;
}

export interface CatalogRef {
  catalogId: string;
  label: string;
}

function pokemonLabel(c: { nameEn: string; setNameEn: string | null; printedNumber: string | null; localId: string | null; language: string }) {
  return [c.nameEn, c.setNameEn, c.printedNumber ?? c.localId, c.language === "Japanese" ? "JP" : "EN"].filter(Boolean).join(" · ");
}

function riftboundLabel(c: { name: string; setLabel: string; printedNumber: string | null; collectorNumber: string }) {
  return [c.name, c.setLabel, c.printedNumber ?? c.collectorNumber].filter(Boolean).join(" · ");
}

/**
 * Maps the identifier's card ids (tcgdex ids like "me01-016" for Pokémon —
 * the catalog's externalId — or riftbound ids like "ogn-111-298") to catalog
 * rows. Ids not in the catalog (no TCGPlayer id, so never priced or sold) are
 * left out.
 */
export async function resolveCatalogRefs(game: IngestGame, ids: string[], db: Db = prisma): Promise<Map<string, CatalogRef>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, CatalogRef>();
  if (unique.length === 0) return out;
  if (game === "POKEMON") {
    const rows = await db.pokemonCardCatalog.findMany({
      where: { externalId: { in: unique } },
      select: { id: true, externalId: true, nameEn: true, setNameEn: true, printedNumber: true, localId: true, language: true },
    });
    for (const r of rows) out.set(r.externalId, { catalogId: r.id, label: pokemonLabel(r) });
  } else {
    const rows = await db.riftboundCardCatalog.findMany({
      where: { riftboundId: { in: unique } },
      select: { id: true, riftboundId: true, name: true, setLabel: true, printedNumber: true, collectorNumber: true },
    });
    for (const r of rows) out.set(r.riftboundId, { catalogId: r.id, label: riftboundLabel(r) });
  }
  return out;
}

/** Catalog card by TCGPlayer id — lets a reviewer fix a card the identifier missed. */
export async function findCatalogByTcgPlayerId(game: IngestGame, tcgPlayerId: string, db: Db = prisma): Promise<CatalogRef | null> {
  if (game === "POKEMON") {
    const r = await db.pokemonCardCatalog.findUnique({
      where: { tcgPlayerId },
      select: { id: true, nameEn: true, setNameEn: true, printedNumber: true, localId: true, language: true },
    });
    return r ? { catalogId: r.id, label: pokemonLabel(r) } : null;
  }
  const r = await db.riftboundCardCatalog.findUnique({
    where: { tcgPlayerId },
    select: { id: true, name: true, setLabel: true, printedNumber: true, collectorNumber: true },
  });
  return r ? { catalogId: r.id, label: riftboundLabel(r) } : null;
}

export const catalogField = (game: string) => (game === "POKEMON" ? "pokemonCardId" : "riftboundCardId");

/** Shape the review page reads. */
export function serializeIngestItem(item: Prisma.IngestItemGetPayload<{ include: typeof ingestItemInclude }>) {
  const card = item.pokemonCard
    ? { catalogId: item.pokemonCard.id, label: pokemonLabel(item.pokemonCard), tcgPlayerId: item.pokemonCard.tcgPlayerId }
    : item.riftboundCard
      ? { catalogId: item.riftboundCard.id, label: riftboundLabel(item.riftboundCard), tcgPlayerId: item.riftboundCard.tcgPlayerId }
      : null;
  return {
    id: item.id,
    status: item.status,
    confidence: item.confidence,
    method: item.method,
    sourceFile: item.sourceFile,
    game: item.game,
    imageUrls: item.imageUrls,
    card,
    candidates: item.candidates as unknown as (CatalogRef & { score?: number })[],
    ocr: item.ocr,
    condition: item.condition,
    marketPrice: item.marketPriceCents != null ? centsToDollars(item.marketPriceCents) : null,
    price: item.priceCents != null ? centsToDollars(item.priceCents) : null,
    listingId: item.listingId,
  };
}

export const ingestItemInclude = {
  pokemonCard: { select: { id: true, nameEn: true, setNameEn: true, printedNumber: true, localId: true, language: true, tcgPlayerId: true } },
  riftboundCard: { select: { id: true, name: true, setLabel: true, printedNumber: true, collectorNumber: true, tcgPlayerId: true } },
} satisfies Prisma.IngestItemInclude;

export type PublishOutcome = { itemId: string; listingId?: string; skipped?: string };

/**
 * Turns one APPROVED item into a for-sale Listing. Safe to run twice at once:
 * the item is claimed with a conditional update inside the transaction, so a
 * second publisher sees it already taken and creates nothing.
 */
export async function publishIngestItem(itemId: string, ownerId: string): Promise<PublishOutcome> {
  return prisma.$transaction(async (tx) => {
    const item = await tx.ingestItem.findUnique({ where: { id: itemId } });
    if (!item || item.status !== "APPROVED" || item.listingId) return { itemId, skipped: "not approved" };
    const catalogId = item.pokemonCardId ?? item.riftboundCardId;
    if (!catalogId) return { itemId, skipped: "no card selected" };
    if (!item.priceCents || item.priceCents <= 0) return { itemId, skipped: "needs a price" };

    const listing = await tx.listing.create({
      data: {
        game: item.game,
        ...(item.game === "POKEMON" ? { pokemonCardId: catalogId } : { riftboundCardId: catalogId }),
        price: item.priceCents,
        condition: item.condition,
        imageUrls: item.imageUrls,
        forSale: true,
        ownerId,
      },
      select: { id: true },
    });
    const claimed = await tx.ingestItem.updateMany({
      where: { id: itemId, status: "APPROVED", listingId: null },
      data: { status: "PUBLISHED", listingId: listing.id },
    });
    if (claimed.count !== 1) throw new IngestRaceError();
    return { itemId, listingId: listing.id };
  });
}

/** Thrown inside the publish transaction to roll back a lost race. */
export class IngestRaceError extends Error {
  constructor() {
    super("Item was published by another request");
  }
}
