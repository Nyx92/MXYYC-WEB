import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { notifyAsync } from "@/lib/notifications";
import { verifyPaymentIntentAmountOrRespond } from "@/lib/paymentIntentGuard";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";
import { rateLimitResponse } from "@/lib/rateLimit";
import { requireVerifiedForPurchase } from "@/lib/purchaseVerification";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

// How long (in hours) the seller has to respond before the offer expires
// and the buyer's authorised funds are released.
const OFFER_EXPIRY_HOURS = 24;

// The Offer model's card reference is `listingId` (renamed from `cardId`
// when Card became Listing), but the wire format this route has always used
// stays `cardId` — this rebuilds a raw offer row's price + card fields for
// the client without ever leaking the internal `listingId` name.
// `paymentIntentId` is dropped: sellers read this endpoint, and a buyer's PI
// id must never reach anyone who could try to attach it elsewhere.
function serializeOffer(offer: any) {
  const { listingId, price, listing, paymentIntentId, ...rest } = offer;
  return {
    ...rest,
    cardId: listingId,
    price: price != null ? centsToDollars(price) : null,
    ...(listing ? { card: withListingDisplay(listing) } : {}),
  };
}

/**
 * GET /api/offers?cardId=X              — seller: all non-archived offers on their card
 * GET /api/offers?cardId=X&myOffer=true — viewer: their own offer on this card (or null)
 * GET /api/offers?mine=true             — buyer: full offer history
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;
  const { searchParams } = new URL(req.url);
  const cardId = searchParams.get("cardId");
  const myOffer = searchParams.get("myOffer") === "true";
  const mine = searchParams.get("mine") === "true";
  const received = searchParams.get("received") === "true";

  try {
    // ── Viewer: fetch their own offer on a specific card ──────────────────────
    if (cardId && myOffer) {
      const offer = await prisma.offer.findFirst({
        where: {
          listingId: cardId,
          buyerId: userId,
          status: { in: ["pending", "accepted", "rejected", "expired"] },
          archivedAt: null,
        },
        orderBy: { createdAt: "desc" },
      });

      return NextResponse.json({ offer: offer ? serializeOffer(offer) : null });
    }

    // ── Seller: all non-archived offers on their card ─────────────────────────
    if (cardId) {
      const listing = await prisma.listing.findUnique({
        where: { id: cardId },
        select: { ownerId: true },
      });
      if (!listing)
        return NextResponse.json({ error: "Card not found" }, { status: 404 });
      if (listing.ownerId !== userId)
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      const offers = await prisma.offer.findMany({
        where: { listingId: cardId, archivedAt: null },
        include: {
          // No email: counterparties never need each other's contact
          // details (the shop handles pickup), and usernames always exist.
          buyer: { select: { id: true, username: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      return NextResponse.json({ offers: offers.map(serializeOffer) });
    }

    // ── Buyer: their full offer history ───────────────────────────────────────
    if (mine) {
      const offers = await prisma.offer.findMany({
        where: { buyerId: userId },
        include: {
          listing: {
            select: {
              id: true,
              imageUrls: true,
              condition: true,
              forSale: true,
              owner: { select: { id: true, username: true } },
              ...listingCatalogInclude,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return NextResponse.json({ offers: offers.map(serializeOffer) });
    }

    // ── Seller: all incoming offers across all four lifecycle states ──────────
    // Returns pending (active), rejected, expired, and paid/accepted (history)
    // so the /offers page can split them into Active / Accepted / Declined / Expired
    // tabs on the frontend without a second request.
    //
    // Why the OR clause:
    //   - archivedAt: null  catches pending, rejected, and expired offers (the card
    //     is still owned by the seller or the offer just ended).
    //   - status paid/accepted catches accepted offers, which the accept flow also
    //     archives (step 5c archives ALL offers on the card, including the one
    //     just marked "paid" in step 5b). Without this second branch, accepted offers
    //     would be invisible to the seller entirely.
    //
    // Offers archived for other reasons (e.g. card sold via checkout before the
    // seller responded) stay out — they have archivedAt set and status "pending",
    // which matches neither branch.
    if (received) {
      const offers = await prisma.offer.findMany({
        where: {
          // Filter by the snapshotted seller id, not listing.ownerId.
          // After a sale, listing.ownerId flips to the buyer — sellerId stays fixed.
          sellerId: userId,
          OR: [
            { archivedAt: null },                              // pending, rejected, expired
            { status: { in: ["paid", "accepted"] } },         // accepted (archived by step 5c)
          ],
        },
        include: {
          listing: {
            select: { id: true, imageUrls: true, condition: true, ...listingCatalogInclude },
          },
        },
        orderBy: { createdAt: "desc" },
      });
      return NextResponse.json({ offers: offers.map(serializeOffer) });
    }

    return NextResponse.json({ error: "Missing query param" }, { status: 400 });
  } catch (err) {
    console.error("[offers GET] error:", err);
    return NextResponse.json(
      { error: "Failed to fetch offers" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/offers
 *
 * STEP 2 of placing an offer (step 1 is POST /api/offers/payment-intent).
 *
 * By this point:
 *   - The buyer has already created a Stripe PaymentIntent with capture_method:
 *     "manual" via POST /api/offers/payment-intent.
 *   - The buyer has confirmed their card details via stripe.confirmCardPayment()
 *     in the browser. The funds are now authorised (held) on their card.
 *   - The frontend sends us the resulting paymentIntentId so we can store it.
 *
 * This endpoint:
 *   1. Validates the offer data and card eligibility.
 *   2. Verifies the PaymentIntent in Stripe (must be "requires_capture" status,
 *      meaning it was successfully authorised and is waiting to be captured or
 *      cancelled).
 *   3. If the buyer already has a pending offer (amend case):
 *      - Cancels the OLD PaymentIntent (releases the old hold on their card).
 *      - Updates the existing offer record with the new price/message/PI.
 *   4. If this is a brand-new offer:
 *      - Creates a new offer record.
 *   5. Sets expiresAt = now + 24h on the offer.
 *      The cron job (/api/cron/expire-offers) will cancel the PI and mark
 *      the offer "expired" if the seller doesn't respond within 24h.
 *
 * Body: { cardId, price (cents), message?, paymentIntentId }
 */
