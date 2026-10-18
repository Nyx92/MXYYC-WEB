import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { settleAuction, expireAuction } from "@/lib/auctionSettlement";
import { notifyAsync } from "@/lib/notifications";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";

/**
 * POST /api/auctions/[id]/decide
 *
 * Seller accepts or rejects the highest bid during the pending_seller_decision window.
 * Only reachable when the auction status is "pending_seller_decision" and the
 * seller decision deadline has not yet passed.
 *
 * Accept flow:
 *   1. Verify auction state and deadline.
 *   2. Call settleAuction() — captures PI, transfers card, marks auction sold.
 *
 * Reject flow:
 *   1. Verify auction state and deadline.
 *   2. Conditionally claim the auction (pending_seller_decision → "expired"),
 *      cancel its active bid(s) and clear Listing.inAuction — via
 *      expireAuction(), which releases the PI holds only after the claim wins.
 *   3. Notify bidder.
 *
 * Body: { action: "accept" | "reject" }
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // ── 1. Auth check ──────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const { action } = await req.json();
    if (!["accept", "reject"].includes(action)) {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // ── 2. Load auction ────────────────────────────────────────────────────
    const auction = await prisma.auction.findUnique({
      where:   { id: params.id },
      include: {
        bids: {
          where:   { status: "active" },
          orderBy: { amount: "desc" },
          take:    1,
          select:  { id: true, paymentIntentId: true, bidderId: true, amount: true },
        },
        listing: { select: { id: true, ...listingCatalogInclude } },
      },
    });

    if (!auction) {
      return NextResponse.json({ error: "Auction not found" }, { status: 404 });
    }
    if (auction.sellerId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (auction.status !== "pending_seller_decision") {
      return NextResponse.json(
        { error: "Auction is not awaiting a seller decision" },
        { status: 409 }
      );
    }
    if (auction.sellerDecisionDeadline && auction.sellerDecisionDeadline < new Date()) {
      return NextResponse.json(
        { error: "The decision window has expired" },
        { status: 409 }
      );
    }

    const highestBid = auction.bids[0];
    if (!highestBid) {
      return NextResponse.json(
        { error: "No bids found on this auction" },
        { status: 409 }
      );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ACCEPT — delegate to settleAuction (captures PI + transfers card)
    // ══════════════════════════════════════════════════════════════════════════
    if (action === "accept") {
      await settleAuction(params.id);
      return NextResponse.json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // REJECT — cancel PI, expire auction, release card
    // ══════════════════════════════════════════════════════════════════════════

    // 3. Mark bid cancelled + auction expired + release the card — claimed
    //    conditionally so a decline can't overwrite a concurrent settlement.
    //    expireAuction also cancels the bid(s) and releases their PI holds.
    const declined = await expireAuction(params.id, auction.listing.id, "pending_seller_decision");
    if (!declined) {
      return NextResponse.json({ error: "Auction is no longer awaiting a decision" }, { status: 409 });
    }

    // 4. Notify the bidder that the seller declined.
    const listingTitle = withListingDisplay(auction.listing as any).title;
    notifyAsync({
      userId: highestBid.bidderId,
      type:   "auction_expired",
      title:  `Auction declined for "${listingTitle}"`,
      body:   `The seller chose not to accept the final bid on "${listingTitle}". Your hold has been released.`,
      cardId: auction.listing.id,
    });

    console.log(
      `[auctions/decide POST] Seller rejected auction ${params.id}. Bid ${highestBid.id} cancelled.`
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[auctions/decide POST] error:", err);
    return NextResponse.json(
      { error: "Failed to process decision" },
      { status: 500 }
    );
  }
}
