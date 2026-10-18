import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToDollars } from "@/lib/money";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";

/**
 * GET /api/orders
 *
 * Returns orders for the current user, split by role:
 *   ?type=purchases — orders where the user is the BUYER  (they bought something)
 *   ?type=sold      — orders where the user is the SELLER (they sold something)
 *
 * Each order includes the card details (title, image, condition) and
 * the other party's username so both tabs can render correctly (never their
 * email — this includes abandoned PENDING/EXPIRED checkouts, and the shop
 * handles pickup, so counterparties never need each other's contact details).
 *
 * Steps:
 *   1. Auth check — only logged-in users can see their orders.
 *   2. Read ?type query param — default to "purchases" if missing.
 *   3. Query the DB for orders where buyerId or sellerId = current user.
 *   4. Format amounts from cents → dollars and return.
 */
export async function GET(req: NextRequest) {
  // ── 1. Auth check ──────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // ── 2. Read query params ──────────────────────────────────────────────────
  const { searchParams } = new URL(req.url);
  const type      = searchParams.get("type") ?? "purchases";
  const sessionId = searchParams.get("sessionId");

  try {
    // ── 3. Query DB ────────────────────────────────────────────────────────────
    // When sessionId is provided, return all orders for that Stripe session
    // (any status — caller needs REFUNDED too). buyerId guard prevents
    // one user from peeking at another user's session.
    const where = sessionId
      ? { stripeCheckoutSessionId: sessionId, buyerId: userId }
      : type === "sold"
        ? { sellerId: userId }
        : { buyerId: userId };

    const orders = await prisma.order.findMany({
      where,
      include: {
        listing: {
          select: {
            id: true,
            imageUrls: true,
            condition: true,
            ...listingCatalogInclude,
          },
        },
        // Include the other party depending on tab:
        // - purchases: we want to know who sold it to us (seller)
        // - sold: we want to know who bought it from us (buyer)
        seller: { select: { id: true, username: true } },
        buyer:  { select: { id: true, username: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // ── 4. Format and return ───────────────────────────────────────────────────
    const formatted = orders.map((o) => {
      const listing = withListingDisplay(o.listing as any);
      return {
        id: o.id,
        status: o.status,
        amount: centsToDollars(o.amount),
        currency: o.currency,
        createdAt: o.createdAt.toISOString(),
        card: {
          id: listing.id,
          title: listing.title,
          imageUrl: listing.imageUrls?.[0] ?? null,
          condition: listing.condition,
        },
        // "other party" — who the user transacted with
        seller: {
          id: o.seller.id,
          username: o.seller.username,
        },
        buyer: {
          id: o.buyer.id,
          username: o.buyer.username,
        },
      };
    });

    return NextResponse.json({ orders: formatted });
  } catch (err) {
    console.error("[api/orders] error:", err);
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 });
  }
}