export async function POST(req: NextRequest) {
  // ── 1. Auth check ──────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const buyerId = session.user.id;

  // 🔒 Same per-user bucket rationale as POST /api/offers/payment-intent —
  // this route calls Stripe (retrieve/cancel).
  const limited = rateLimitResponse(`offer:${buyerId}`, { limit: 20, windowMs: 60 * 1000 });
  if (limited) return limited;

  // 🔒 Re-checked here, not only at PI creation — this is the route that
  // commits the offer. See src/lib/purchaseVerification.ts.
  const verificationError = await requireVerifiedForPurchase(buyerId);
  if (verificationError) return verificationError;

  try {
    const { cardId, price, message, paymentIntentId } = await req.json();

    // ── 2. Validate inputs ──────────────────────────────────────────────────
    if (!cardId || price == null || Number(price) <= 0) {
      return NextResponse.json(
        { error: "Invalid offer data" },
        { status: 400 }
      );
    }
    // paymentIntentId is now required — it must come from the PI creation step.
    if (!paymentIntentId || typeof paymentIntentId !== "string") {
      return NextResponse.json(
        { error: "Missing paymentIntentId" },
        { status: 400 }
      );
    }

    // ── 3. Verify the card is still for sale ────────────────────────────────
    const listing = await prisma.listing.findUnique({
      where: { id: cardId },
      include: listingCatalogInclude,
    });
    if (!listing)
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    if (!listing.forSale)
      return NextResponse.json(
        { error: "Card is not for sale" },
        { status: 409 }
      );
    if (listing.ownerId === buyerId) {
      return NextResponse.json(
        { error: "Cannot offer on your own card" },
        { status: 400 }
      );
    }

    // Resolved once — used in both notification branches below (amend and new).
    const listingTitle = withListingDisplay(listing).title;

    // ── 4. Verify the PaymentIntent in Stripe ────────────────────────────────
    // We retrieve the PI from Stripe and confirm its status is "requires_capture".
    // This means stripe.confirmCardPayment() ran successfully in the browser and
    // the funds are authorised (held) but NOT charged yet.
    // We also confirm the PI belongs to this buyer and is for the right amount.
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.status !== "requires_capture") {
      // The PI wasn't successfully authorised (e.g. card declined, wrong credentials).
      // Do NOT store the offer — there's nothing to capture.
      return NextResponse.json(
        {
          error: `Payment authorisation failed or was already used (status: ${pi.status})`,
        },
        { status: 409 }
      );
    }

    // Safety: ensure this PI was created for this buyer AND this card by
    // POST /api/offers/payment-intent. Must be an exact match — a PI with no
    // buyerId (e.g. an auction bid PI) is not this buyer's offer hold, and
    // the amount guard below would otherwise cancel it.
    if (pi.metadata?.buyerId !== buyerId || pi.metadata?.cardId !== cardId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // A PI backs exactly one offer. A double-click / client retry re-sends
    // the PI already stored on this buyer's pending offer — answer it
    // idempotently, before anything below can cancel that live hold.
    const alreadyUsed = await prisma.offer.findFirst({ where: { paymentIntentId } });
    if (alreadyUsed) {
      if (alreadyUsed.buyerId === buyerId && alreadyUsed.status === "pending") {
        return NextResponse.json({ offer: serializeOffer(alreadyUsed), amended: false });
      }
      return NextResponse.json(
        { error: "This payment authorisation has already been used" },
        { status: 409 }
      );
    }

    const priceInCents = dollarsToCents(Number(price));
    const cleanMessage = message?.trim() || null;

    // ── 4b. Verify the authorised amount matches the claimed offer price ────
    // Without this, a buyer could authorise a small PI via
    // POST /api/offers/payment-intent, then submit an arbitrarily larger
    // `price` here — the offer would be stored/shown to the seller at the
    // larger amount while Stripe only ever holds/captures the smaller one.
    const amountMismatch = await verifyPaymentIntentAmountOrRespond(
      stripe,
      paymentIntentId,
      pi.amount,
      priceInCents,
      "Offer"
    );
    if (amountMismatch) return amountMismatch;

    // ── 5. Check for existing live offer from this buyer ─────────────────────
    // A buyer can only have ONE active offer per card at a time.
    const existing = await prisma.offer.findFirst({
      where: {
        listingId: cardId,
        buyerId,
        // "accepted" offers are locked — the seller already chose this offer;
        // the buyer must wait for the capture or cancellation before offering again.
        status: { in: ["pending", "accepted"] },
        archivedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing?.status === "accepted") {
      // The seller already accepted a previous offer from this buyer.
      // With manual capture, the funds will be captured immediately when the
      // seller accepts — so if status is "accepted", the card is mid-transfer.
      return NextResponse.json(
        {
          error:
            "You have an accepted offer that is being processed.",
        },
        { status: 409 }
      );
    }

    // ── 6a. Amend: cancel the old PI and update the existing pending offer ───
    if (existing?.status === "pending") {
      // The buyer is changing their offer. Cancel the OLD PaymentIntent first
      // so the previous hold on their card is released. Then save the new PI.
      //
      // The swap is conditional on the offer still being pending with the PI
      // we read: if the seller accepted/rejected it in the meantime, nothing
      // is overwritten and the buyer's NEW hold is released instead.
      const amendData = {
        price: priceInCents,
        message: cleanMessage,
        // Replace old PI with the new one
        paymentIntentId,
        // Reset the 24h expiry window from now
        expiresAt: new Date(Date.now() + OFFER_EXPIRY_HOURS * 60 * 60 * 1000),
      };
      const swapped = await prisma.offer.updateMany({
        where: { id: existing.id, status: "pending", paymentIntentId: existing.paymentIntentId },
        data: amendData,
      });
      if (swapped.count !== 1) {
        await stripe.paymentIntents.cancel(paymentIntentId).catch(() => {});
        return NextResponse.json(
          { error: "Your offer changed while you were updating it. Please refresh and try again." },
          { status: 409 }
        );
      }
      const updated = { ...existing, ...amendData };

      if (existing.paymentIntentId) {
        try {
          await stripe.paymentIntents.cancel(existing.paymentIntentId);
        } catch (cancelErr) {
          // Log but don't block — the old PI may already be cancelled/expired.
          console.warn(
            "[offers POST] Could not cancel old PI:",
            existing.paymentIntentId,
            cancelErr
          );
        }
      }

      // Notify the seller that the buyer revised their offer with a new price.
      // Fire-and-forget — never blocks the response.
      notifyAsync({
        userId:  listing.ownerId,
        type:    "offer_received",
        title:   `Offer updated on "${listingTitle}"`,
        body:    `A buyer updated their offer to S$${price} on "${listingTitle}". Head to your Offers page to respond.`,
        offerId: existing.id,
        cardId:  listing.id,
      });

      return NextResponse.json({
        offer: serializeOffer(updated),
        amended: true,
      });
    }

    // ── 6b. New offer ─────────────────────────────────────────────────────────
    const offer = await prisma.offer.create({
      data: {
        listingId: cardId,
        buyerId,
        // Snapshot the current card owner as the seller. We can't rely on
        // listing.ownerId later because it changes when the card is transferred.
        sellerId: listing.ownerId,
        price: priceInCents,
        message: cleanMessage,
        status: "pending",
        paymentIntentId,
        // Seller has 24h to respond. After expiresAt the cron job will:
        //   1. Cancel the PaymentIntent (release the hold on buyer's card)
        //   2. Mark this offer status → "expired"
        expiresAt: new Date(Date.now() + OFFER_EXPIRY_HOURS * 60 * 60 * 1000),
      },
    });

    // Notify the seller — fire-and-forget, never blocks the response.
    notifyAsync({
      userId:  listing.ownerId,
      type:    "offer_received",
      title:   `New offer on "${listingTitle}"`,
      body:    `You received an offer of S$${price} on your card "${listingTitle}". Head to your Offers page to respond.`,
      offerId: offer.id,
      cardId:  listing.id,
    });

    return NextResponse.json(
      { offer: serializeOffer(offer), amended: false },
      { status: 201 }
    );
  } catch (err) {
    // Unique index on Offer.paymentIntentId: a simultaneous copy of this
    // request already stored this PI on an offer.
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json(
        { error: "This payment authorisation has already been used" },
        { status: 409 }
      );
    }
    console.error("[offers POST] error:", err);
    return NextResponse.json(
      { error: "Failed to place offer" },
      { status: 500 }
    );
  }
}
