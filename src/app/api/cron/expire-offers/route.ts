import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { expireOffer, recoverStuckAcceptedOffer } from "@/lib/offerExpiry";

/**
 * GET /api/cron/expire-offers  ← called by an external scheduler (cron-job.org)
 * POST /api/cron/expire-offers ← kept for local curl testing
 *
 * Not a Vercel Cron Job — this project is on Vercel's Hobby plan, which
 * caps native cron jobs at once per day, too infrequent for timely offer
 * expiry. cron-job.org calls this URL directly on its own schedule, which
 * is configured entirely in its dashboard (not in this repo).
 *
 * Background job that cleans up overdue pending offers.
 *
 * Why is this needed?
 * ───────────────────
 * When a buyer places an offer, Stripe authorises (holds) the funds on their
 * card. If the seller never responds, that hold must eventually be released —
 * otherwise the buyer's money is stuck indefinitely.
 *
 * This job:
 *   1. Finds all pending offers where expiresAt has passed (seller didn't respond
 *      within 24h).
 *   2. For each one, calls expireOffer() which:
 *        a. Cancels the Stripe PaymentIntent → releases the hold on buyer's card
 *        b. Sets offer status → "expired" in the DB
 *
 * For local testing:
 *   curl http://localhost:3000/api/cron/expire-offers \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 *
 * Security:
 * ─────────
 * Protected by CRON_SECRET env var — the caller must send
 * `Authorization: Bearer <CRON_SECRET>` or this returns 401. Set it in
 * Vercel → Settings → Environment Variables, in your local .env, and as a
 * custom header on the cron-job.org job hitting this URL.
 */
async function runExpiry(req: NextRequest): Promise<NextResponse> {
  // ── 1. Authorise the cron caller ──────────────────────────────────────────
  // The secret must match CRON_SECRET in env. Use a long random string.
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.CRON_SECRET;

  if (!expectedToken) {
    // Misconfiguration — log loudly and refuse
    console.error("[cron/expire-offers] CRON_SECRET env var is not set");
    return NextResponse.json(
      { error: "Server misconfiguration" },
      { status: 500 }
    );
  }

  if (authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Find all pending offers that have passed their expiry time ──────────
  // "pending" = seller hasn't responded yet
  // expiresAt < now = the 24h window has passed
  //
  // Also picks up offers stuck in "accepted" — an accept that died mid-way
  // (see recoverStuckAcceptedOffer). A live accept finishes in seconds, so
  // 15 minutes without an update means it is not coming back.
  const now = new Date();
  const stuckBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const expiredOffers = await prisma.offer.findMany({
    where: {
      OR: [
        { status: "pending", expiresAt: { lt: now } },
        { status: "accepted", updatedAt: { lt: stuckBefore } },
      ],
    },
    select: {
      id: true,
      status: true,
      paymentIntentId: true,
      buyerId: true,
      listingId: true,
    },
  });

  if (expiredOffers.length === 0) {
    return NextResponse.json({ expired: 0, message: "Nothing to expire" });
  }

  // ── 3. Expire each offer one by one ───────────────────────────────────────
  // We process sequentially (not in parallel) to avoid hammering Stripe's API
  // with a burst of concurrent requests. If one fails, we log and continue so
  // the rest still get processed.
  const results = { success: 0, failed: 0, errors: [] as string[] };

  for (const offer of expiredOffers) {
    try {
      // expireOffer: cancels the PI then marks offer "expired" in DB
      if (offer.status === "accepted") await recoverStuckAcceptedOffer(offer);
      else await expireOffer(offer);
      results.success++;
    } catch (err) {
      results.failed++;
      results.errors.push(
        `Offer ${offer.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error("[cron/expire-offers] Failed to expire offer:", offer.id, err);
    }
  }

  // ── 4. Return a summary ───────────────────────────────────────────────────
  // Useful for monitoring / alerting. Check these in your cron service logs.
  console.log(
    `[cron/expire-offers] Done. Success: ${results.success}, Failed: ${results.failed}`
  );

  return NextResponse.json({
    expired: results.success,
    failed: results.failed,
    ...(results.errors.length > 0 && { errors: results.errors }),
  });
}

// Vercel Cron Jobs call via GET — export both so local curl testing still works.
export const GET = runExpiry;
export const POST = runExpiry;
