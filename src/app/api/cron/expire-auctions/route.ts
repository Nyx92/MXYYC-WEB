import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { settleAuction, expireAuction } from "@/lib/auctionSettlement";
import { notifyAsync } from "@/lib/notifications";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";

/**
 * GET /api/cron/expire-auctions  ← called by an external scheduler (cron-job.org)
 * POST /api/cron/expire-auctions ← kept for local curl testing
 *
 * Not a Vercel Cron Job — this project is on Vercel's Hobby plan, which
 * caps native cron jobs at once per day, too infrequent for timely auction
 * expiry. cron-job.org calls this URL directly on its own schedule, which
 * is configured entirely in its dashboard (not in this repo — see the
 * Security section below for the auth header it must send).
 *
 * Two passes per run:
 *
 * Pass 1 — Close active auctions whose endsAt has passed:
 *   a) No bids:
 *      → mark auction "expired", release Listing.inAuction
 *      → notify seller
 *   b) Highest bid >= reservePrice (or no RP set on the auction — auto-settle):
 *      Actually: if reservePrice is null, bid still goes to seller decision.
 *      Only auto-settle when a bid >= reservePrice AND reservePrice is set.
 *      → call settleAuction() (captures PI, transfers card)
 *   c) Highest bid < reservePrice (or reservePrice is null):
 *      → mark auction "pending_seller_decision"
 *      → set sellerDecisionDeadline = now + 24h
 *      → notify seller to decide
 *
 * Pass 2 — Expire pending_seller_decision auctions whose deadline has passed:
 *   → cancel highest bid PI
 *   → mark auction "expired", release Listing.inAuction, cancel bid
 *   → notify bidder and seller
 *
 * Security:
 * ─────────
 * Protected by CRON_SECRET env var — the caller must send
 * `Authorization: Bearer <CRON_SECRET>` or this returns 401. Set it in
 * Vercel → Settings → Environment Variables, in your local .env, and as a
 * custom header on the cron-job.org job hitting this URL.
 */

async function runExpiry(req: NextRequest): Promise<NextResponse> {
  // ── 1. Authorise the cron caller ──────────────────────────────────────────
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.CRON_SECRET;

  if (!expectedToken) {
    console.error("[cron/expire-auctions] CRON_SECRET env var is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const results = {
    settled:    0,
    pendingDecision: 0,
    expiredNoBids: 0,
    expiredDecisionTimeout: 0,
    failed: 0,
    errors: [] as string[],
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PASS 1 — Active auctions past their end time
  // ═══════════════════════════════════════════════════════════════════════════

  const activeExpired = await prisma.auction.findMany({
    where: { status: "active", endsAt: { lt: now } },
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

  for (const auction of activeExpired) {
    try {
      const topBid = auction.bids[0];
      const listingTitle = withListingDisplay(auction.listing as any).title;

      // ── 1a. No bids — expire immediately ──────────────────────────────────
      if (!topBid) {
        // 1. Expire the auction and release the card lock atomically
        //    (conditional on still being "active").
        if (!(await expireAuction(auction.id, auction.listing.id, "active"))) continue;

        // 2. Notify the seller — fire-and-forget (does not block the loop).
        notifyAsync({
          userId: auction.sellerId,
          type:   "auction_expired",
          title:  `Auction ended with no bids: "${listingTitle}"`,
          body:   `Your auction for "${listingTitle}" ended without any bids.`,
          cardId: auction.listing.id,
        });

        results.expiredNoBids++;
        continue;
      }

      // ── 1b. Bid >= reservePrice → auto-settle (no seller action needed) ───
      // 1. Capture the winning PI, transfer card ownership, and mark sold.
      //    (See auctionSettlement.ts for the full numbered sequence.)
      if (auction.reservePrice !== null && topBid.amount >= auction.reservePrice) {
        await settleAuction(auction.id);
        results.settled++;
        continue;
      }

      // ── 1c. Bid below RP (or no RP set) → seller decision window ─────────
      // 1. Compute the 24-hour deadline from now.
      const deadline = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // 2. Flip auction to pending_seller_decision and record the deadline —
      //    only if still "active", so a buy-out that settled concurrently is
      //    never flipped back. listing.inAuction stays true — the card remains
      //    locked until seller decides.
      const flipped = await prisma.auction.updateMany({
        where: { id: auction.id, status: "active" },
        data:  { status: "pending_seller_decision", sellerDecisionDeadline: deadline },
      });
      if (flipped.count !== 1) continue;

      // 3. Notify the seller to accept or decline — fire-and-forget.
      notifyAsync({
        userId: auction.sellerId,
        type:   "auction_decision_needed",
        title:  `Decision needed: "${listingTitle}"`,
        body:   `Your auction for "${listingTitle}" ended with a top bid of S$${(topBid.amount / 100).toFixed(2)}. You have 24 hours to accept or decline.`,
        cardId: auction.listing.id,
      });

      results.pendingDecision++;
    } catch (err) {
      results.failed++;
      results.errors.push(
        `Auction ${auction.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error("[cron/expire-auctions] Pass 1 failed for auction:", auction.id, err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASS 2 — pending_seller_decision auctions past their deadline
  // ═══════════════════════════════════════════════════════════════════════════

  const decisionExpired = await prisma.auction.findMany({
    where: {
      status:                  "pending_seller_decision",
      sellerDecisionDeadline:  { lt: now },
    },
    include: {
      bids: {
        where:   { status: "active" },
        orderBy: { amount: "desc" },
        take:    1,
        select:  { id: true, paymentIntentId: true, bidderId: true },
      },
      listing: { select: { id: true, ...listingCatalogInclude } },
    },
  });

  for (const auction of decisionExpired) {
    try {
      const topBid = auction.bids[0];

      if (topBid) {
        // 1. Cancel bid, expire auction, and release card lock atomically —
        //    conditional on still awaiting a decision, so a seller accept
        //    that settled concurrently is never flipped back to "expired".
        //    expireAuction also cancels the bid and releases its PI hold.
        if (!(await expireAuction(auction.id, auction.listing.id, "pending_seller_decision"))) {
          continue;
        }

        // 2. Notify the bidder their hold is released — fire-and-forget.
        //    Note: seller is not notified here (they chose not to respond).
        notifyAsync({
          userId: topBid.bidderId,
          type:   "auction_expired",
          title:  `Auction expired: "${withListingDisplay(auction.listing as any).title}"`,
          body:   `The seller did not respond in time on "${withListingDisplay(auction.listing as any).title}". Your payment hold has been released.`,
          cardId: auction.listing.id,
        });
      } else {
        // Edge case: no active bid found (e.g. bid was already cancelled externally).
        // 1. Expire the auction and release the card lock.
        if (!(await expireAuction(auction.id, auction.listing.id, "pending_seller_decision"))) continue;
      }

      results.expiredDecisionTimeout++;
    } catch (err) {
      results.failed++;
      results.errors.push(
        `Auction ${auction.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error("[cron/expire-auctions] Pass 2 failed for auction:", auction.id, err);
    }
  }

  console.log("[cron/expire-auctions] Done.", results);

  return NextResponse.json({
    settled:                results.settled,
    pendingDecision:        results.pendingDecision,
    expiredNoBids:          results.expiredNoBids,
    expiredDecisionTimeout: results.expiredDecisionTimeout,
    failed:                 results.failed,
    ...(results.errors.length > 0 && { errors: results.errors }),
  });
}

export const GET  = runExpiry;
export const POST = runExpiry;
