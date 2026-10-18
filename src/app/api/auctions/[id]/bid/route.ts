import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dollarsToCents } from "@/lib/money";
import { settleAuction, cancelBidPI } from "@/lib/auctionSettlement";
import { notifyAsync } from "@/lib/notifications";
import { verifyPaymentIntentAmountOrRespond } from "@/lib/paymentIntentGuard";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";
import { rateLimitResponse } from "@/lib/rateLimit";
import { requireVerifiedForPurchase } from "@/lib/purchaseVerification";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

/**
 * POST /api/auctions/[id]/bid
 *
 * Step 2 of 2 for placing a bid (mirrors POST /api/offers).
 *
 * By this point the buyer has:
 *   1. Created a PI via POST /api/auctions/[id]/bid/intent.
 *   2. Confirmed the PI via stripe.confirmCardPayment() in the browser.
 *      Funds are authorised (held) but NOT charged yet.
 *
 * Flow:
 *   1. Auth, rate limit, purchase-verification gate, parse body.
 *   2. Verify the PI with Stripe: metadata must name this bidder and this
 *      auction, and status must be "requires_capture". Nothing cancels the
 *      PI before this ownership check passes.
 *   3. Re-validate auction state (active, not ended).
 *   4. Read the current highest bid (to cancel its PI if we win the lock).
 *   5. DB transaction with optimistic version lock:
 *      a. updateMany auction WHERE version = snapshot → 0 rows = 409 (concurrent bid)
 *      b. Mark previous highest bid → "cancelled" in DB
 *      c. Create new Bid record
 *   6. On concurrent bid (409): cancel our new PI, return 409.
 *   7. Cancel previous PI (fire-and-forget).
 *   8. Notify seller (bid_received) and outbid bidder (outbid).
 *   9. If bid >= reservePrice or buyOutPrice → settleAuction (instant sale).
 *  10. Return success.
 *
 * Body: { paymentIntentId, amount } — amount in dollars
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auctionId = params.id;

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const bidderId = session.user.id;

  // 🔒 Same per-user bucket rationale as POST /api/auctions/[id]/bid/intent —
  // this route calls Stripe (retrieve/cancel/capture).
  const limited = rateLimitResponse(`bid:${bidderId}`, { limit: 20, windowMs: 60 * 1000 });
  if (limited) return limited;

  // 🔒 Re-checked here, not only at PI creation — this is the route that
  // commits the bid (and can capture it on buy-out).
  const verificationError = await requireVerifiedForPurchase(bidderId);
  if (verificationError) return verificationError;

  try {
    const { paymentIntentId, amount } = await req.json();

    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return NextResponse.json({ error: "Missing paymentIntentId" }, { status: 400 });
    }

    const amountCents = dollarsToCents(Number(amount));
    if (!amount || amountCents <= 0) {
      return NextResponse.json({ error: "Invalid bid amount" }, { status: 400 });
    }

    // ── 2. Verify the PI belongs to this bidder AND this auction ─────────────
    // Runs before anything that can cancel the PI, so a caller can never
    // cancel (or bid with) someone else's authorised hold — e.g. an offer PI
    // id, which sellers can see, or a PI authorised for a different auction.
    // Must be "requires_capture" — means the buyer's card was successfully
    // authorised in the browser (funds are held, not charged yet).
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi.metadata?.bidderId !== bidderId || pi.metadata?.auctionId !== auctionId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (pi.status !== "requires_capture") {
      return NextResponse.json(
        { error: `Payment authorisation failed (status: ${pi.status})` },
        { status: 409 }
      );
    }
    // A PI backs exactly one bid. Re-submitting one already on a Bid row
    // (e.g. your own current top bid) must not reach the cancel paths below,
    // or the live bid would be left pointing at a cancelled hold that can
    // never be captured.
    const alreadyUsed = await prisma.bid.findFirst({
      where:  { paymentIntentId },
      select: { id: true },
    });
    if (alreadyUsed) {
      return NextResponse.json(
        { error: "This payment authorisation has already been used for a bid" },
        { status: 409 }
      );
    }

    // ── 3. Load the auction snapshot ─────────────────────────────────────────
    const auction = await prisma.auction.findUnique({
      where:  { id: auctionId },
      select: {
        id: true, status: true, endsAt: true, sellerId: true, version: true,
        startingBid: true, currentBid: true, highestBidderId: true,
        reservePrice: true, buyOutPrice: true,
        listing: { select: { id: true, ...listingCatalogInclude } },
      },
    });

    if (!auction) {
      return NextResponse.json({ error: "Auction not found" }, { status: 404 });
    }
    if (auction.status !== "active") {
      await cancelSafely(paymentIntentId);
      return NextResponse.json({ error: "Auction is not active" }, { status: 409 });
    }
    if (auction.endsAt < new Date()) {
      await cancelSafely(paymentIntentId);
      return NextResponse.json({ error: "Auction has ended" }, { status: 409 });
    }
    if (auction.sellerId === bidderId) {
      await cancelSafely(paymentIntentId);
      return NextResponse.json(
        { error: "You cannot bid on your own auction" },
        { status: 403 }
      );
    }
    if (amountCents < auction.startingBid) {
      await cancelSafely(paymentIntentId);
      return NextResponse.json(
        { error: `Bid must be at least S$${(auction.startingBid / 100).toFixed(2)}` },
        { status: 400 }
      );
    }
    if (auction.buyOutPrice !== null && amountCents > auction.buyOutPrice) {
      await cancelSafely(paymentIntentId);
      return NextResponse.json(
        { error: `Bid cannot exceed the buy-out price of S$${(auction.buyOutPrice / 100).toFixed(2)}` },
        { status: 400 }
      );
    }
    if (auction.currentBid !== null && amountCents <= auction.currentBid) {
      await cancelSafely(paymentIntentId);
      return NextResponse.json(
        { error: `Bid must be higher than the current bid of S$${(auction.currentBid / 100).toFixed(2)}` },
        { status: 400 }
      );
    }

    // ── 3b. Verify the authorised amount matches the claimed bid ─────────────
    // Without this, a bidder could authorise a small PI via
    // POST /api/auctions/[id]/bid/intent, then submit an arbitrarily larger
    // `amount` here — currentBid/Bid.amount would record the larger figure
    // while Stripe only ever holds/captures the smaller one.
    const amountMismatch = await verifyPaymentIntentAmountOrRespond(
      stripe,
      paymentIntentId,
      pi.amount,
      amountCents,
      "Bid"
    );
    if (amountMismatch) return amountMismatch;

    // ── 4. Snapshot the current highest bid before writing ───────────────────
    // We need its PI id to cancel it after winning the lock.
    const previousBid = auction.highestBidderId
      ? await prisma.bid.findFirst({
          where:   { auctionId, status: "active" },
          orderBy: { amount: "desc" },
          select:  { id: true, paymentIntentId: true, bidderId: true },
        })
      : null;

    // ── 5. Version-locked DB transaction ─────────────────────────────────────
    // Only one bid writer can match the current version and bump it.
    // If another bid landed between our read (step 2) and this write, the
    // version will have incremented and updateMany returns count = 0.
    let newBidId: string;
    try {
      const result = await prisma.$transaction(async (tx) => {
        // 5a. Optimistic lock — atomically claim the "current highest bidder" slot.
        const lockResult = await tx.auction.updateMany({
          where: { id: auctionId, version: auction.version, status: "active" },
          data:  {
            currentBid:      amountCents,
            highestBidderId: bidderId,
            version:         { increment: 1 },
          },
        });

        if (lockResult.count === 0) {
          // Another bid won the race — cancel our PI and tell the buyer to retry.
          throw new Error("CONCURRENT_BID");
        }

        // 5b. Mark the previous highest bid as cancelled in the DB.
        //     Its Stripe PI is cancelled outside the transaction in step 7.
        if (previousBid) {
          await tx.bid.update({
            where: { id: previousBid.id },
            data:  { status: "cancelled" },
          });
        }

        // 5c. Record this bid.
        const bid = await tx.bid.create({
          data: { auctionId, bidderId, amount: amountCents, paymentIntentId, status: "active" },
        });

        return bid;
      });

      newBidId = result.id;
    } catch (err) {
      if (err instanceof Error && err.message === "CONCURRENT_BID") {
        // ── 6. Lost the lock — release our PI and ask buyer to retry ─────────
        await cancelSafely(paymentIntentId);
        return NextResponse.json(
          { error: "A higher bid was placed at the same time. Please refresh and try again." },
          { status: 409 }
        );
      }
      // Unique index on Bid.paymentIntentId: a simultaneous copy of this
      // request already saved a bid with this PI. Its hold must stay live.
      if ((err as { code?: string })?.code === "P2002") {
        return NextResponse.json(
          { error: "This payment authorisation has already been used for a bid" },
          { status: 409 }
        );
      }
      // Unexpected DB error — cancel our PI so funds are not stranded.
      await cancelSafely(paymentIntentId);
      throw err;
    }

    console.log(
      `[auctions/bid POST] Bid ${newBidId} placed on auction ${auctionId} by ${bidderId} for ${amountCents}`
    );

    // ── 7. Cancel the previous bidder's PI (fire-and-forget) ─────────────────
    if (previousBid) {
      cancelBidPI(previousBid.paymentIntentId);
    }

    // ── 8. Notify seller and outbid bidder ────────────────────────────────────
    const listingTitle = withListingDisplay(auction.listing as any).title;

    notifyAsync({
      userId: auction.sellerId,
      type:   "bid_received",
      title:  `New bid on "${listingTitle}"`,
      body:   `Someone placed a bid of S$${(amountCents / 100).toFixed(2)} on "${listingTitle}".`,
      cardId: auction.listing.id,
    });

    if (previousBid && previousBid.bidderId !== bidderId) {
      notifyAsync({
        userId: previousBid.bidderId,
        type:   "outbid",
        title:  `You've been outbid on "${listingTitle}"`,
        body:   `Someone placed a higher bid on "${listingTitle}". Place a new bid to stay in the running.`,
        cardId: auction.listing.id,
      });
    }

    // ── 9. Instant settlement if bid hits the buy-out price ──────────────────
    // Only BO ends the auction immediately. RP is NOT an instant-win trigger —
    // it is a "minimum acceptable" floor checked by the cron at endsAt:
    //   bid >= RP at end  → cron auto-settles (no seller action required)
    //   bid >= BO during  → auction ends right now
    const hitsBuyOut = auction.buyOutPrice !== null && amountCents >= auction.buyOutPrice;

    if (hitsBuyOut) {
      console.log(`[auctions/bid POST] Buy-out price hit — settling auction ${auctionId}`);
      // The bid is already committed. If settling fails (capture decline,
      // lost claim), report the bid as placed-but-unsettled rather than
      // "failed" — the cron settles it at endsAt.
      try {
        await settleAuction(auctionId);
      } catch (settleErr) {
        console.error(`[auctions/bid POST] Instant settlement failed for ${auctionId}:`, settleErr);
        return NextResponse.json({ success: true, settled: false });
      }
      return NextResponse.json({ success: true, settled: true });
    }

    return NextResponse.json({ success: true, settled: false });
  } catch (err) {
    console.error("[auctions/bid POST] error:", err);
    return NextResponse.json({ error: "Failed to place bid" }, { status: 500 });
  }
}

// Cancels a PI silently — used to clean up when validation fails after
// the buyer already authorised their card. Never cancels a PI that a saved
// bid uses: if the same request arrives twice at once, the copy that loses
// the version lock must not void the hold behind the copy that won — every
// saved bid has to keep a capturable payment.
async function cancelSafely(paymentIntentId: string): Promise<void> {
  try {
    const savedBid = await prisma.bid.findFirst({
      where:  { paymentIntentId },
      select: { id: true },
    });
    if (savedBid) return;
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch {
    // PI may already be in a terminal state — safe to ignore.
  }
}
