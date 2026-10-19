import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { dollarsToCents } from "@/lib/money";
import { RAW_GRADES } from "@/constants/grades";
import {
  adminOnly,
  catalogField,
  findCatalogByTcgPlayerId,
  ingestItemInclude,
  latestRawPriceCents,
  serializeIngestItems,
  suggestPriceCents,
  type IngestGame,
} from "@/lib/ingest";

/**
 * PATCH /api/admin/ingest/items/[id] — admin review of one scanned card.
 *
 * Body (all optional):
 *   catalogId    choose a card (normally one of the item's candidates)
 *   tcgPlayerId  choose a card by its TCGPlayer id (when no candidate is right)
 *   condition    one of the raw conditions ("Near Mint", ...)
 *   price        sale price in S$ (null clears it)
 *   status       "PENDING" | "APPROVED" | "REJECTED"
 *
 * Choosing a different card re-reads its market price and resets the price
 * to the suggestion. Published items cannot be changed.
 */
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const denied = await adminOnly();
  if (denied) return denied;
  const { id } = await props.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const item = await prisma.ingestItem.findUnique({ where: { id } });
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (item.status === "PUBLISHED") {
    return NextResponse.json({ error: "This card is already listed — edit the listing instead." }, { status: 409 });
  }
  const game = item.game as IngestGame;
  const data: Record<string, unknown> = {};

  // 1. Card selection.
  let catalogId: string | null | undefined;
  if (typeof body.tcgPlayerId === "string" && body.tcgPlayerId.trim()) {
    const ref = await findCatalogByTcgPlayerId(game, body.tcgPlayerId.trim());
    if (!ref) return NextResponse.json({ error: "No catalog card has that TCGPlayer ID." }, { status: 400 });
    catalogId = ref.catalogId;
  } else if (typeof body.catalogId === "string") {
    const exists =
      game === "POKEMON"
        ? await prisma.pokemonCardCatalog.findUnique({ where: { id: body.catalogId }, select: { id: true } })
        : await prisma.riftboundCardCatalog.findUnique({ where: { id: body.catalogId }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "Unknown card." }, { status: 400 });
    catalogId = body.catalogId;
  }
  const currentCatalogId = item.pokemonCardId ?? item.riftboundCardId;
  if (catalogId && catalogId !== currentCatalogId) {
    const market = await latestRawPriceCents(game, catalogId);
    data[catalogField(game)] = catalogId;
    data.marketPriceCents = market;
    data.priceCents = suggestPriceCents(market);
  }

  // 2. Condition and price.
  if (body.condition !== undefined) {
    if (!(RAW_GRADES as readonly unknown[]).includes(body.condition)) {
      return NextResponse.json({ error: `condition must be one of: ${RAW_GRADES.join(", ")}` }, { status: 400 });
    }
    data.condition = body.condition;
  }
  if (body.price !== undefined) {
    if (body.price === null || body.price === "") data.priceCents = null;
    else {
      const dollars = Number(body.price);
      if (!Number.isFinite(dollars) || dollars <= 0 || dollars > 1_000_000) {
        return NextResponse.json({ error: "Price must be a positive amount." }, { status: 400 });
      }
      data.priceCents = dollarsToCents(dollars);
    }
  }

  // 3. Status. Approving needs a card — it is what the listing will be for.
  if (body.status !== undefined) {
    if (!["PENDING", "APPROVED", "REJECTED"].includes(body.status as string)) {
      return NextResponse.json({ error: "status must be PENDING, APPROVED or REJECTED" }, { status: 400 });
    }
    if (body.status === "APPROVED" && !(catalogId ?? currentCatalogId)) {
      return NextResponse.json({ error: "Choose the card before approving." }, { status: 400 });
    }
    data.status = body.status;
  }

  // Conditional on not-yet-published, so an edit can't race a publish.
  const { count } = await prisma.ingestItem.updateMany({ where: { id, status: { not: "PUBLISHED" } }, data });
  if (count !== 1) {
    return NextResponse.json({ error: "This card was just listed — reload the page." }, { status: 409 });
  }
  const updated = await prisma.ingestItem.findUniqueOrThrow({ where: { id }, include: ingestItemInclude });
  const [serialized] = await serializeIngestItems([updated]);
  return NextResponse.json({ item: serialized });
}
