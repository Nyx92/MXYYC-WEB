import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import { centsToDollars } from "@/lib/money";
import { listingCatalogInclude, withListingDisplay } from "@/lib/listingDisplay";
import type { Prisma } from "@prisma/client";

// Data for the home page feed (best sellers, highest transacted, newly
// listed, auctions ending soon). Used by GET /api/home/featured and by the
// home page itself, which renders it on the server so the card images start
// loading with the HTML.
function mapCard(listing: any) {
  const withDisplay = withListingDisplay(listing);
  return {
    ...withDisplay,
    price: withDisplay.price != null ? centsToDollars(withDisplay.price) : null,
  };
}

// ── Converts a DB Auction row to the API response shape ──────────────────────
// Mirrors the formatAuction function in /api/auctions/route.ts.
function formatAuction(auction: {
  id: string; listingId: string; sellerId: string;
  startingBid: number; reservePrice: number | null; buyOutPrice: number | null;
  currentBid: number | null; highestBidderId: string | null;
  status: string; endsAt: Date; sellerDecisionDeadline: Date | null;
  version: number;
  _count: { bids: number };
  listing: any;
}) {
  return {
    id:                     auction.id,
    cardId:                 auction.listingId,
    sellerId:               auction.sellerId,
    startingBid:            centsToDollars(auction.startingBid),
    reservePrice:           auction.reservePrice   != null ? centsToDollars(auction.reservePrice)   : null,
    buyOutPrice:            auction.buyOutPrice    != null ? centsToDollars(auction.buyOutPrice)    : null,
    currentBid:             auction.currentBid     != null ? centsToDollars(auction.currentBid)     : null,
    highestBidderId:        auction.highestBidderId,
    status:                 auction.status,
    endsAt:                 auction.endsAt.toISOString(),
    sellerDecisionDeadline: auction.sellerDecisionDeadline?.toISOString() ?? null,
    version:                auction.version,
    bidCount:               auction._count.bids,
    card:                   withListingDisplay(auction.listing),
  };
}

const AUCTION_LISTING_SELECT = {
  id: true, imageUrls: true, condition: true, inAuction: true,
  owner: { select: { id: true, username: true } },
  pokemonCard: true,
  riftboundCard: true,
} as const;

const listingInclude = {
  // Public, unauthenticated endpoint — email deliberately excluded, same
  // rationale as src/app/api/cards/route.ts and cards/[id]/route.ts.
  owner: { select: { id: true, username: true } },
  ...listingCatalogInclude,
} as const;

type ListingWithInclude = Prisma.ListingGetPayload<{ include: typeof listingInclude }>;

// Both bestSellers and highestTransacted originally issued one
// prisma.listing.findFirst per tcgPlayerId (up to 12 queries between the
// two, fanned out via Promise.all) to find "the cheapest forSale listing
// for this card". Batches that into a single findMany + one in-memory pass
// instead — each caller still gets "cheapest listing per tcgPlayerId", just
// via one round trip instead of N. orderBy price asc means the first listing
// seen per tcgPlayerId in the loop below is the cheapest one, since a Map
// only keeps the first value ever set for a key.
async function cheapestListingPerTcgPlayerId(
  tcgPlayerIds: string[]
): Promise<Map<string, ListingWithInclude>> {
  if (tcgPlayerIds.length === 0) return new Map();

  const listings = await prisma.listing.findMany({
    where: {
      forSale: true,
      OR: [
        { pokemonCard: { tcgPlayerId: { in: tcgPlayerIds } } },
        { riftboundCard: { tcgPlayerId: { in: tcgPlayerIds } } },
      ],
    },
    include: listingInclude,
    orderBy: { price: "asc" },
  });

  const cheapestByTcgPlayerId = new Map<string, ListingWithInclude>();
  for (const listing of listings) {
    const tcgPlayerId = listing.pokemonCard?.tcgPlayerId ?? listing.riftboundCard?.tcgPlayerId;
    if (tcgPlayerId && !cheapestByTcgPlayerId.has(tcgPlayerId)) {
      cheapestByTcgPlayerId.set(tcgPlayerId, listing);
    }
  }
  return cheapestByTcgPlayerId;
}

async function buildHomeFeatured() {
  const [bestSellers, highestTransacted, newlyListedRaw, endingSoonRaw] = await Promise.all([
    // Best Sellers: admin-curated, ordered by position.
    // Fetch all rows then slice to 5 *after* filtering out any tcgPlayerIds that
    // have no forSale listing — prevents a null hole from shrinking the visible row.
    (async () => {
      const bestSellerRows = await prisma.bestSeller.findMany({
        orderBy: { position: "asc" },
      });
      const cheapestByTcgPlayerId = await cheapestListingPerTcgPlayerId(
        bestSellerRows.map((r) => r.tcgPlayerId)
      );
      return bestSellerRows
        .map(({ tcgPlayerId }) => cheapestByTcgPlayerId.get(tcgPlayerId))
        .filter((listing): listing is ListingWithInclude => Boolean(listing))
        .slice(0, 5)
        .map(mapCard);
    })(),

    // Highest Transacted: group transactions by tcgPlayerId — already a
    // denormalized column on CardTransaction, no join needed — then fetch
    // the cheapest forSale listing for each.
    (async () => {
      const topTcgPlayerIds = await prisma.$queryRaw<
        Array<{ tcgPlayerId: string; count: bigint }>
      >`
        SELECT ct."tcgPlayerId", COUNT(*) AS count
        FROM "CardTransaction" ct
        WHERE ct."tcgPlayerId" IS NOT NULL
        GROUP BY ct."tcgPlayerId"
        ORDER BY count DESC
        LIMIT 5
      `;
      const cheapestByTcgPlayerId = await cheapestListingPerTcgPlayerId(
        topTcgPlayerIds.map((t) => t.tcgPlayerId)
      );
      return topTcgPlayerIds
        .map(({ tcgPlayerId }) => cheapestByTcgPlayerId.get(tcgPlayerId))
        .filter((listing): listing is ListingWithInclude => Boolean(listing))
        .map(mapCard);
    })(),

    // Newly Listed: 5 most recent forSale listings
    prisma.listing.findMany({
      where: { forSale: true },
      include: listingInclude,
      orderBy: { createdAt: "desc" },
      take: 5,
    }),

    // Auctions Ending Soon: 5 active auctions with the earliest end time.
    // Mirrors GET /api/auctions?expiringSoon=true so HomeFeatured can render
    // the auction row immediately without a separate client-side fetch.
    prisma.auction.findMany({
      where:   { status: "active", endsAt: { gt: new Date() } },
      include: { listing: { select: AUCTION_LISTING_SELECT }, _count: { select: { bids: true } } },
      orderBy: { endsAt: "asc" },
      take:    5,
    }),
  ]);

  return {
    bestSellers,
    highestTransacted,
    newlyListed:        newlyListedRaw.map(mapCard),
    auctionsEndingSoon: endingSoonRaw.map(formatAuction),
  };
}

export type HomeFeatured = Awaited<ReturnType<typeof buildHomeFeatured>>;

// This query was measured taking 8-9s in production (cross-region DB round
// trips stacking up across many queries), so the result is shared for 60s
// instead of re-run on every homepage visit. unstable_cache stores it as
// JSON, so callers get the same plain shape (dates as strings) the API sends.
// ponytail: unstable_cache is replaced by "use cache" in Next 16 — switch
// when the app opts into cacheComponents.
export const getHomeFeatured = unstable_cache(buildHomeFeatured, ["home-featured"], { revalidate: 60 });
