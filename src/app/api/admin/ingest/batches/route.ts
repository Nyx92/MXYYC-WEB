import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminOnly } from "@/lib/ingest";

/**
 * GET /api/admin/ingest/batches[?closed=1] — admin: newest 50 open scan
 * batches (closed ones too with ?closed=1), with item counts per status.
 */
export async function GET(req: Request) {
  const denied = await adminOnly();
  if (denied) return denied;

  const includeClosed = new URL(req.url).searchParams.get("closed") === "1";
  const batches = await prisma.ingestBatch.findMany({
    where: includeClosed ? {} : { status: "OPEN" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
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
