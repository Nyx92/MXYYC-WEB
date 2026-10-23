// app/api/checkout/route.ts
import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { prisma } from "@/lib/prisma"; // adjust to your path
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

export async function POST(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  const buyerId = authSession?.user?.id;

  try {
    const body = await req.json();
    const { cardId } = body as { cardId: string };

    if (!buyerId)
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    // 🔒 Rate limit by user id — shared with POST /api/checkout/cart. Each
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

    /** * 1) Security & Validation: Fetch authoritative listing data from DB.
     * Prevents buying unlisted items or price manipulation via client-side request.
     */
    const listing = await prisma.listing.findUnique({
      where: { id: cardId },
      include: listingCatalogInclude,
    });
    if (!listing)
      return NextResponse.json({ error: "Card not found" }, { status: 404 });

    if (!listing.forSale) {
      return NextResponse.json(
        { error: "Card is not for sale" },
        { status: 409 }
      );
    }

    if (listing.ownerId === buyerId) {
      return NextResponse.json(
        { error: "You cannot buy your own card" },
        { status: 403 }
      );
    }

    if (listing.price == null || listing.price <= 0) {
      return NextResponse.json(
        { error: "Card has invalid price" },
        { status: 400 }
      );
    }

    // An earlier buyer's hold may have run out with their Stripe page still
    // open — close it first, so they can't pay after this buyer reserves.
    // This buyer's own earlier checkout of the card is closed too, so coming
    // back to buy again isn't blocked by their own hold.
    if ((await closeLapsedCheckouts([cardId], buyerId)).length > 0) {
      throw new CardUnavailableError("This card was just sold.");
    }

    const amount = listing.price;
    // 15 minutes gives a buyer enough time to complete the Stripe Checkout
    // page without holding the card unreasonably long from other buyers.
    // Deliberately under Stripe's 30-minute expires_at minimum — the
    // session is closed by closeLapsedCheckouts once the hold runs out.
    const reserveMinutes = 15;
    const reservedUntil = new Date(Date.now() + reserveMinutes * 60_000);

    const order = await prisma.$transaction(async (tx) => {
      // 1. Double-check the buyer exists in the system
      const buyer = await prisma.user.findUnique({
        where: { id: buyerId! },
      });
      if (!buyer) {
        throw new Error("Authenticated buyer not found in database");
      }
      // 2. The "Atomic Reservation"
      // We don't just find the listing; we try to UPDATE it only if it's currently available.
      const updated = await tx.listing.updateMany({
        where: {
          id: cardId,
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
            { reservedUntil: null }, // Never reserved
            { reservedUntil: { lt: new Date() } }, // Previous reservation expired
          ],
        },
        data: {
          reservedById: buyerId,
          reservedUntil,
        },
      });
      // 3. If updateMany affected 0 rows, it means the listing is being reserved
      if (updated.count !== 1)
        throw new CardUnavailableError(
          "Another buyer is checking out this card right now. If they don't complete payment, it will be available again within 15 minutes."
        );

      // 4. Create the formal Order record linked to this attempt
      return tx.order.create({
        data: {
          listingId: cardId,
          sellerId: listing.ownerId,
          buyerId,
          amount,
          currency: "sgd",
          status: "PENDING",
        },
      });
    });

    /**
     * 3a) Formatting: Convert relative image paths to absolute URLs.
     * Stripe requires full 'http' paths to render images on the checkout page.
     */
    const finalImageUrls = (listing.imageUrls ?? [])
      .filter(Boolean)
      .map((url) => (url.startsWith("http") ? url : `${baseUrl}${url}`));

    const title = withListingDisplay(listing).title;

    // 3) Create checkout session — on failure, release the hold and the
    //    PENDING order created above (see releaseCheckoutReservation).
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "sgd",
            unit_amount: amount,
            product_data: {
              name: title,
              images: finalImageUrls,
              metadata: { cardId },
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel?cardId=${encodeURIComponent(cardId)}`,
      metadata: {
        orderId: order.id,
        cardId,
        buyerId,
        sellerId: listing.ownerId,
      },
      // expires_at omitted: Stripe's minimum is 30 minutes, longer than our
      // 15-minute hold. closeLapsedCheckouts expires the session instead.
    }).catch(async (stripeErr) => {
      await releaseCheckoutReservation(buyerId, [order.id], [cardId]);
      throw stripeErr;
    });

    // 4) Save session id + tie reservation to this session id
    await prisma.$transaction([
      prisma.order.update({
        where: { id: order.id },
        data: { stripeCheckoutSessionId: checkoutSession.id },
      }),
      prisma.listing.update({
        where: { id: cardId },
        data: { reservedCheckoutSessionId: checkoutSession.id },
      }),
    ]);

    return NextResponse.json({ url: checkoutSession.url });
  } catch (err) {
    if (err instanceof CardUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("[checkout] error:", err);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}
