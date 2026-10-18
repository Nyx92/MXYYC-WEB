import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminOnly, CONFIDENT } from "@/lib/ingest";

/**
 * POST /api/admin/ingest/batches/[id]/approve-confident — admin: approves
 * every PENDING item the identifier was confident about and that has a card
 * selected. Uncertain items stay PENDING for a person to check.
 */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const denied = await adminOnly();
  if (denied) return denied;
  const { id } = await props.params;

  const { count } = await prisma.ingestItem.updateMany({
    where: {
      batchId: id,
      status: "PENDING",
      confidence: { in: CONFIDENT },
      OR: [{ pokemonCardId: { not: null } }, { riftboundCardId: { not: null } }],
    },
    data: { status: "APPROVED" },
  });
  return NextResponse.json({ approved: count });
}
