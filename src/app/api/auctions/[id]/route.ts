import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { centsToDollars } from "@/lib/money";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";

/**
 * GET /api/auctions/[id]
 *
 * Returns the auction record with its bids (amounts + statuses, no PI ids exposed)
 * and the associated card. Public endpoint — no auth required.
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auction = await prisma.auction.findUnique({
      where:   { id: params.id },
      include: {
        listing: {
          select: {
            id: true, imageUrls: true, condition: true, inAuction: true,
            owner: { select: { id: true, username: true } },
            ...listingCatalogInclude,
          },
        },
        bids: {
          // Public bid history: amounts/statuses only. Bidder identities are
          // left out (this endpoint needs no login), and PI ids are internal
          // Stripe references.
          select: { id: true, amount: true, status: true, createdAt: true },
          orderBy: { amount: "desc" },
        },
        _count: { select: { bids: true } },
      },
    });

    if (!auction) {
      return NextResponse.json({ error: "Auction not found" }, { status: 404 });
    }

    return NextResponse.json({
      auction: {
        id:             auction.id,
        cardId:         auction.listingId,
        sellerId:       auction.sellerId,
        startingBid:    centsToDollars(auction.startingBid),
        reservePrice:   auction.reservePrice  != null ? centsToDollars(auction.reservePrice)  : null,
        buyOutPrice:    auction.buyOutPrice   != null ? centsToDollars(auction.buyOutPrice)   : null,
        currentBid:     auction.currentBid   != null ? centsToDollars(auction.currentBid)    : null,
        status:          auction.status,
        endsAt:          auction.endsAt.toISOString(),
        sellerDecisionDeadline: auction.sellerDecisionDeadline?.toISOString() ?? null,
        version:         auction.version,
        bidCount:        auction._count.bids,
        card:            withListingDisplay(auction.listing as any),
        bids: auction.bids.map((b) => ({
          ...b,
          amount:    centsToDollars(b.amount),
          createdAt: b.createdAt.toISOString(),
        })),
      },
    });
  } catch (err) {
    console.error("[auctions/[id] GET] error:", err);
    return NextResponse.json({ error: "Failed to fetch auction" }, { status: 500 });
  }
}
