import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { dollarsToCents } from "@/lib/money";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireVerifiedForPurchase } from "@/lib/purchaseVerification";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string, {
  apiVersion: "2025-02-24.acacia",
});

/**
 * POST /api/auctions/[id]/bid/intent
 *
 * Step 1 of 2 for placing a bid (mirrors POST /api/offers/payment-intent).
 *
 * Creates a Stripe PaymentIntent with capture_method: "manual" for the bid
 * amount. Returns the clientSecret so the frontend can confirm the PI via
 * stripe.confirmCardPayment(). Funds are authorised (held) but NOT charged.
 *
 * Basic validation runs here so we don't create dangling PIs for invalid bids.
 * Full version-locked validation runs in Step 2 (POST /api/auctions/[id]/bid).
 *
 * Body: { amount } — bid amount in dollars
 */
export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const bidderId = session.user.id;

  // 🔒 Rate limit by user id — a generous 20/min, same rationale as
  // POST /api/offers/payment-intent (auth-gated route, real user id
  // available, limit exists to stop scripted abuse not normal bidding).
  // In-memory stopgap (see src/lib/rateLimit.ts).
  const { allowed } = checkRateLimit(`bid-intent:${bidderId}`, {
    limit: 20,
    windowMs: 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429 }
    );
  }

  // 🔒 Bidder must have verified both email and phone before committing to
  // any purchase. See src/lib/purchaseVerification.ts.
  const verificationError = await requireVerifiedForPurchase(bidderId);
  if (verificationError) return verificationError;

  try {
    const { amount } = await req.json();

    // ── 2. Validate amount ──────────────────────────────────────────────────
    const amountCents = dollarsToCents(Number(amount));
    if (!amount || amountCents <= 0) {
      return NextResponse.json(
        { error: "Bid amount must be greater than $0" },
        { status: 400 }
      );
    }

    // ── 3. Load auction for pre-flight checks ───────────────────────────────
    // These are optimistic checks only — the binding version-lock is in Step 2.
    const auction = await prisma.auction.findUnique({
      where:  { id: params.id },
      select: {
        id: true, status: true, endsAt: true, sellerId: true,
        startingBid: true, currentBid: true, buyOutPrice: true,
        listing: { select: { id: true, ...listingCatalogInclude } },
      },
    });

    if (!auction) {
      return NextResponse.json({ error: "Auction not found" }, { status: 404 });
    }
    if (auction.status !== "active") {
      return NextResponse.json({ error: "Auction is not active" }, { status: 409 });
    }
    if (auction.endsAt < new Date()) {
      return NextResponse.json({ error: "Auction has ended" }, { status: 409 });
    }
    if (auction.sellerId === bidderId) {
      return NextResponse.json(
        { error: "You cannot bid on your own auction" },
        { status: 403 }
      );
    }
    if (amountCents < auction.startingBid) {
      return NextResponse.json(
        { error: `Bid must be at least S$${(auction.startingBid / 100).toFixed(2)}` },
        { status: 400 }
      );
    }
    // A bid at the buy-out price wins instantly, so anything above it would
    // only overcharge the buyer (e.g. a typo) — reject rather than capture it.
    if (auction.buyOutPrice !== null && amountCents > auction.buyOutPrice) {
      return NextResponse.json(
        { error: `Bid cannot exceed the buy-out price of S$${(auction.buyOutPrice / 100).toFixed(2)}` },
        { status: 400 }
      );
    }
    if (auction.currentBid !== null && amountCents <= auction.currentBid) {
      return NextResponse.json(
        { error: `Bid must be higher than the current bid of S$${(auction.currentBid / 100).toFixed(2)}` },
        { status: 400 }
      );
    }

    // ── 4. Create the Stripe PaymentIntent ───────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount:         amountCents,
      currency:       "sgd",
      capture_method: "manual", // authorise now, capture only if this bid wins
      metadata: {
        bidderId,
        auctionId: params.id,
        cardTitle: withListingDisplay(auction.listing as any).title,
      },
    });

    return NextResponse.json({
      clientSecret:    paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("[auctions/bid/intent POST] error:", err);
    return NextResponse.json(
      { error: "Failed to create payment intent" },
      { status: 500 }
    );
  }
}
