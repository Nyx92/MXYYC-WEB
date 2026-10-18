import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminOnly } from "@/lib/ingest";

/** GET /api/admin/ingest/batches — admin: newest 50 scan batches with item counts per status. */
export async function GET() {
  const denied = await adminOnly();
  if (denied) return denied;

  const batches = await prisma.ingestBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  const counts = await prisma.ingestItem.groupBy({
    by: ["batchId", "status"],
    where: { batchId: { in: batches.map((b) => b.id) } },
    _count: { _all: true },
  });
  return NextResponse.json({
    batches: batches.map((b) => ({
      id: b.id,
      name: b.name,
      game: b.game,
      status: b.status,
      createdAt: b.createdAt.toISOString(),
      counts: Object.fromEntries(counts.filter((c) => c.batchId === b.id).map((c) => [c.status, c._count._all])),
    })),
  });
}
