// src/lib/auctionsQuery.ts
//
// Shared by GET /api/auctions (client-side search/filter/sort/pagination)
// and the /auctions Server Component (initial page-1 fetch at request
// time) — mirrors src/lib/listingsQuery.ts's split for the marketplace.

import { prisma } from "@/lib/prisma";
import { centsToDollars } from "@/lib/money";
import { listingCatalogInclude, resolveCatalogDisplayCore } from "@/lib/listingDisplay";
import type { AuctionCard } from "@/types/auction";
import type { Prisma } from "@prisma/client";

export const MAX_PAGE_SIZE = 100;
// Same rationale as listingsQuery.ts's MAX_IDS — this route is also public/
// unauthenticated, so this bounds how much untrusted `ids` input a single
// query can be inflated with.
export const MAX_IDS = 200;

export const AUCTION_LISTING_SELECT = {
  id: true,
  imageUrls: true,
  condition: true,
  inAuction: true,
  owner: { select: { id: true, username: true } },
  ...listingCatalogInclude,
} as const;

export const AUCTION_INCLUDE = {
  listing: { select: AUCTION_LISTING_SELECT },
  _count: { select: { bids: true } },
} satisfies Prisma.AuctionInclude;

// Hoisted so every route/branch that calls formatAuction shares the exact
// same expected shape — a bare `any` parameter (the previous state of this
// function) let a caller pass anything through unnoticed by tsc, including
// a row missing fields formatAuction actually reads.
type AuctionWithRelations = Prisma.AuctionGetPayload<{ include: typeof AUCTION_INCLUDE }>;

// AUCTION_LISTING_SELECT is a Listing `select` (narrower than the FULL
// listingCatalogInclude `include` withListingDisplay/resolveListingDisplay
// are typed for), so this can't call those directly without fighting a type
// mismatch that a bare `any` parameter (the previous state of formatAuction)
// was silently masking. It shares the title/setName/rarity/language fallback
// logic itself via resolveCatalogDisplayCore (same helper GET
// /api/auctions/browse-index uses) and resolves the remaining
// AuctionCard-only fields (cardNumber, tcgPlayerId) locally.
function resolveAuctionCard(listing: AuctionWithRelations["listing"]): AuctionCard {
  const p = listing.pokemonCard;
  const r = listing.riftboundCard;
  const { title, setName, rarity, language } = resolveCatalogDisplayCore(listing);
  return {
    id: listing.id,
    title,
    imageUrls: listing.imageUrls,
    condition: listing.condition,
    setName,
    language,
    cardNumber: p?.localId ?? r?.collectorNumber ?? null,
    rarity,
    tcgPlayerId: p?.tcgPlayerId ?? r?.tcgPlayerId ?? "",
    inAuction: listing.inAuction,
    owner: listing.owner,
  };
}

// Converts a DB Auction row (with the above listing include and a
// _count.bids) to the API response shape — the one place this mapping
// exists, shared by every route/branch that returns auctions.
export function formatAuction(auction: AuctionWithRelations) {
  return {
    id: auction.id,
    cardId: auction.listingId,
    sellerId: auction.sellerId,
    startingBid: centsToDollars(auction.startingBid),
    reservePrice: auction.reservePrice != null ? centsToDollars(auction.reservePrice) : null,
    buyOutPrice: auction.buyOutPrice != null ? centsToDollars(auction.buyOutPrice) : null,
    currentBid: auction.currentBid != null ? centsToDollars(auction.currentBid) : null,
    status: auction.status,
    endsAt: auction.endsAt.toISOString(),
    sellerDecisionDeadline: auction.sellerDecisionDeadline?.toISOString() ?? null,
    version: auction.version,
    bidCount: auction._count.bids,
    card: resolveAuctionCard(auction.listing),
  };
}

export type AuctionSort = "endingSoon" | "mostBids" | "newest" | "priceLow" | "priceHigh";

export interface AuctionsQueryParams {
  game?: "POKEMON" | "RIFTBOUND" | null;
  setNames?: string[];
  rarities?: string[];
  types?: string[];
  languages?: string[];
  conditions?: string[];
  ids?: string[];
  // Only auctions with a Buy Now (instant-purchase) price set.
  buyNowOnly?: boolean;
  // Only auctions ending within this many hours from now.
  endingWithinHours?: number | null;
  sort?: AuctionSort;
  page?: number | null;
  pageSize?: number | null;
}

