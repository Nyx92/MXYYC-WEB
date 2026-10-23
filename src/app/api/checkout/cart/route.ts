// POST /api/checkout/cart
//
// Creates a single Stripe Checkout Session covering all selected cart items.
//
// Flow:
//   1. Auth + fetch selected cart item listing ids
//   2. Validate every listing (for sale, not own, price > 0) using fresh data
//   3. Atomically reserve all listings + create one Order per listing (single DB transaction)
//   4. Create one Stripe session with all listings as line items
//   5. Stamp every Order and Listing with the Stripe session ID
//   6. Return { url } — caller redirects window.location to the Stripe page
//
// Webhook counterpart: app/api/stripe/webhook/route.ts handles
//   checkout.session.completed  → transfers all listings, cleans up cart
//   checkout.session.expired    → releases all reservations

import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";
import { requireVerifiedForPurchase } from "@/lib/purchaseVerification";
import { rateLimitResponse } from "@/lib/rateLimit";
import { releaseCheckoutReservation } from "@/lib/webhookHelpers";
import { CardUnavailableError, closeLapsedCheckouts } from "@/lib/checkoutSessions";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

export async function POST(_req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  const buyerId = authSession?.user?.id;

  if (!buyerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // 🔒 Rate limit by user id — shared with POST /api/checkout. Each
  // call creates a Stripe Checkout Session AND holds the listing(s) for
  // 15 minutes, so the cap also bounds how many listings one account can
  // keep locked away from other buyers. In-memory stopgap (see
  // src/lib/rateLimit.ts).
  const limited = rateLimitResponse(
    `checkout:${buyerId}`,
    { limit: 10, windowMs: 15 * 60 * 1000 },
    "Too many checkout attempts. Please try again in a few minutes."
  );
  if (limited) return limited;

  // 🔒 Buyer must have verified both email and phone before committing to
  // any purchase. See src/lib/purchaseVerification.ts.
  const verificationError = await requireVerifiedForPurchase(buyerId);
  if (verificationError) return verificationError;

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

  try {
    // ── 1. Fetch selected items' listing ids ──────────────────────────────────
    const cart = await prisma.cart.findUnique({
      where: { userId: buyerId },
      include: {
        items: { where: { selected: true } },
      },
    });

    if (!cart || cart.items.length === 0) {
      return NextResponse.json({ error: "No selected items in cart" }, { status: 400 });
    }

    // ── 2. Validate every listing using authoritative DB data ───────────────
    // Fetch fresh copies to prevent stale-snapshot attacks (price manipulation, etc.)
    const listingIds = cart.items.map((i) => i.listingId);
    const freshListings = await prisma.listing.findMany({
      where: { id: { in: listingIds } },
      include: listingCatalogInclude,
    });
    const listingMap = new Map(freshListings.map((l) => [l.id, withListingDisplay(l)]));

    for (const item of cart.items) {
      const listing = listingMap.get(item.listingId);
      if (!listing) {
        return NextResponse.json({ error: `Card "${item.listingId}" no longer exists` }, { status: 404 });
      }
      if (!listing.forSale) {
        return NextResponse.json({ error: `"${listing.title}" is no longer for sale` }, { status: 409 });
      }
      if (listing.ownerId === buyerId) {
        return NextResponse.json({ error: "Cannot buy your own card" }, { status: 400 });
      }
      if (!listing.price || listing.price <= 0) {
        return NextResponse.json({ error: `"${listing.title}" has no valid price` }, { status: 400 });
      }
    }

    // Close any lapsed earlier hold, and this buyer's own earlier checkout,
    // first — same reasons as checkout/route.ts.
    const sold = await closeLapsedCheckouts(listingIds, buyerId);
    if (sold.length > 0) {
      throw new CardUnavailableError(
        `"${listingMap.get(sold[0])!.title}" was just sold. Remove it from your cart to continue.`
      );
    }

    // 15 minutes matches single-item Buy Now checkout (see checkout/route.ts) —
    // a multi-item Stripe checkout page takes at least as long to fill out as
    // a single-item one, so there's no reason to give a cart buyer less time.
    const reserveMinutes = 15;
    const reservedUntil = new Date(Date.now() + reserveMinutes * 60_000);

    // ── 3. Atomic multi-listing reservation + order creation ─────────────────
    // Each listing is reserved only if currently unlocked.
    // Failure of any single reservation rolls back the entire transaction,
    // so we never partially-reserve a cart.
    const orders = await prisma.$transaction(async (tx) => {
      const created: { orderId: string; listingId: string; sellerId: string; amount: number }[] = [];

      for (const item of cart.items) {
        const listing = listingMap.get(item.listingId)!;

        const reserved = await tx.listing.updateMany({
          where: {
            id: listing.id,
            forSale: true,
            // A listing is reservable only if it has never been reserved, or its
            // previous reservation has expired. The old third branch
            // (`reservedCheckoutSessionId: null`) let a second buyer steal an
            // *active* reservation during the window between "reservedUntil
            // set" and "Stripe session created" (reservedCheckoutSessionId is
            // only stamped after the session.create() call below returns) —
            // whoever's update ran last would win, and the webhook would
            // later refund whichever buyer actually completed payment.
            OR: [
              { reservedUntil: null },
              { reservedUntil: { lt: new Date() } },
            ],
          },
          data: { reservedById: buyerId, reservedUntil },
        });

        if (reserved.count !== 1) {
          throw new CardUnavailableError(
            `Another buyer is checking out "${listing.title}" right now. If they don't complete payment, it will be available again within 15 minutes.`
          );
        }

        const order = await tx.order.create({
          data: {
            listingId: listing.id,
            sellerId: listing.ownerId,
            buyerId,
            amount: listing.price!,
            currency: "sgd",
            status: "PENDING",
          },
        });

        created.push({ orderId: order.id, listingId: listing.id, sellerId: listing.ownerId, amount: listing.price! });
      }

      return created;
    });

    // ── 4. Build Stripe line items ────────────────────────────────────────────
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = orders.map(({ listingId, amount }) => {
      const listing = listingMap.get(listingId)!;
      const imageUrls = (listing.imageUrls ?? [])
        .filter(Boolean)
        .slice(0, 1) // Stripe allows up to 8; one is enough per line item
        .map((url) => (url.startsWith("http") ? url : `${baseUrl}${url}`));

      return {
        price_data: {
          currency: "sgd",
          unit_amount: amount,
          product_data: {
            name: listing.title,
            images: imageUrls,
            metadata: { cardId: listingId },
          },
        },
        quantity: 1,
      };
    });

    // ── 5. Create Stripe Checkout Session ─────────────────────────────────────
    // metadata.checkoutType = "cart" tells the webhook to use the multi-order path.
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: lineItems,
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel?from=cart`,
      metadata: {
        checkoutType: "cart",
        buyerId,
      },
    }).catch(async (stripeErr) => {
      // Release the holds + PENDING orders from step 3 (see releaseCheckoutReservation).
      await releaseCheckoutReservation(
        buyerId,
        orders.map((o) => o.orderId),
        orders.map((o) => o.listingId)
      );
      throw stripeErr;
    });

    // ── 6. Stamp Orders + Listings with the session ID ────────────────────────
    await prisma.$transaction([
      ...orders.map(({ orderId }) =>
        prisma.order.update({
          where: { id: orderId },
          data: { stripeCheckoutSessionId: checkoutSession.id },
        })
      ),
      ...orders.map(({ listingId }) =>
        prisma.listing.update({
          where: { id: listingId },
          data: { reservedCheckoutSessionId: checkoutSession.id },
        })
      ),
    ]);

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    // Our own buyer-facing message — safe to return.
    if (err instanceof CardUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // Log the real error server-side only — never echo err.message back to
    // the client, it can leak internal details (Prisma/Stripe error text).
    console.error("[checkout/cart] error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session. Please try again." },
      { status: 500 }
    );
  }
}
