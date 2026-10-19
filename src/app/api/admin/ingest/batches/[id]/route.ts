import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { adminOnly, ingestItemInclude, serializeIngestItems } from "@/lib/ingest";

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
    items: await serializeIngestItems(batch.items),
  });
}

/**
 * PATCH /api/admin/ingest/batches/[id] — admin: { status: "OPEN" | "CLOSED" }.
 * Closing only hides a finished batch from the Card Intake list; its items
 * and listings are untouched. Scans sent later under the same name start a
 * new open batch.
 */
export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  const denied = await adminOnly();
  if (denied) return denied;
  const { id } = await props.params;

  const body = await req.json().catch(() => ({}));
  if (body.status !== "OPEN" && body.status !== "CLOSED") {
    return NextResponse.json({ error: 'status must be "OPEN" or "CLOSED"' }, { status: 400 });
  }
  const { count } = await prisma.ingestBatch.updateMany({ where: { id }, data: { status: body.status } });
  if (count !== 1) return NextResponse.json({ error: "Batch not found" }, { status: 404 });
  return NextResponse.json({ ok: true, status: body.status });
}
