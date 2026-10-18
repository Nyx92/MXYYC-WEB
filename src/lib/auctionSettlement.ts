/**
 * auctionSettlement.ts — shared logic for settling a completed auction.
 *
 * Called from three places:
 *   - POST /api/auctions/[id]/bid    (when a bid hits the reserve or buy-out price)
 *   - POST /api/auctions/[id]/decide (when the seller accepts after pending_seller_decision)
 *   - GET  /api/cron/expire-auctions (when the auction closes with highest bid >= reservePrice)
 *
 * Settlement mirrors the offer-accept flow in PATCH /api/offers/[id]:
 *   1. Capture the winning bid's PaymentIntent (money moves from buyer to platform).
 *   2. Atomic DB transaction:
 *      0. Conditionally claim the auction (open → "sold"); losing the claim
 *         to a concurrent settle/decline/expiry aborts and refunds
 *      a. Create Order record (sale history + amount)
 *      b. Create CardTransaction audit record (stripeEventId = PI id, same convention)
 *      c. Mark winning bid → "won"
 *      d. Mark all other active bids → "cancelled" (PI cancellations happen outside tx)
 *      e. Transfer card ownership from the seller (ownerId = winner,
 *         inAuction = false); 0 rows aborts and refunds
 *   3. If DB fails AFTER capture: issue a Stripe refund (compensating transaction)
 *      so the buyer is made whole.
 *   4. Cancel losing bidders' PIs (fire-and-forget, same pattern as expired offers).
 *   5. Notify winner and seller (fire-and-forget).
 */

import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { notifyAsync } from "@/lib/notifications";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

/**
 * settleAuction — captures the winning PI and completes the ownership transfer.
 * Safe to call multiple times: returns immediately if the auction is already "sold".
 */
export async function settleAuction(auctionId: string): Promise<void> {
  // 1. Load the auction with its current winning (active) bid and card metadata.
  const auction = await prisma.auction.findUnique({
    where: { id: auctionId },
    include: {
      bids: {
        where:   { status: "active" },
        orderBy: { amount: "desc" },
        take:    1,
      },
      listing: { select: { id: true, ...listingCatalogInclude } },
    },
  });

  if (!auction) throw new Error(`[auctionSettlement] Auction ${auctionId} not found`);
  if (auction.status === "sold") return; // already settled — idempotent

  const winningBid = auction.bids[0];
  if (!winningBid) throw new Error(`[auctionSettlement] No active bid on auction ${auctionId}`);

  const listingTitle = withListingDisplay(auction.listing as any).title;
  const listingTcgPlayerId = withListingDisplay(auction.listing as any).tcgPlayerId || undefined;

  // 2. Capture the winning PI. Money moves from buyer to platform.
  //    Capture first so the DB transaction can record the confirmed payment.
  //    If capture fails (issuer decline at capture time), we throw without
  //    touching the DB — auction stays in its current state for a retry.
  //    A failed capture call is ambiguous, so check where the PI really is:
  //    already captured (an earlier attempt died before the DB tx) → carry
  //    on and record the sale; cancelled (e.g. the ~7-day authorisation
  //    lapsed) → the bid can never be paid, so expire the auction instead of
  //    retrying a dead capture on every cron run.
  let captured: Stripe.PaymentIntent;
  try {
    captured = await stripe.paymentIntents.capture(winningBid.paymentIntentId);
  } catch (captureErr) {
    const pi = await stripe.paymentIntents.retrieve(winningBid.paymentIntentId);
    if (pi.status === "succeeded") {
      captured = pi;
    } else {
      if (pi.status === "canceled") {
        await expireAuction(auctionId, auction.listingId, auction.status as "active" | "pending_seller_decision");
      }
      throw captureErr;
    }
  }
  console.log(`[auctionSettlement] PI captured: ${captured.id} → ${captured.status}`);

  // 3. Atomic DB transaction — all succeed or all roll back.
  //    Cannot include Stripe calls here (they can't be rolled back).
  let losingBids: { id: string; paymentIntentId: string; bidderId: string }[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // 3a. Claim the auction: open → sold, conditionally. This is the single
      //     point that decides the outcome — a concurrent settle, a seller
      //     decline, or the cron's decision-timeout expiry all race on this
      //     same row, and only one transition can win. Losing → throw → the
      //     refund below. Once claimed, the bid route's version lock (which
      //     requires status "active") can no longer add bids.
      const claim = await tx.auction.updateMany({
        where: { id: auctionId, status: { in: ["active", "pending_seller_decision"] } },
        data:  {
          status:          "sold",
          currentBid:      winningBid.amount,
          highestBidderId: winningBid.bidderId,
        },
      });
      if (claim.count !== 1) throw new Error(`Auction ${auctionId} is no longer open`);

      // 3b. Snapshot losing bids AFTER the claim, so a bid that landed while
      //     the PI was being captured is included and gets its PI cancelled.
      losingBids = await tx.bid.findMany({
        where:  { auctionId, status: "active", id: { not: winningBid.id } },
        select: { id: true, paymentIntentId: true, bidderId: true },
      });

      // 4a. Create an Order record to represent this sale.
      const order = await tx.order.create({
        data: {
          listingId:              auction.listingId,
          sellerId:               auction.sellerId,
          buyerId:                winningBid.bidderId,
          amount:                 winningBid.amount,
          currency:               "sgd",
          status:                 "PAID",
          stripePaymentIntentId:  winningBid.paymentIntentId,
        },
      });

      // 4b. Permanent audit record.
      //     stripeEventId uses the PI id (same convention as PATCH /api/offers/[id])
      //     since auction settlements don't go through a Stripe webhook event.
      await tx.cardTransaction.create({
        data: {
          orderId:      order.id,
          listingId:    auction.listingId,
          sellerId:     auction.sellerId,
          buyerId:      winningBid.bidderId,
          amount:       winningBid.amount,
          currency:     "sgd",
          stripeEventId: winningBid.paymentIntentId,
          tcgPlayerId:  listingTcgPlayerId,
        },
      });

      // 4c. Mark winning bid as won.
      await tx.bid.update({
        where: { id: winningBid.id },
        data:  { status: "won" },
      });

      // 4d. Cancel all other active bids in the DB.
      //     Their Stripe PIs are cancelled outside the transaction (step 5).
      if (losingBids.length > 0) {
        await tx.bid.updateMany({
          where: { auctionId, status: "active", id: { not: winningBid.id } },
          data:  { status: "cancelled" },
        });
      }

      // 4e. Transfer card ownership — only from the seller. If the seller no
      //     longer owns the card (e.g. a duplicate auction already settled),
      //     abort and refund rather than take it from its current owner.
      const transfer = await tx.listing.updateMany({
        where: { id: auction.listingId, ownerId: auction.sellerId },
        data:  { ownerId: winningBid.bidderId, inAuction: false, forSale: false },
      });
      if (transfer.count !== 1) {
        throw new Error(`Listing ${auction.listingId} is no longer owned by the seller`);
      }
    });
  } catch (dbErr) {
    // DB failed AFTER PI was captured — refund the buyer to make them whole.
    console.error("[auctionSettlement] DB transaction failed after capture, issuing refund:", dbErr);
    try {
      await stripe.refunds.create({ payment_intent: winningBid.paymentIntentId });
    } catch (refundErr) {
      console.error("[auctionSettlement] Refund also failed — manual intervention required:", refundErr);
    }
    throw dbErr;
  }

  // 5. Cancel losing PIs outside the transaction — fire-and-forget.
  //    A background cron can sweep up any that slip through on transient errors.
  for (const bid of losingBids) {
    cancelBidPI(bid.paymentIntentId);
    notifyAsync({
      userId: bid.bidderId,
      type:   "auction_expired",
      title:  `Auction ended for "${listingTitle}"`,
      body:   `The auction for "${listingTitle}" has ended. You did not win this time.`,
      cardId: auction.listingId,
    });
  }

  // 6. Notify winner and seller.
  const amountDisplay = `S$${(winningBid.amount / 100).toFixed(2)}`;

  notifyAsync({
    userId: winningBid.bidderId,
    type:   "auction_won",
    title:  `You won "${listingTitle}"!`,
    body:   `Congratulations! You won the auction for "${listingTitle}" at ${amountDisplay}. The card is now yours.`,
    cardId: auction.listingId,
  });

  notifyAsync({
    userId: auction.sellerId,
    type:   "auction_sold",
    title:  `"${listingTitle}" sold via auction`,
    body:   `Your card "${listingTitle}" was sold for ${amountDisplay}.`,
    cardId: auction.listingId,
  });

  console.log(
    `[auctionSettlement] Settled. Auction: ${auctionId}, Winner: ${winningBid.bidderId}, Amount: ${winningBid.amount}`
  );
}

