import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listingLockableWhere } from "@/lib/collectionRequests";
import { MAX_AUCTION_DAYS } from "@/constants/auctions";
import { dollarsToCents } from "@/lib/money";
import {
  formatAuction,
  getAuctionsPage,
  AUCTION_INCLUDE,
  type AuctionSort,
} from "@/lib/auctionsQuery";

const VALID_SORTS: AuctionSort[] = ["endingSoon", "mostBids", "newest", "priceLow", "priceHigh"];

/**
 * GET /api/auctions
 *   ?cardId=xxx        — active auction for a specific card (used by card detail page)
 *   ?expiringSoon=true — the 5 active auctions expiring soonest (used by homepage row)
 *   (no params)        — browse: game/setName/rarity/type/language/condition
 *                         (repeatable), buyNowOnly, endingWithinHours, sort,
 *                         ids (repeatable), page, pageSize — used by the
 *                         /auctions listing page. All optional; with none
 *                         given, behaves exactly as before (all active
 *                         auctions, soonest-ending first, capped at 100).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const cardId       = searchParams.get("cardId");
  const expiringSoon = searchParams.get("expiringSoon") === "true";

  try {
    // ── Active auction for a single card ──────────────────────────────────────
    // Returns any auction that is still active or awaiting the seller's decision.
    // We intentionally include "active + endsAt in the past" rows here — the client
    // distinguishes them by checking endsAt and bidCount:
    //   • active + past + bidCount = 0  → treated as ended immediately (auctionExpiredClientSide in page.tsx)
    //   • active + past + bidCount > 0  → pre-cron window; info box shown ("refresh shortly")
    //   • pending_seller_decision       → Accept/Decline buttons shown
    if (cardId) {
      const auction = await prisma.auction.findFirst({
        where: {
          listingId: cardId,
          status: { in: ["active", "pending_seller_decision"] },
        },
        include: AUCTION_INCLUDE,
      });

      return NextResponse.json({ auction: auction ? formatAuction(auction) : null });
    }

    // ── Expiring-soon: the 5 active auctions with the earliest end time ──────
    // endsAt > now guards the window between endsAt passing and the cron running
    // (up to ~5 min), ensuring stale "active" auctions don't leak into the row.
    if (expiringSoon) {
      const auctions = await prisma.auction.findMany({
        where:   { status: "active", endsAt: { gt: new Date() } },
        include: AUCTION_INCLUDE,
        orderBy: { endsAt: "asc" },
        take:    5,
      });

      return NextResponse.json({ auctions: auctions.map(formatAuction) });
    }

    // ── Browse (auctions listing page) ────────────────────────────────────────
    const gameParam = searchParams.get("game");
    const sortParam = searchParams.get("sort");
    const pageParam = searchParams.get("page");
    const pageSizeParam = searchParams.get("pageSize");
    const endingWithinHoursParam = searchParams.get("endingWithinHours");

    // Same isPaginated guard as cards/route.ts — without the Number.isNaN
    // check, `?page=abc` would fall through as "paginated" with a NaN page,
    // producing a NaN skip/take that Prisma throws on (500) instead of
    // gracefully falling back to unpaginated.
    const rawPage = pageParam ? parseInt(pageParam, 10) : null;
    const rawPageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : null;
    const isPaginated =
      rawPage != null && rawPageSize != null && !Number.isNaN(rawPage) && !Number.isNaN(rawPageSize);

    const result = await getAuctionsPage({
      game: gameParam === "POKEMON" || gameParam === "RIFTBOUND" ? gameParam : null,
      setNames: searchParams.getAll("setName"),
      rarities: searchParams.getAll("rarity"),
      types: searchParams.getAll("type"),
      languages: searchParams.getAll("language"),
      conditions: searchParams.getAll("condition"),
      ids: searchParams.getAll("ids"),
      buyNowOnly: searchParams.get("buyNowOnly") === "true",
      endingWithinHours: endingWithinHoursParam ? Number(endingWithinHoursParam) : null,
      sort: VALID_SORTS.includes(sortParam as AuctionSort) ? (sortParam as AuctionSort) : "endingSoon",
      page: isPaginated ? rawPage : null,
      pageSize: isPaginated ? rawPageSize : null,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[auctions GET] error:", err);
    return NextResponse.json({ error: "Failed to fetch auctions" }, { status: 500 });
  }
}

/**
 * POST /api/auctions
 *
 * Seller starts an auction on one of their cards.
 *
 * 1. Auth check — must be logged in.
 * 2. Validate inputs:
 *    - startingBid required and > 0
 *    - durationDays must be 1–MAX_AUCTION_DAYS (5)
 *    - buyOutPrice > reservePrice if both supplied
 * 3. Load the card — must be owned by the seller and not already in auction.
 *    3b. Guard: card must not have a pending offer.
 *    3c. Guard: card must not have an active Buy Now reservation.
 * 4. Create the Auction record.
 * 5. Mark Listing.inAuction = true and Listing.forSale = false so offers and
 *    Buy Now are blocked while the auction is running.
 *
 * Body: { cardId, startingBid (dollars), reservePrice?, buyOutPrice?, durationDays }
 */
