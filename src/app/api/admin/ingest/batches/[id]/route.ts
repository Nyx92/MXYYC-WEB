import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminOnly, ingestItemInclude, serializeIngestItem } from "@/lib/ingest";

/** GET /api/admin/ingest/batches/[id] — admin: one batch with every item, in scan order. */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const denied = await adminOnly();
  if (denied) return denied;
  const { id } = await props.params;

  const batch = await prisma.ingestBatch.findUnique({
    where: { id },
    include: { items: { include: ingestItemInclude, orderBy: { sourceFile: "asc" } } },
  });
  if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

  return NextResponse.json({
    batch: { id: batch.id, name: batch.name, game: batch.game, status: batch.status, createdAt: batch.createdAt.toISOString() },
    items: batch.items.map(serializeIngestItem),
  });
}
