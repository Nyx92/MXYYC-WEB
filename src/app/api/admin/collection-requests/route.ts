import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { OPEN_COLLECTION_STATUSES } from "@/lib/collectionRequests";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";

/**
 * GET /api/admin/collection-requests?status=open|completed — staff only.
 *
 * status=open (default): REQUESTED/PACKED, oldest first — backs the
 * "pack in advance" workflow.
 * status=completed: COLLECTED, newest first — the record-keeping view,
 * including who (if anyone) attributed the handover to themselves.
 */
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const status = new URL(req.url).searchParams.get("status") === "completed" ? "completed" : "open";

  try {
    const requests = await prisma.collectionRequest.findMany({
      where: status === "completed" ? { status: "COLLECTED" } : { status: { in: [...OPEN_COLLECTION_STATUSES] } },
      include: {
        user: { select: { id: true, username: true, firstName: true, lastName: true, email: true } },
        collectedByStaff: { select: { id: true, username: true } },
        listings: { include: listingCatalogInclude },
      },
      orderBy: status === "completed" ? { collectedAt: "desc" } : { requestedAt: "asc" },
      // Completed requests never leave this view, so it only grows over time —
      // cap it so the query doesn't scan the whole history. Open requests are
      // naturally self-limiting (they leave the view once packed/collected).
      ...(status === "completed" ? { take: 100 } : {}),
    });

    return NextResponse.json({
      requests: requests.map((r) => ({
        id: r.id,
        requestRef: r.requestRef,
        status: r.status,
        requestedAt: r.requestedAt,
        packedAt: r.packedAt,
        collectedAt: r.collectedAt,
        collectedByStaff: r.collectedByStaff,
        customer: r.user,
        // Only cards the customer still owns — staff must never pack a card
        // that has since been transferred to someone else.
        cards: r.listings
          .filter((listing) => listing.ownerId === r.user.id)
          .map((listing) => withListingDisplay(listing)),
      })),
    });
  } catch (err) {
    console.error("[admin/collection-requests] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
