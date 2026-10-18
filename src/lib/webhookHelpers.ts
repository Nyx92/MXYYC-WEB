// lib/webhookHelpers.ts

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { notifyAsync } from "@/lib/notifications";
import { listingCatalogInclude, resolveListingDisplay } from "@/lib/listingDisplay";

/**
 * transferCardOwnership — the concurrency-guarded ownership transfer shared
 * by handleCartSessionCompleted and handleSingleSessionCompleted in the
 * Stripe webhook. The WHERE clause only matches if the listing is still
 * reserved by this exact checkout session and buyer; if another process
 * already transferred or released it, the count comes back 0 and the caller
 * throws to roll back its transaction (triggering the refund safeguard).
 *
 * Returns the row count rather than throwing itself — the two callers log
 * slightly different messages on failure, which stays their responsibility.
 */
export async function transferCardOwnership(
  tx: Prisma.TransactionClient,
  params: { listingId: string; checkoutSessionId: string; buyerId: string }
): Promise<number> {
  const moved = await tx.listing.updateMany({
    where: {
      id: params.listingId,
      reservedCheckoutSessionId: params.checkoutSessionId,
      reservedById: params.buyerId,
      forSale: true,
    },
    data: {
      ownerId: params.buyerId,
      forSale: false,
      price: null,
      reservedById: null,
      reservedUntil: null,
      reservedCheckoutSessionId: null,
    },
  });
  return moved.count;
}

/**
 * releaseCheckoutReservation — undoes a checkout's reservation + PENDING
 * order(s) when stripe.checkout.sessions.create fails. Without it the
 * listing stays locked for the full hold, and the order stays PENDING
 * forever: it never got a session id, so no checkout.session.expired event
 * will ever clean it up. Only touches rows still held by this buyer with no
 * session stamped, so it can't release anyone else's reservation.
 */
export async function releaseCheckoutReservation(
  buyerId: string,
  orderIds: string[],
  listingIds: string[]
): Promise<void> {
  await prisma.$transaction([
    prisma.order.updateMany({
      where: { id: { in: orderIds }, status: "PENDING", stripeCheckoutSessionId: null },
      data: { status: "EXPIRED" },
    }),
    prisma.listing.updateMany({
      where: { id: { in: listingIds }, reservedById: buyerId, reservedCheckoutSessionId: null },
      data: { reservedById: null, reservedUntil: null },
    }),
  ]);
}

/**
 * notifySellerCardSold — fire-and-forget "card sold" notification shared by
 * both webhook handlers. Never throws — a failed lookup/send is swallowed,
 * matching the existing behavior at both call sites (a notification failure
 * must never affect webhook processing). The listing's title is resolved via
 * its catalog relation (pokemonCard/riftboundCard) since it's no longer a
 * flat column on Listing itself.
 */
export function notifySellerCardSold(params: {
  sellerId: string;
  listingId: string;
  orderId: string;
}): void {
  prisma.listing
    .findUnique({ where: { id: params.listingId }, include: listingCatalogInclude })
    .then((listing) => {
      const title = listing ? resolveListingDisplay(listing).title : "a card";
      notifyAsync({
        userId: params.sellerId,
        type: "card_sold",
        title: "Your card was sold",
        body: `Your card "${title}" was purchased via Buy Now.`,
        cardId: params.listingId,
        orderId: params.orderId,
      });
    })
    .catch(() => {});
}