export interface AuctionsPageResult {
  auctions: ReturnType<typeof formatAuction>[];
  totalCount?: number;
  hasMore?: boolean;
}

function buildOrderBy(sort: AuctionSort): Prisma.AuctionOrderByWithRelationInput[] {
  switch (sort) {
    case "mostBids":
      return [{ bids: { _count: "desc" } }, { endsAt: "asc" }];
    case "newest":
      return [{ createdAt: "desc" }];
    // currentBid is null until the first bid; Postgres would put NULLs first
    // on DESC, listing every no-bid auction above the priciest one. Pin them
    // last in both directions (then by startingBid).
    // ponytail: not a true effective-price sort (COALESCE(currentBid,
    // startingBid)); needs a computed column or raw SQL if that matters.
    case "priceLow":
      return [{ currentBid: { sort: "asc", nulls: "last" } }, { startingBid: "asc" }];
    case "priceHigh":
      return [{ currentBid: { sort: "desc", nulls: "last" } }, { startingBid: "desc" }];
    case "endingSoon":
    default:
      return [{ endsAt: "asc" }];
  }
}

export async function getAuctionsPage(params: AuctionsQueryParams): Promise<AuctionsPageResult> {
  const {
    game,
    setNames = [], rarities = [], types = [], languages = [], conditions = [], ids = [],
    buyNowOnly = false, endingWithinHours = null,
    sort = "endingSoon",
    page = null, pageSize = null,
  } = params;

  const and: Prisma.AuctionWhereInput[] = [
    { status: "active" },
    { endsAt: { gt: new Date() } },
  ];

  if (buyNowOnly) and.push({ buyOutPrice: { not: null } });
  if (endingWithinHours != null && endingWithinHours > 0) {
    and.push({ endsAt: { lte: new Date(Date.now() + endingWithinHours * 60 * 60 * 1000) } });
  }

  const clampedIds = ids.slice(0, MAX_IDS);
  if (clampedIds.length > 0) and.push({ id: { in: clampedIds } });

  // Every catalog-scoped filter below applies through the linked Listing —
  // same OR-across-both-games shape as listingsQuery.ts, since an auction's
  // card identity lives on Listing.pokemonCard/riftboundCard, not on Auction
  // itself.
  if (game === "POKEMON" || game === "RIFTBOUND") and.push({ listing: { game } });
  if (setNames.length > 0) {
    and.push({
      listing: {
        OR: [
          { pokemonCard: { setNameEn: { in: setNames } } },
          { riftboundCard: { setLabel: { in: setNames } } },
        ],
      },
    });
  }
  if (rarities.length > 0) {
    and.push({
      listing: {
        OR: [
          { pokemonCard: { rarity: { in: rarities } } },
          { riftboundCard: { rarity: { in: rarities } } },
        ],
      },
    });
  }
  if (types.length > 0) and.push({ listing: { riftboundCard: { type: { in: types } } } });
  if (conditions.length > 0) and.push({ listing: { condition: { in: conditions } } });
  if (languages.length > 0) {
    and.push({
      listing: {
        OR: [
          { pokemonCard: { language: { in: languages } } },
          ...(languages.includes("English") ? [{ game: "RIFTBOUND" as const }] : []),
        ],
      },
    });
  }

  const where: Prisma.AuctionWhereInput = { AND: and };

  const isPaginated = page != null && pageSize != null;
  const clampedPage = isPaginated ? Math.max(1, page!) : null;
  const clampedPageSize = isPaginated ? Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize!)) : null;
  const skip = isPaginated ? (clampedPage! - 1) * clampedPageSize! : 0;
  const take = isPaginated ? clampedPageSize! : MAX_PAGE_SIZE;

  const [auctions, totalCount] = await Promise.all([
    prisma.auction.findMany({
      where,
      include: AUCTION_INCLUDE,
      orderBy: buildOrderBy(sort),
      skip,
      take,
    }),
    isPaginated ? prisma.auction.count({ where }) : Promise.resolve(null),
  ]);

  const result: AuctionsPageResult = { auctions: auctions.map(formatAuction) };
  if (isPaginated && totalCount != null) {
    result.totalCount = totalCount;
    result.hasMore = clampedPage! * clampedPageSize! < totalCount;
  }
  return result;
}
