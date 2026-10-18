import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { expireOffer } from "@/lib/offerExpiry";
import { notifyAsync } from "@/lib/notifications";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";
import { listingLockableWhere } from "@/lib/collectionRequests";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

/**
 * PATCH /api/offers/[id]
 * Seller accepts or rejects a pending offer.
 * Body: { action: "accept" | "reject" }
 *
 * ── Accept flow ────────────────────────────────────────────────────────────
 *   1. Retrieve the offer + its PaymentIntent ID, then atomically claim it
 *      (pending → accepted) so it can only be captured once.
 *   2. Capture the PaymentIntent via Stripe API.
 *      → Money moves from buyer to Stripe. No further action needed by buyer.
 *   3. Inside a DB transaction (atomic — all succeed or all roll back):
 *      a. Conditionally transfer card ownership to the buyer — 0 rows (card
 *         sold/locked concurrently) aborts the tx and refunds the buyer
 *      b. Mark offer status → "paid"
 *      c. Mark card as no longer for sale (forSale = false)
 *      d. Archive ALL offers on this card (new owner shouldn't see old offers)
 *      e. Create a CardTransaction record to preserve the sale history
 *   4. Update the offer status → "paid" and link to the Order (outside the
 *      main tx, after capture succeeds).
 *
 *   Why capture then transfer in one go?
 *   In the old flow, accept → buyer waits → buyer pays separately → webhook
 *   triggers transfer. With manual capture, the accept IS the payment — we
 *   capture and transfer atomically so there's no window where money moved
 *   but the card wasn't transferred (or vice versa).
 *
 * ── Reject flow ────────────────────────────────────────────────────────────
 *   1. Conditionally mark offer status pending → "rejected".
 *   2. Cancel the PaymentIntent via Stripe API.
 *      → Stripe releases the hold on the buyer's card. They are not charged.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }) {
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

    // ── 2. Load the offer and its listing ──────────────────────────────────
    const offer = await prisma.offer.findUnique({
      where: { id: params.id },
      include: {
        listing: { include: { ...listingCatalogInclude } },
      },
    });

    if (!offer)
      return NextResponse.json({ error: "Offer not found" }, { status: 404 });

    // Only the seller the offer was made to can act on it, and only while
    // they still own the card — a later owner (e.g. an auction winner) must
    // not be able to accept offers that were made to the previous owner.
    if (offer.sellerId !== userId || offer.listing.ownerId !== userId)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Archived offers belong to a card that has already been sold — they are
    // read-only history at this point.
    if (offer.archivedAt)
      return NextResponse.json({ error: "Offer is archived" }, { status: 409 });

    // Only pending offers can be acted on. Accepted/rejected/paid/expired are
    // terminal states (or mid-processing).
    if (offer.status !== "pending") {
      return NextResponse.json(
        { error: "Offer is not pending" },
        { status: 409 }
      );
    }

    // On-demand expiry guard — catches the window between expiresAt passing
    // and the cron job running. If the seller tries to accept/reject an offer
    // that has already passed its deadline (but is still "pending" in the DB
    // because the cron hasn't fired yet), we expire it right now — same two
    // steps as the cron: cancel the Stripe PI, then mark status → "expired".
    if (offer.expiresAt && offer.expiresAt < new Date()) {
      await expireOffer({
        id: offer.id,
        paymentIntentId: offer.paymentIntentId,
      });
      return NextResponse.json(
        { error: "This offer has expired" },
        { status: 409 }
      );
    }

    // The offer must have a PaymentIntent — it was created when the buyer
    // submitted the offer form. If it's missing, something went wrong upstream.
    if (!offer.paymentIntentId) {
      return NextResponse.json(
        { error: "No payment intent found for this offer" },
        { status: 409 }
      );
    }

    const listingId = offer.listing.id;
    const listingTitle = withListingDisplay(offer.listing).title;
    // withListingDisplay's tcgPlayerId falls back to "" (never null/undefined)
    // for a listing whose catalog row has none — the `|| undefined` here keeps
    // that as a real NULL in CardTransaction.tcgPlayerId rather than storing
    // "", which would otherwise pass the `IS NOT NULL` filter in the
    // "highest transacted" query (GET /api/home/featured) as a phantom
    // product with an empty id.
    const listingTcgPlayerId = withListingDisplay(offer.listing).tcgPlayerId || undefined;

    // ══════════════════════════════════════════════════════════════════════════
    // ACCEPT
    // ══════════════════════════════════════════════════════════════════════════
    if (action === "accept") {
      // ── 3. Guard: check card is not reserved by an active Buy Now checkout ──
      // Must run BEFORE capturing the PI. The checkout flow sets reservedById +
      // reservedUntil but leaves forSale: true until the webhook fires. If we
      // captured the PI first and then found the card was reserved, money would
      // have already moved with no way to roll it back cleanly.
      const currentListing = await prisma.listing.findUnique({
        where: { id: listingId },
        select: { reservedById: true, reservedUntil: true, inAuction: true },
      });
      if (
        currentListing?.reservedById &&
        currentListing.reservedUntil &&
        currentListing.reservedUntil > new Date()
      ) {
        return NextResponse.json(
          { error: "Card is currently reserved by a pending checkout" },
          { status: 409 }
        );
      }

      // ── 3b. Guard: check card is not in an active auction ────────────────
      // A card mid-auction must not also be sellable via an accepted offer —
      // settleAuction() transfers ownership unconditionally when the auction
      // ends, which would silently overwrite this accept's transfer.
      if (currentListing?.inAuction) {
        return NextResponse.json(
          { error: "Card is currently in an active auction" },
          { status: 409 }
        );
      }

      // ── 3c. Atomically claim the offer ────────────────────────────────────
      // The checks above are plain reads. Flipping pending → accepted with a
      // conditional write makes a double-click / concurrent accept of the
      // same offer capture at most once.
      const claim = await prisma.offer.updateMany({
        where: { id: params.id, status: "pending", archivedAt: null, paymentIntentId: offer.paymentIntentId },
        data: { status: "accepted" },
      });
      if (claim.count === 0) {
        return NextResponse.json({ error: "Offer is not pending" }, { status: 409 });
      }

      // ── 4. Capture the PaymentIntent ──────────────────────────────────────
      // This is the moment money moves. Stripe will charge the buyer's card
      // for the amount that was authorised when they placed the offer.
      // If capture fails (e.g. card issuer declined at capture time), we catch
      // the error and return 500 — the offer stays "pending" and the seller can
      // try again or the buyer can re-place the offer.
      let captured: Stripe.PaymentIntent;
      try {
        captured = await stripe.paymentIntents.capture(offer.paymentIntentId);
      } catch (captureErr) {
        // A failed call is ambiguous (e.g. a timeout after Stripe captured).
        // If the money did move, carry on and transfer; only release the
        // claim — so the seller can retry — when nothing was captured.
        const pi = await stripe.paymentIntents.retrieve(offer.paymentIntentId);
        if (pi.status === "succeeded") {
          captured = pi;
        } else {
          await prisma.offer.updateMany({
            where: { id: params.id, status: "accepted" },
            data: { status: "pending" },
          });
          throw captureErr;
        }
      }

      // The PI should now be "succeeded" — just for logging/debugging.
      console.log(
        `[offers PATCH] PI captured: ${captured.id} → ${captured.status}`
      );

      // ── 5. Atomic DB transaction ───────────────────────────────────────────
      // Everything below must either all succeed or all roll back.
      // We cannot have money captured but the card not transferred.
      let order: { id: string };
      try {
        const result = await prisma.$transaction(async (tx) => {
          // 5-pre. Transfer card ownership to the buyer — conditionally.
          //     Runs first so a lost race aborts before anything else is written.
          //     The WHERE re-checks, under the row lock, that the seller still
          //     owns the card and it is not in an auction, earmarked for
          //     collection, or held by a live Buy Now reservation. A concurrent
          //     accept of a *different* offer on the same card (or a webhook
          //     transfer) makes this match 0 rows → throw → refund below.
          //     - forSale = false, price = null, reservation fields cleared.
          const transfer = await tx.listing.updateMany({
            where: { id: listingId, ownerId: userId, ...listingLockableWhere() },
            data: {
              ownerId: offer.buyerId,
              forSale: false,
              price: null,
              reservedById: null,
              reservedUntil: null,
              reservedCheckoutSessionId: null,
            },
          });
          if (transfer.count !== 1) {
            throw new Error("LISTING_NO_LONGER_AVAILABLE");
          }

          // 5a. Create an Order record to represent this sale.
          //     This links the offer, buyer, seller, and amount for history/display.
          const order = await tx.order.create({
            data: {
              listingId,
              sellerId: userId, // seller = card owner = current user
              buyerId: offer.buyerId,
              amount: offer.price!, // already in cents
              currency: "sgd",
              status: "PAID",
              stripePaymentIntentId: offer.paymentIntentId,
            },
          });

          // 5b. Mark the offer as paid and link it to the Order.
          //     "paid" is the final happy-path status — the buyer got the card.
          await tx.offer.update({
            where: { id: params.id },
            data: {
              status: "paid",
              orderId: order.id,
            },
          });

          // 5c. Archive ALL offers on this card (pending, rejected, expired, etc.)
          //     The card is now sold — neither the new owner nor old buyers should
          //     see these in their active views. History is preserved via archivedAt.
          //     expiresAt = now hands the other buyers' still-pending holds to
          //     the next expire-offers cron run instead of keeping their funds
          //     held for up to 24h on a sold card (the cron only touches
          //     "pending" offers, so this one — now "paid" — is unaffected).
          await tx.offer.updateMany({
            where: { listingId, archivedAt: null },
            data: { archivedAt: new Date(), expiresAt: new Date() },
          });

          // 5e. Create a CardTransaction — permanent audit trail of who sold what,
          //     for how much, and which Stripe PI was used.
          //     (stripeEventId uses the PI id since there's no webhook event here)
          await tx.cardTransaction.create({
            data: {
              orderId: order.id,
              listingId,
              sellerId: userId,
              buyerId: offer.buyerId,
              amount: offer.price!,
              currency: "sgd",
              // Use the PI id as a unique key — there's one PI per offer,
              // so this prevents duplicate transaction records if PATCH is retried.
              stripeEventId: offer.paymentIntentId!,
              tcgPlayerId: listingTcgPlayerId,
            },
          });

          return { order };
        });
        order = result.order;
      } catch (txErr) {
        // DB failed AFTER the PI was captured — refund the buyer so they're
        // not charged for a card that never transferred. Mirrors the same
        // safety net in lib/auctionSettlement.ts's settleAuction().
        console.error(
          "[offers PATCH] DB transaction failed after capture, issuing refund:",
          txErr
        );
        try {
          await stripe.refunds.create({ payment_intent: offer.paymentIntentId! });
        } catch (refundErr) {
          console.error(
            "[offers PATCH] Refund also failed — manual intervention required:",
            refundErr
          );
        }
        // The PI is now captured + refunded, so this offer can never be
        // accepted again — close it out instead of leaving it "accepted".
        await prisma.offer.updateMany({
          where: { id: params.id, status: "accepted" },
          data: { status: "rejected" },
        });
        if (txErr instanceof Error && txErr.message === "LISTING_NO_LONGER_AVAILABLE") {
          return NextResponse.json(
            { error: "This card is no longer available. The buyer has been refunded." },
            { status: 409 }
          );
        }
        throw txErr;
      }

      console.log(
        `[offers PATCH] Card ${listingId} transferred to buyer ${offer.buyerId}. Order: ${order.id}`
      );

      // Notify the buyer — fire-and-forget.
      notifyAsync({
        userId:  offer.buyerId,
        type:    "offer_accepted",
        title:   `Your offer on "${listingTitle}" was accepted`,
        body:    `Great news! The seller accepted your offer. "${listingTitle}" is now yours.`,
        offerId: params.id,
        cardId:  listingId,
        orderId: order.id,
      });

      return NextResponse.json({ success: true });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // REJECT
    // ══════════════════════════════════════════════════════════════════════════

    // ── 5. Mark the offer as rejected in the DB ───────────────────────────────
    // Claimed first, conditionally, so a reject racing an accept can never
    // overwrite an offer that is being (or has been) captured.
    const rejected = await prisma.offer.updateMany({
      // Bound to the PI we read: if the buyer amended in between, this
      // misses (409) instead of rejecting while leaving the new hold live.
      where: { id: params.id, status: "pending", archivedAt: null, paymentIntentId: offer.paymentIntentId },
      data: { status: "rejected" },
    });
    if (rejected.count === 0) {
      return NextResponse.json({ error: "Offer is not pending" }, { status: 409 });
    }

    // ── 6. Cancel the PaymentIntent ───────────────────────────────────────────
    // This releases the hold on the buyer's card. No money moves.
    try {
      await stripe.paymentIntents.cancel(offer.paymentIntentId);
      console.log(`[offers PATCH] PI cancelled: ${offer.paymentIntentId}`);
    } catch (cancelErr) {
      // If the PI was already cancelled (e.g. expired, duplicate reject call),
      // log and continue — the offer is already rejected in our DB.
      console.warn(
        "[offers PATCH] Could not cancel PI (may already be cancelled):",
        offer.paymentIntentId,
        cancelErr
      );
    }

    // Notify the buyer — fire-and-forget.
    notifyAsync({
      userId:  offer.buyerId,
      type:    "offer_rejected",
      title:   `Your offer on "${listingTitle}" was declined`,
      body:    `The seller declined your offer on "${listingTitle}". Your payment hold has been released.`,
      offerId: params.id,
      cardId:  listingId,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[offers PATCH] error:", err);
    return NextResponse.json(
      { error: "Failed to update offer" },
      { status: 500 }
    );
  }
}
