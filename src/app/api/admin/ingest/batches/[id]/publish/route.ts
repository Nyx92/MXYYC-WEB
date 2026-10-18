import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminOnly, ingestOwnerEmail, publishIngestItem, IngestRaceError, type PublishOutcome } from "@/lib/ingest";

/**
 * POST /api/admin/ingest/batches/[id]/publish — admin: every APPROVED item
 * with a card and a price becomes a for-sale Listing owned by the ingest
 * owner (INGEST_OWNER_EMAIL, default admin@pokemon.com). Approved items
 * without a price are skipped and stay APPROVED. Safe to click twice.
 * At most PUBLISH_CHUNK items per call (Vercel time limit); `remaining` tells
 * the page to call again.
 */
const PUBLISH_CHUNK = 200;
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const denied = await adminOnly();
  if (denied) return denied;
  const { id } = await props.params;

  const owner = await prisma.user.findUnique({ where: { email: ingestOwnerEmail() }, select: { id: true } });
  if (!owner) {
    return NextResponse.json({ error: `The ingest owner account (${ingestOwnerEmail()}) does not exist.` }, { status: 500 });
  }

  const items = await prisma.ingestItem.findMany({
    where: { batchId: id, status: "APPROVED", listingId: null },
    select: { id: true },
    orderBy: { sourceFile: "asc" },
    take: PUBLISH_CHUNK,
  });

  const outcomes: PublishOutcome[] = [];
  for (const item of items) {
    try {
      outcomes.push(await publishIngestItem(item.id, owner.id));
    } catch (err) {
      if (err instanceof IngestRaceError) outcomes.push({ itemId: item.id, skipped: "already published" });
      else {
        console.error("[ingest publish] item failed:", item.id, err);
        outcomes.push({ itemId: item.id, skipped: "error" });
      }
    }
  }
  const published = outcomes.filter((o) => o.listingId).length;
  // Only count items this call could still publish (approved, with a card and a price).
  const remaining =
    items.length === PUBLISH_CHUNK && published > 0
      ? await prisma.ingestItem.count({ where: { batchId: id, status: "APPROVED", listingId: null, priceCents: { gt: 0 } } })
      : 0;
  return NextResponse.json({ published, skipped: outcomes.filter((o) => o.skipped), remaining });
}
