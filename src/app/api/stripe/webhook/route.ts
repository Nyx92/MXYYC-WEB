/**
 * POST /api/stripe/webhook
 *
 * This is Stripe's entry point into our system. Every event that Stripe sends
 * (payment completed, session expired, etc.) arrives here as a signed HTTP POST.
 *
 * ── How Stripe webhooks work ────────────────────────────────────────────────
 * Stripe sends events asynchronously. When a buyer completes checkout on Stripe's
 * hosted page, Stripe immediately captures the payment and then fires a
 * `checkout.session.completed` event to this endpoint. The buyer's browser is
 * redirected to our /checkout/success page at roughly the same time, but the
 * webhook and the redirect are INDEPENDENT — do not rely on ordering between them.
 *
 * Stripe retries failed webhooks (non-2xx response) up to 3 days with exponential
 * backoff. This means any handler here can be called more than once for the same
 * event. All processing must be idempotent.
 *
 * ── Event types handled ──────────────────────────────────────────────────────
 *
 *   checkout.session.completed  (payment_status: "paid")
 *     The buyer has paid. Steps (see handleSessionCompleted / handleSingleSessionCompleted
 *     / handleCartSessionCompleted for numbered inline comments):
 *       1.  Verify payment_status === "paid"
 *       2.  Guard: skip if session was already refunded (Stripe retry after auto-refund)
 *       3.  Extract metadata, resolve paymentIntentId
 *       4.  Branch → cart path or single-item path
 *       --- inside the DB transaction ---
 *       5.  Idempotency check — skip if event already processed
 *       6.  Fetch & validate order
 *       7.  Mark order PAID
 *       8.  Create CardTransaction audit record
 *       9.  Transfer listing ownership (guarded updateMany)
 *       10. Archive open offers on the listing
 *       11. (Cart only) Remove purchased items from buyer's cart
 *     If ANY step 7–11 fails → auto-refund fires (see issueRefundOnTransferFailure)
 *
 *   checkout.session.expired
 *     The buyer did not complete payment. Steps:
 *       1. Mark pending orders EXPIRED
 *       2. Release listing reservations so other buyers can purchase
 *
 * ── Single-item vs cart checkout ─────────────────────────────────────────────
 * Our app supports two checkout flows:
 *   - Single-item: one listing → one order → metadata contains orderId/cardId/buyerId/sellerId
 *   - Cart:        N listings → N orders → metadata contains checkoutType="cart" and buyerId
 *
 * The webhook branches on `session.metadata.checkoutType` to handle each case.
 */

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { transferCardOwnership, notifySellerCardSold } from "@/lib/webhookHelpers";
import { releaseCheckoutSession } from "@/lib/checkoutSessions";

// Webhooks must run on Node runtime (Stripe SDK + raw-body signature verification)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

