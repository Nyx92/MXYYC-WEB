import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

/**
 * expireOffer(offerId)
 *
 * Marks a single offer as "expired" and cancels its Stripe PaymentIntent.
 * This is the shared helper used by both:
 *   - The cron job (POST /api/cron/expire-offers) — runs on a schedule
 *     to bulk-expire all offers where expiresAt has passed.
 *   - Any future on-demand expiry check (e.g. before displaying an offer).
 *
 * Steps:
 *   1. Cancel the Stripe PaymentIntent (releases the hold on buyer's card).
 *   2. Mark the offer status → "expired" in the DB.
 *
 * Order matters: we cancel the PI first. If the DB update fails, we can
 * retry — a cancelled PI is idempotent (cancelling an already-cancelled PI
 * just returns the same object). If we updated the DB first and then the
 * PI cancel failed, we'd have an "expired" DB record with an active hold —
 * the buyer would be stuck with a charge they can't pay or cancel.
 */
export async function expireOffer(offer: {
  id: string;
  paymentIntentId: string | null;
}) {
  // ── Step 1: Cancel the Stripe PaymentIntent ───────────────────────────────
  let capturedWithoutSale = false;
  if (offer.paymentIntentId) {
    try {
      await stripe.paymentIntents.cancel(offer.paymentIntentId);
    } catch (err: unknown) {
      const stripeErr = err as { code?: string; message?: string };

      if (stripeErr?.code === "payment_intent_unexpected_state") {
        // PI is already in a terminal state (cancelled, captured, etc.).
        // The hold is already released or the payment already went through —
        // safe to fall through and mark the offer expired in the DB.
        console.warn(
          "[offerExpiry] PI already in terminal state, skipping cancel:",
          offer.paymentIntentId
        );
        // "Terminal" includes captured. A still-pending offer whose PI was
        // captured means the buyer paid and never got the card — refunded
        // below, but only if this call is the one that expires the offer.
        const pi = await stripe.paymentIntents.retrieve(offer.paymentIntentId);
        capturedWithoutSale = pi?.status === "succeeded";
      } else {
        // Unexpected error (network failure, Stripe outage, etc.).
        // Re-throw so the DB update below does NOT run.
        // The offer stays "pending" and the cron will retry on its next run.
        // This prevents the offer from being permanently stranded as "expired"
        // in our DB while the PI is still holding the buyer's funds on Stripe.
        console.error(
          "[offerExpiry] Unexpected error cancelling PI — leaving offer pending for retry:",
          offer.paymentIntentId,
          stripeErr
        );
        throw err;
      }
    }
  }

  // ── Step 2: Mark offer as expired in DB ───────────────────────────────────
  // Conditional on still being pending: if the seller accepted concurrently
  // (the cancel above then hits a captured PI), a blind update would flip a
  // paid offer to "expired" and hide the sale.
  const { count } = await prisma.offer.updateMany({
    where: { id: offer.id, status: "pending" },
    data: { status: "expired" },
  });
  if (count === 1 && capturedWithoutSale && offer.paymentIntentId) {
    await stripe.refunds.create({ payment_intent: offer.paymentIntentId });
  }
}

/**
 * recoverStuckAcceptedOffer — PATCH /api/offers/[id] briefly moves an offer
 * to "accepted" while it captures. If that request dies between the claim
 * and its own capture/revert, the offer would stay "accepted" forever (expiry
 * only handles "pending") with the buyer's funds held or charged. The
 * expire-offers cron calls this for offers stuck in "accepted": it releases
 * an uncaptured hold or refunds a captured one, then closes the offer.
 */
export async function recoverStuckAcceptedOffer(offer: {
  id: string;
  paymentIntentId: string | null;
}) {
  if (offer.paymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(offer.paymentIntentId);
    if (pi.status === "requires_capture") {
      await stripe.paymentIntents.cancel(offer.paymentIntentId);
    } else if (pi.status === "succeeded") {
      await stripe.refunds.create({ payment_intent: offer.paymentIntentId });
    }
  }
  await prisma.offer.updateMany({
    where: { id: offer.id, status: "accepted" },
    data: { status: "expired" },
  });
}