/**
 * cancelBidPI — cancels a bid's Stripe PI, swallowing terminal-state errors.
 * Exported so the cron and decide route can reuse it without duplicating
 * the payment_intent_unexpected_state guard (same pattern as expireOffer).
 */
export function cancelBidPI(paymentIntentId: string): void {
  stripe.paymentIntents.cancel(paymentIntentId).catch((err: { code?: string }) => {
    // payment_intent_unexpected_state = PI already captured/cancelled — safe to ignore.
    if (err?.code !== "payment_intent_unexpected_state") {
      console.error(`[auctionSettlement] Failed to cancel PI ${paymentIntentId}:`, err);
    }
  });
}

/**
 * expireAuction — the non-sale terminal transition (seller decline, decision
 * timeout, no bids). Claims the auction from `fromStatus` → "expired"
 * conditionally, so it can never overwrite a concurrent settlement, then
 * cancels EVERY still-active bid (including one that committed after the
 * caller read the auction) and releases the card lock. Their Stripe holds
 * are released after the transaction. Returns false (and changes nothing)
 * if the auction already left `fromStatus`.
 */
export async function expireAuction(
  auctionId: string,
  listingId: string,
  fromStatus: "active" | "pending_seller_decision"
): Promise<boolean> {
  const cancelledPIs = await prisma.$transaction(async (tx) => {
    const claim = await tx.auction.updateMany({
      where: { id: auctionId, status: fromStatus },
      data:  { status: "expired" },
    });
    if (claim.count !== 1) return null;

    const activeBids = await tx.bid.findMany({
      where:  { auctionId, status: "active" },
      select: { paymentIntentId: true },
    });
    if (activeBids.length > 0) {
      await tx.bid.updateMany({ where: { auctionId, status: "active" }, data: { status: "cancelled" } });
    }
    await tx.listing.update({ where: { id: listingId }, data: { inAuction: false } });
    return activeBids.map((b) => b.paymentIntentId);
  });

  if (cancelledPIs === null) return false;
  for (const pi of cancelledPIs) cancelBidPI(pi);
  return true;
}