export async function POST(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const sellerId = session.user.id;

  try {
    const { cardId, startingBid, reservePrice, buyOutPrice, durationDays } =
      await req.json();

    // ── 2. Validate inputs ──────────────────────────────────────────────────
    if (!cardId) {
      return NextResponse.json({ error: "cardId is required" }, { status: 400 });
    }

    // Number.isNaN checks come BEFORE the <= 0 comparisons below —
    // `NaN <= 0` and `!amount` (for a truthy non-numeric string) are both
    // `false`, so a non-numeric input would otherwise silently reach
    // prisma.auction.create as NaN and surface as a raw 500.
    const startingBidNum = Number(startingBid);
    if (!startingBid || Number.isNaN(startingBidNum)) {
      return NextResponse.json(
        { error: "Starting bid must be greater than $0" },
        { status: 400 }
      );
    }
    const startingBidCents = dollarsToCents(startingBidNum);
    if (startingBidCents <= 0) {
      return NextResponse.json(
        { error: "Starting bid must be greater than $0" },
        { status: 400 }
      );
    }

    const days = Number(durationDays);
    if (!durationDays || Number.isNaN(days) || days < 1 || days > MAX_AUCTION_DAYS) {
      return NextResponse.json(
        { error: `Duration must be between 1 and ${MAX_AUCTION_DAYS} days` },
        { status: 400 }
      );
    }

    if (reservePrice != null && Number.isNaN(Number(reservePrice))) {
      return NextResponse.json({ error: "Reserve price must be a number" }, { status: 400 });
    }
    if (buyOutPrice != null && Number.isNaN(Number(buyOutPrice))) {
      return NextResponse.json({ error: "Buy-out price must be a number" }, { status: 400 });
    }

    const reservePriceCents = reservePrice != null ? dollarsToCents(Number(reservePrice)) : null;
    const buyOutPriceCents  = buyOutPrice  != null ? dollarsToCents(Number(buyOutPrice))  : null;

    if (reservePriceCents !== null && reservePriceCents < startingBidCents) {
      return NextResponse.json(
        { error: "Reserve price must be at least the starting bid" },
        { status: 400 }
      );
    }
    if (
      reservePriceCents !== null &&
      buyOutPriceCents  !== null &&
      buyOutPriceCents <= reservePriceCents
    ) {
      return NextResponse.json(
        { error: "Buy-out price must be higher than the reserve price" },
        { status: 400 }
      );
    }
    // Without a reserve price, buyOutPrice must still be at least the
    // starting bid — otherwise the first legal bid (>= startingBid) would
    // trigger an instant buy-out settlement below the seller's intended floor.
    if (
      reservePriceCents === null &&
      buyOutPriceCents  !== null &&
      buyOutPriceCents  < startingBidCents
    ) {
      return NextResponse.json(
        { error: "Buy-out price must be at least the starting bid" },
        { status: 400 }
      );
    }

    // ── 3. Verify the card belongs to the seller and is not in auction ───────
    const listing = await prisma.listing.findUnique({
      where:  { id: cardId },
      select: { ownerId: true, inAuction: true, reservedById: true, reservedUntil: true, collectionRequestId: true },
    });

    if (!listing) {
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }
    if (listing.ownerId !== sellerId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (listing.inAuction) {
      return NextResponse.json(
        { error: "This card already has an active auction" },
        { status: 409 }
      );
    }
    // Same reasoning as offers/reservation guards below — a card earmarked
    // for in-person pickup must not re-enter the market. See POST
    // /api/collection-requests.
    if (listing.collectionRequestId) {
      return NextResponse.json(
        { error: "Cannot start an auction on a card marked for in-person collection" },
        { status: 409 }
      );
    }

    // ── 3b. Guard: check card doesn't have a pending offer ──────────────────────
    // A card with a pending offer must not also be auctionable — the seller could
    // accept that offer mid-auction and settleAuction() would later overwrite the
    // transfer when the auction ends (the other half of this race, fixed in
    // offers/[id]/route.ts's accept flow).
    const pendingOffer = await prisma.offer.findFirst({
      where: { listingId: cardId, status: "pending", archivedAt: null },
      select: { id: true },
    });
    if (pendingOffer) {
      return NextResponse.json(
        { error: "This card has a pending offer — resolve it before starting an auction" },
        { status: 409 }
      );
    }

    // ── 3c. Guard: check card doesn't have an active Buy Now reservation ────
    // The checkout flow sets reservedById + reservedUntil but leaves forSale:
    // true until the webhook fires. If an auction is allowed to start during
    // that window, auction creation flips forSale to false, and the webhook's
    // card-transfer updateMany (which requires forSale: true) later fails for
    // the buyer who already paid — mirrors the same guard in
    // offers/[id]/route.ts's accept flow.
    if (
      listing.reservedById &&
      listing.reservedUntil &&
      listing.reservedUntil > new Date()
    ) {
      return NextResponse.json(
        { error: "Card is currently reserved by a pending checkout" },
        { status: 409 }
      );
    }

    // ── 4 & 5. Create auction + lock card (atomic) ───────────────────────────
    const endsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    // The checks above are plain reads; the conditional lock below re-checks
    // them under the row lock so two concurrent creates (or a create racing
    // a collection request / checkout) can't both win. No unique index backs
    // "one live auction per listing", so this updateMany is the enforcement.
    let auction;
    try {
      auction = await prisma.$transaction(async (tx) => {
        // Prevent Buy Now / offers while auction is live.
        const lock = await tx.listing.updateMany({
          where: { id: cardId, ownerId: sellerId, ...listingLockableWhere() },
          data: { inAuction: true, forSale: false },
        });
        if (lock.count !== 1) throw new Error("LISTING_UNAVAILABLE");

        return tx.auction.create({
          data: {
            listingId: cardId,
            sellerId,
            startingBid:  startingBidCents,
            reservePrice: reservePriceCents,
            buyOutPrice:  buyOutPriceCents,
            endsAt,
            status: "active",
          },
          include: AUCTION_INCLUDE,
        });
      });
    } catch (err) {
      if (err instanceof Error && err.message === "LISTING_UNAVAILABLE") {
        return NextResponse.json(
          { error: "This card is no longer available for auction" },
          { status: 409 }
        );
      }
      throw err;
    }

    console.log(`[auctions POST] Auction created: ${auction.id} for card ${cardId}`);

    return NextResponse.json({ auction: formatAuction(auction) }, { status: 201 });
  } catch (err) {
    console.error("[auctions POST] error:", err);
    return NextResponse.json({ error: "Failed to create auction" }, { status: 500 });
  }
}