export async function POST(req: NextRequest) {
  // ── Step 1: Verify the webhook signature ─────────────────────────────────
  // Stripe signs every payload with STRIPE_WEBHOOK_SECRET. We verify it before
  // trusting any data — without this, anyone could POST fake events and trigger
  // fraudulent transfers or refunds.
  //
  // Step 1a: Ensure the signature header is present.
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    console.warn("[webhook] ❌ No signature found in headers");
    return NextResponse.json(
      { error: "Missing Stripe signature" },
      { status: 400 }
    );
  }

  // Step 1b: Read the raw body (must be text, not parsed JSON — the signature
  // is computed over the exact bytes Stripe sent; any transformation breaks it)
  // and call constructEvent, which verifies the signature cryptographically.
  const body = await req.text();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET as string
    );
    console.log(`[webhook] ✅ Event verified: ${event.id} [${event.type}]`);
  } catch {
    // constructEvent throws if the signature doesn't match — tampered payload
    // or wrong webhook secret. Return 400 so Stripe knows not to retry.
    console.error(
      "[webhook] ❌ Signature verification failed. Check STRIPE_WEBHOOK_SECRET."
    );
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ── Step 2: Route to the appropriate handler ──────────────────────────────
  // Any unhandled exception from a handler bubbles up here and returns 500,
  // which tells Stripe to retry the event later.
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleSessionCompleted(event);
        break;

      case "checkout.session.expired":
        await handleSessionExpired(event);
        break;

      default:
        // We don't handle this event type — return 200 so Stripe stops sending it.
        break;
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("[webhook] handler failed:", err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkout.session.completed — entry point
// ─────────────────────────────────────────────────────────────────────────────
//
// Runs two guards before doing any work, then branches to the cart or
// single-item handler depending on session.metadata.checkoutType.

async function handleSessionCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  console.log(`[webhook] 💳 Processing completed session: ${session.id}`);

  // Step 1: payment_status guard
  // Stripe can fire checkout.session.completed even for sessions that weren't
  // paid (e.g. setup mode, free trials). Only proceed when funds are captured.
  if (session.payment_status !== "paid") {
    console.warn(
      `[webhook] ⏳ Not paid (status: ${session.payment_status}). Skipping.`
    );
    return;
  }

  // Step 2: Already-refunded guard
  // If a previous webhook run partially succeeded but then failed during the
  // listing transfer and issued an auto-refund, orders are now REFUNDED. Stripe
  // retries the event, but we must not attempt another transfer. Exit early
  // so the retry is a safe no-op.
  const alreadyRefunded = await prisma.order.findFirst({
    where: { stripeCheckoutSessionId: session.id, status: "REFUNDED" },
    select: { id: true },
  });
  if (alreadyRefunded) {
    console.log(
      `[webhook] ⏩ Session ${session.id} was already refunded. Skipping.`
    );
    return;
  }

  // Step 3: Extract metadata and resolve paymentIntentId
  // Metadata was written by the checkout route when the session was created:
  //   - checkoutType: "cart" → multi-order path; absent → single-order path
  //   - buyerId, orderId, cardId, sellerId: set for single-item checkout only
  // payment_intent may be a string ID or an expanded object — normalise to string
  // so we can pass it to the refund API if needed.
  const { checkoutType, buyerId, orderId, cardId, sellerId } =
    session.metadata || {};
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  // Step 4: Branch to the correct handler
  if (checkoutType === "cart") {
    await handleCartSessionCompleted(session, event, buyerId!, paymentIntentId);
  } else {
    await handleSingleSessionCompleted(
      session,
      event,
      {
        orderId: orderId!,
        listingId: cardId!,
        buyerId: buyerId!,
        sellerId: sellerId!,
      },
      paymentIntentId
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-refund safeguard — issueRefundOnTransferFailure
// ─────────────────────────────────────────────────────────────────────────────
//
// Called from the catch block of handleCartSessionCompleted and
// handleSingleSessionCompleted whenever a listing transfer fails AFTER Stripe has
// already captured payment. The buyer has been charged but has not received
// their card — we must make them whole immediately.
//
// Steps:
//   1. Verify we have a paymentIntentId (required to call the refund API).
//   2. Call stripe.refunds.create() — returns funds to the buyer's card.
//   3. Mark orders REFUNDED in our DB so any future Stripe retry for this
//      session hits the already-refunded guard (Step 2 above) and exits safely.
//
// Failure modes:
//   - No paymentIntentId → re-throw so webhook returns 500 and Stripe retries.
//     An engineer must issue the refund manually via the Stripe dashboard.
//   - stripe.refunds.create() fails → re-throw the original transfer error so
//     the webhook returns 500 and Stripe retries (refund may succeed next time).

async function issueRefundOnTransferFailure(
  session: Stripe.Checkout.Session,
  paymentIntentId: string | null,
  transferErr: unknown
): Promise<void> {
  console.error(
    `[webhook] ❌ Transfer failed for session ${session.id} — attempting auto-refund:`,
    transferErr
  );

  // Step 0: A concurrent delivery of the same event may have already
  // committed the sale — our transaction then fails on the idempotency key
  // or a 0-row transfer. Refunding here would leave the buyer with the card
  // AND their money back, so stop if the session's orders are already PAID.
  const alreadyPaid = await prisma.order.findFirst({
    where: { stripeCheckoutSessionId: session.id, status: "PAID" },
    select: { id: true },
  });
  if (alreadyPaid) {
    console.warn(`[webhook] Session ${session.id} already completed by another delivery — no refund.`);
    return;
  }

  // Step 1: Verify we have a paymentIntentId to refund against.
  if (!paymentIntentId) {
    console.error(
      `[webhook] ❌ No paymentIntentId for session ${session.id} — cannot auto-refund.`
    );
    throw transferErr; // → webhook returns 500 → Stripe retries → manual intervention
  }

  try {
    // Step 2: Issue the Stripe refund. Stripe processes this asynchronously;
    // funds typically appear within 5–10 business days depending on the issuer.
    await stripe.refunds.create({ payment_intent: paymentIntentId });
    console.log(`[webhook] 💰 Auto-refund issued for session ${session.id}`);

    // Step 3: Stamp orders REFUNDED so that if Stripe retries this webhook event,
    // the already-refunded guard in handleSessionCompleted exits cleanly without
    // attempting another transfer or issuing a duplicate refund.
    // Note: orders are still PENDING here because the DB transaction that would
    // have marked them PAID was rolled back when the transfer failed.
    await prisma.order.updateMany({
      where: { stripeCheckoutSessionId: session.id, status: "PENDING" },
      data: { status: "REFUNDED" },
    });

    // Returning normally (not throwing) is intentional. The caller returns
    // { received: true } with HTTP 200 → Stripe stops retrying. Buyer is refunded.
  } catch (refundErr) {
    // Refund failed — log the refund error but re-throw the original transfer
    // error so Stripe retries the whole event. The refund may succeed next time.
    console.error(
      `[webhook] ❌ CRITICAL: Auto-refund ALSO failed for session ${session.id}.`,
      refundErr
    );
    throw transferErr;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cart checkout — handleCartSessionCompleted
// ─────────────────────────────────────────────────────────────────────────────
//
// The cart checkout route creates one Order per listing but a single Stripe session
// covering all of them. All N orders are processed inside one DB transaction so
// either ALL listings transfer or NONE do. If the transaction fails, the catch block
// calls issueRefundOnTransferFailure so the buyer gets a full refund.

async function handleCartSessionCompleted(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
  buyerId: string,
  paymentIntentId: string | null
) {
  console.log(`[webhook] 🛒 Cart checkout for buyer ${buyerId}`);

  let soldItems: { sellerId: string; listingId: string; orderId: string }[] = [];

  try {
    soldItems = await prisma.$transaction(async (tx) => {
      // Step 1: Load all orders tied to this Stripe session.
      // Each order was created by the cart checkout route (one per listing).
      const orders = await tx.order.findMany({
        where: { stripeCheckoutSessionId: session.id },
      });

      if (orders.length === 0) {
        // Should never happen if the checkout route ran correctly.
        // Throw → 500 → Stripe retries while we investigate.
        console.error(`[webhook] ❌ No orders found for session ${session.id}`);
        throw new Error("No orders for session");
      }

      const purchasedListingIds: string[] = [];
      // Accumulates sold order info so we can notify sellers after the transaction.
      const soldOrders: { sellerId: string; listingId: string; orderId: string }[] = [];

      for (const order of orders) {
        // Step 2: Idempotency check (per order)
        // The composite unique index @@unique([stripeEventId, orderId]) on
        // CardTransaction is our idempotency key. If a record already exists for
        // this (event, order) pair, we already handled it on a prior webhook
        // delivery. Skip to avoid double-transferring.
        const existingTx = await tx.cardTransaction.findUnique({
          where: {
            stripeEventId_orderId: {
              stripeEventId: event.id,
              orderId: order.id,
            },
          },
        });
        if (existingTx) {
          console.log(
            `[webhook] ⏩ Already processed order ${order.id}. Skipping.`
          );
          continue;
        }

        // Step 3: Mark order PAID
        // Only update if not already PAID — guards against partial retries where
        // this order was processed but a later one in the loop failed.
        if (order.status !== "PAID") {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: "PAID",
              stripePaymentIntentId: paymentIntentId ?? undefined,
            },
          });
        }

        // Step 4: Create CardTransaction audit record
        // This is our permanent ledger entry for the sale. The stripeEventId
        // stored here is what the idempotency check in Step 2 looks up.
        await tx.cardTransaction.create({
          data: {
            orderId: order.id,
            listingId: order.listingId,
            sellerId: order.sellerId,
            buyerId,
            amount: order.amount,
            currency: order.currency,
            stripeEventId: event.id,
          },
        });

        // Step 5: Transfer listing ownership
        // The WHERE clause is a concurrency guard — it only matches if the
        // listing is still reserved by THIS exact checkout session and buyer. If
        // another process already transferred or released it, count will be 0
        // and we throw, rolling back the entire transaction (all listings stay
        // with their sellers).
        const movedCount = await transferCardOwnership(tx, {
          listingId: order.listingId,
          checkoutSessionId: session.id,
          buyerId,
        });

        if (movedCount !== 1) {
          console.error(`[webhook] ❌ Listing transfer failed for listing ${order.listingId}. Count: ${movedCount}`);
          throw new Error(`Card transfer failed for order ${order.id}`);
        }

        // Step 6: Archive open offers on this listing
        // Once ownership transfers, all pending offers are invalid. We archive
        // (set archivedAt) rather than delete so history is preserved for
        // buyers and admins.
        // expiresAt = now hands their still-pending holds to the next
        // expire-offers cron run, instead of keeping losing buyers' funds
        // held for up to 24h on a card that is already sold.
        await tx.offer.updateMany({
          where: { listingId: order.listingId },
          data: { archivedAt: new Date(), expiresAt: new Date() },
        });

        purchasedListingIds.push(order.listingId);
        soldOrders.push({ sellerId: order.sellerId, listingId: order.listingId, orderId: order.id });
        console.log(`[webhook] ✅ Transferred listing ${order.listingId}`);
      }

      // Step 7: Remove purchased items from the buyer's cart
      // Now that ownership has transferred, the listings should no longer appear
      // in the cart. Only runs if at least one listing transferred in this delivery.
      if (purchasedListingIds.length > 0) {
        const cart = await tx.cart.findUnique({ where: { userId: buyerId } });
        if (cart) {
          await tx.cartItem.deleteMany({
            where: { cartId: cart.id, listingId: { in: purchasedListingIds } },
          });
        }
      }

      return soldOrders;
    });
  } catch (err) {
    // The DB transaction rolled back — no orders were marked PAID, no listings
    // were transferred. Stripe has already captured the payment.
    // → Hand off to the refund safeguard (see issueRefundOnTransferFailure above).
    await issueRefundOnTransferFailure(session, paymentIntentId, err);
    return;
  }

  // Step 8: Notify each seller — fire-and-forget, one notification per listing sold.
  for (const { sellerId, listingId, orderId } of soldItems) {
    notifySellerCardSold({ sellerId, listingId, orderId });
  }

  console.log(`[webhook] 🎉 Cart checkout complete for session ${session.id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-listing checkout — handleSingleSessionCompleted
// ─────────────────────────────────────────────────────────────────────────────
//
// The Buy Now flow creates one Order and one Stripe session. All IDs needed
// (orderId, listingId, buyerId, sellerId) are stored in session.metadata (as
// cardId — the metadata key itself is unchanged; only this function's own
// internal parameter is named listingId).
//
// Important distinction on error handling:
//   Missing metadata → code bug → throw WITHOUT auto-refund (Stripe retries
//   while an engineer investigates; we can't refund without the IDs anyway).
//   Missing order / failed transfer → runtime error → auto-refund fires.

async function handleSingleSessionCompleted(
  session: Stripe.Checkout.Session,
  event: Stripe.Event,
  meta: { orderId: string; listingId: string; buyerId: string; sellerId: string },
  paymentIntentId: string | null
) {
  const { orderId, listingId, buyerId, sellerId } = meta;
  console.log(`[webhook] 📋 Single checkout — listing: ${listingId}, order: ${orderId}`);

  // Step 1: Validate metadata
  // Missing IDs = bug in our checkout route (metadata wasn't written correctly).
  // Do NOT auto-refund — we don't have the IDs needed to do so safely, and the
  // bug needs to be fixed before retrying. Throw → 500 → Stripe retries.
  if (!orderId || !listingId || !buyerId || !sellerId) {
    console.error("[webhook] ❌ Missing metadata in single-item session.");
    throw new Error("Missing metadata on session");
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Step 2: Idempotency check
      // If a CardTransaction already exists for this (stripeEventId, orderId) pair,
      // we've already handled this Stripe event on a prior delivery. Exit early —
      // do not re-transfer the listing or create duplicate records.
      const existingTx = await tx.cardTransaction.findUnique({
        where: { stripeEventId_orderId: { stripeEventId: event.id, orderId } },
      });
      if (existingTx) {
        console.log("[webhook] ⏩ Event already processed. Skipping.");
        return;
      }

      // Step 3: Fetch and validate the order
      // Re-fetch inside the transaction for a consistent snapshot. The cross-checks
      // below detect data corruption or mismatched metadata between DB and Stripe.
      const order = await tx.order.findUnique({ where: { id: orderId } });
      if (!order) throw new Error("Order not found");

      if (order.listingId !== listingId) throw new Error("Order card mismatch");
      if (order.buyerId !== buyerId) throw new Error("Order buyer mismatch");
      if (order.sellerId !== sellerId) throw new Error("Order seller mismatch");
      if (order.stripeCheckoutSessionId && order.stripeCheckoutSessionId !== session.id) {
        throw new Error("Order session mismatch");
      }

      // Step 3a: Handle already-PAID order (partial retry recovery)
      // A previous run may have succeeded in marking the order PAID but crashed
      // before writing the CardTransaction. Write the audit record and return —
      // do not attempt to re-transfer the listing (it's already been transferred).
      if (order.status === "PAID") {
        await tx.cardTransaction.create({
          data: { orderId, listingId, sellerId, buyerId, amount: order.amount, currency: order.currency, stripeEventId: event.id },
        });
        return;
      }

      // Step 4: Mark order PAID
      await tx.order.update({
        where: { id: orderId },
        data: { status: "PAID", stripePaymentIntentId: paymentIntentId ?? undefined },
      });

      // Step 5: Create CardTransaction audit record
      // Permanent ledger entry for this sale. The stripeEventId stored here is
      // what the idempotency check in Step 2 looks up on future retries.
      await tx.cardTransaction.create({
        data: { orderId, listingId, sellerId, buyerId, amount: order.amount, currency: order.currency, stripeEventId: event.id },
      });

      // Step 6: Transfer listing ownership
      // The WHERE clause is a concurrency guard: the update only matches if the
      // listing is still reserved by this exact session and buyer. If another
      // process already transferred or released it, count will be 0 → we throw →
      // transaction rolls back → catch block fires the auto-refund (Step 7 below).
      const movedCount = await transferCardOwnership(tx, {
        listingId,
        checkoutSessionId: session.id,
        buyerId,
      });

      if (movedCount !== 1) {
        console.error(`[webhook] ❌ Transfer FAILED. Count: ${movedCount}.`);
        throw new Error("Card was not reserved by this checkout session");
      }

      // Step 7: Archive open offers on this listing
      // Once ownership transfers, all pending offers are invalid. Archived (not
      // deleted) so history is preserved.
      // expiresAt = now: release losing buyers' holds on the next cron run.
      await tx.offer.updateMany({ where: { listingId }, data: { archivedAt: new Date(), expiresAt: new Date() } });
      console.log("[webhook] 🎉 Single-item transfer successful.");
    });
  } catch (err) {
    // The DB transaction rolled back. Stripe has the money but the listing was not
    // transferred. → Hand off to the refund safeguard (see issueRefundOnTransferFailure above).
    await issueRefundOnTransferFailure(session, paymentIntentId, err);
    return;
  }

  // Notify the seller — fire-and-forget.
  notifySellerCardSold({ sellerId, listingId, orderId });
}

// ─────────────────────────────────────────────────────────────────────────────
// checkout.session.expired — handleSessionExpired
// ─────────────────────────────────────────────────────────────────────────────
//
// The buyer opened the Stripe Checkout page but did not pay before the session
// timed out (default: 24 hours). No money was captured.

async function handleSessionExpired(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  console.log(`[webhook] ⌛ Session expired: ${session.id}`);

  // Marks the session's PENDING orders EXPIRED and frees its listings — the
  // same cleanup the cancel page and the lapsed-hold cron run.
  await releaseCheckoutSession(session.id);
}
