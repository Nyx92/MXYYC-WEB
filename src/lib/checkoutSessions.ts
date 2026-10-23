import Stripe from "stripe";
import { prisma } from "@/lib/prisma";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

// Thrown by the checkout routes when a card can't be reserved. Its message is
// written for the buyer, so the routes return it as-is with a 409.
export class CardUnavailableError extends Error {}

/**
 * releaseCheckoutSession — marks a session's PENDING orders EXPIRED and frees
 * the listings it held. Same cleanup the checkout.session.expired webhook
 * runs; both are idempotent, so whichever runs second changes nothing.
 */
export async function releaseCheckoutSession(sessionId: string): Promise<void> {
  await prisma.$transaction([
    prisma.order.updateMany({
      where: { stripeCheckoutSessionId: sessionId, status: "PENDING" },
      data: { status: "EXPIRED" },
    }),
    prisma.listing.updateMany({
      where: { reservedCheckoutSessionId: sessionId },
      data: { reservedById: null, reservedUntil: null, reservedCheckoutSessionId: null },
    }),
  ]);
}

/**
 * closeCheckoutSession — expires an open Stripe Checkout Session so it can no
 * longer be paid, then releases its hold. Returns false when the buyer has
 * already paid: the card is sold (or will be once the completed webhook
 * lands) and must stay held.
 */
export async function closeCheckoutSession(sessionId: string): Promise<boolean> {
  try {
    await stripe.checkout.sessions.expire(sessionId);
  } catch (err) {
    // Stripe doesn't know this session under the current key — it was made
    // in the other mode (cs_live_ vs cs_test_; local dev and production
    // share one database, and the key can be switched). This deployment can
    // never see it paid, so holding the card would lock it forever.
    if ((err as { code?: string }).code === "resource_missing") {
      console.warn(`[checkout] session ${sessionId} unknown to this Stripe key — releasing its hold`);
      await releaseCheckoutSession(sessionId);
      return true;
    }
    // expire() only works on an open session — find out why it isn't open.
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") return false;
    if (session.status !== "expired") throw err;
  }
  await releaseCheckoutSession(sessionId);
  return true;
}

/**
 * closeLapsedCheckouts — closes the Stripe session behind every hold whose
 * 15 minutes are up — and, with buyerId, behind that buyer's own holds on
 * these listings: a buyer who comes back to check out again replaces their
 * earlier checkout instead of being locked out by it. Without it, a buyer who left the Stripe page open could
 * still pay up to 24 hours later (Stripe's default session lifetime; its
 * expires_at minimum is 30 minutes, longer than our hold), after the card
 * went to someone else.
 *
 * Runs every minute from /api/cron/expire-offers, and on the listings a
 * checkout is about to reserve, so the cron's up-to-a-minute lag can't let a
 * late payment through. Returns the ids of listings that are still not free:
 * their lapsed session was in fact paid, or Stripe couldn't be reached to
 * close it (a checkout must not reserve those; the cron retries next minute).
 */
export async function closeLapsedCheckouts(
  listingIds?: string[],
  buyerId?: string
): Promise<string[]> {
  const lapsed = await prisma.listing.findMany({
    where: {
      OR: [{ reservedUntil: { lt: new Date() } }, ...(buyerId ? [{ reservedById: buyerId }] : [])],
      reservedCheckoutSessionId: { not: null },
      ...(listingIds && { id: { in: listingIds } }),
    },
    select: { id: true, reservedCheckoutSessionId: true },
  });

  const unavailable: string[] = [];
  // One cart session can hold several listings — close each session once.
  for (const sessionId of new Set(lapsed.map((l) => l.reservedCheckoutSessionId!))) {
    const closed = await closeCheckoutSession(sessionId).catch((err) => {
      console.error(`[checkout] could not close lapsed session ${sessionId}:`, err);
      return false;
    });
    if (!closed) {
      unavailable.push(
        ...lapsed.filter((l) => l.reservedCheckoutSessionId === sessionId).map((l) => l.id)
      );
    }
  }
  return unavailable;
}
