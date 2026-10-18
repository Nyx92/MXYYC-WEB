import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveCollectionNotification } from "@/lib/discord";
import { notifyAsync } from "@/lib/notifications";

/**
 * POST /api/collection-requests/[id]/mark-packed — staff only.
 *
 * Marks a REQUESTED pickup as PACKED (cards physically pulled and bagged),
 * resolves the Discord alert, and notifies the customer in-app that it's
 * ready. Only after this can the customer request their pickup OTP — see
 * POST /api/collection-requests/[id]/otp/request.
 */
export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const request = await prisma.collectionRequest.findUnique({ where: { id: params.id } });
    if (!request) {
      return NextResponse.json({ error: "Pickup request not found" }, { status: 404 });
    }
    if (request.status !== "REQUESTED") {
      return NextResponse.json({ error: `Cannot pack a request that is ${request.status}` }, { status: 409 });
    }

    // Conditional on still being REQUESTED — a concurrent top-up or a second
    // staff click must not be silently overwritten.
    const packedAt = new Date();
    const { count } = await prisma.collectionRequest.updateMany({
      where: { id: request.id, status: "REQUESTED" },
      data: { status: "PACKED", packedAt },
    });
    if (count === 0) {
      return NextResponse.json({ error: "This request changed — please refresh and try again" }, { status: 409 });
    }
    const updated = { ...request, status: "PACKED" as const, packedAt };

    const adminName = session.user.username ?? session.user.firstName ?? session.user.email;
    resolveCollectionNotification({
      messageIds: request.discordMessageIds,
      requestRef: request.requestRef,
      adminName: adminName ?? "staff",
    }).catch((err) => console.error("[mark-packed] Discord resolve failed:", err));

    notifyAsync({
      userId: request.userId,
      type: "collection_packed",
      title: "Your pickup is ready",
      body: `Pickup ${request.requestRef} has been packed and is ready for collection at the shop.`,
    });

    return NextResponse.json({ request: updated });
  } catch (err) {
    console.error("[mark-packed] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
