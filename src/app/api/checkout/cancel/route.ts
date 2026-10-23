// POST /api/checkout/cancel — the buyer left Stripe Checkout (its back link,
// or the browser's back button), so close their checkout now instead of
// keeping the card held for the full 15 minutes.
//
// Body: { cardId?: string } — limits it to the checkout holding that card
// (Buy Now). Without it (cart), every open checkout of this buyer is closed.
// Only ever touches listings reserved by the signed-in buyer.
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimitResponse } from "@/lib/rateLimit";
import { closeCheckoutSession } from "@/lib/checkoutSessions";

export async function POST(req: NextRequest) {
  const authSession = await getServerSession(authOptions);
  const buyerId = authSession?.user?.id;
  if (!buyerId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // 🔒 Each call can hit the Stripe API — see src/lib/rateLimit.ts.
  const limited = rateLimitResponse(
    `checkout-cancel:${buyerId}`,
    { limit: 20, windowMs: 15 * 60 * 1000 },
    "Too many requests. Please try again in a few minutes."
  );
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const cardId = typeof body?.cardId === "string" ? body.cardId : undefined;

  try {
    const held = await prisma.listing.findMany({
      where: {
        reservedById: buyerId,
        reservedCheckoutSessionId: { not: null },
        ...(cardId && { id: cardId }),
      },
      select: { reservedCheckoutSessionId: true },
    });

    let released = 0;
    let paid = false;
    for (const sessionId of new Set(held.map((l) => l.reservedCheckoutSessionId!))) {
      if (await closeCheckoutSession(sessionId)) released++;
      else paid = true;
    }
    return NextResponse.json({ released, paid });
  } catch (err) {
    console.error("[checkout/cancel] error:", buyerId, err);
    return NextResponse.json({ error: "Failed to cancel checkout" }, { status: 500 });
  }
}
