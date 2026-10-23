// src/lib/listingDisplay.ts
//
// Card identity (title, rarity, set, etc.) now lives on PokemonCardCatalog/
// RiftboundCardCatalog, reached through a Listing's pokemonCard/riftboundCard
// relation, not as flat columns on Listing itself. Every API route that used
// to read these fields directly off a Card row now needs to (a) include the
// right catalog relation in its Prisma query and (b) resolve the display
// fields through this helper — keeping the external JSON shape (CardItem's
// flat title/rarity/setName/language/cardNumber/tcgPlayerId fields) exactly
// as the frontend already expects, so no frontend changes are needed here.

import type { Prisma } from "@prisma/client";
import { centsToDollars } from "@/lib/money";
import type { CardItem } from "@/types/card";

export const listingCatalogInclude = {
  pokemonCard: true,
  riftboundCard: true,
} satisfies Prisma.ListingInclude;

type ListingWithCatalog = Prisma.ListingGetPayload<{
  include: typeof listingCatalogInclude;
}>;

export interface ListingDisplayFields {
  title: string;
  rarity: string | null;
  setName: string | null;
  language: string;
  cardNumber: string | null;
  tcgPlayerId: string;
  // Riftbound-only — undefined for a pokemonCard listing.
  type?: string;
  supertype?: string;
}

// Resolves the flat display fields for a listing, regardless of which game
// it belongs to. Pokemon and Riftbound catalogs don't share a rarity/set
// naming scheme (setNameEn vs setLabel, localId vs collectorNumber) — this
// is the one place that difference is flattened away for API consumers.
export function resolveListingDisplay(
  listing: ListingWithCatalog
): ListingDisplayFields {
  if (listing.pokemonCard) {
    const p = listing.pokemonCard;
    return {
      title: p.nameEn,
      rarity: p.rarity,
      setName: p.setNameEn,
      language: p.language,
      // As printed ("001/073"); localId for rows imported before it existed.
      cardNumber: p.printedNumber ?? p.localId,
      tcgPlayerId: p.tcgPlayerId ?? "",
    };
  }
  if (listing.riftboundCard) {
    const r = listing.riftboundCard;
    return {
      title: r.name,
      rarity: r.rarity,
      setName: r.setLabel,
      language: "English",
      cardNumber: r.printedNumber ?? r.collectorNumber,
      tcgPlayerId: r.tcgPlayerId ?? "",
      type: r.type,
      supertype: r.supertype,
    };
  }
  throw new Error(
    `Listing ${listing.id} has no catalog reference (neither pokemonCard nor riftboundCard is set).`
  );
}

// Narrower counterpart to resolveListingDisplay, for the handful of routes
// that deliberately fetch pokemonCard/riftboundCard via a narrow `select`
// (title/setName/rarity/type/language only — see GET /api/cards/browse-index
// and GET /api/auctions/browse-index) rather than the full catalog relation
// resolveListingDisplay expects. Those routes can't use resolveListingDisplay
// (its type requires the fuller relation shape), but still share the exact
// same pokemon-then-riftbound fallback ordering and "English" default — this
// is the one place that ordering is written down, so a future change to it
// (e.g. the language default) only needs to happen here.
export function resolveCatalogDisplayCore(listing: {
  pokemonCard?: { nameEn: string; rarity: string | null; setNameEn: string | null; language: string } | null;
  riftboundCard?: { name: string; rarity: string | null; setLabel: string | null; type: string } | null;
}): { title: string; setName: string | null; rarity: string | null; type: string | null; language: string } {
  const p = listing.pokemonCard;
  const r = listing.riftboundCard;
  return {
    title: p?.nameEn ?? r?.name ?? "",
    setName: p?.setNameEn ?? r?.setLabel ?? null,
    rarity: p?.rarity ?? r?.rarity ?? null,
    type: r?.type ?? null,
    language: p?.language ?? "English",
  };
}

// Merges a listing's resolved display fields into its own object, dropping
// the raw pokemonCard/riftboundCard relation objects from the result (the
// frontend doesn't consume those — it reads the flat fields this spreads
// in, same names/types the old Card model had).
//
// Also drops the Buy Now reservation and pickup bookkeeping columns: this
// shape is what public endpoints return, and those columns reveal who is
// checking out a card right now (reservedById), their Stripe session id, and
// pickup timing. Server logic that needs them reads Prisma rows directly.
type PrivateListingField =
  | "reservedById"
  | "reservedUntil"
  | "reservedCheckoutSessionId"
  | "collectedAt";

export function withListingDisplay<T extends ListingWithCatalog>(
  listing: T
): Omit<T, "pokemonCard" | "riftboundCard" | PrivateListingField> & ListingDisplayFields {
  const {
    pokemonCard, riftboundCard,
    reservedById, reservedUntil, reservedCheckoutSessionId, collectedAt,
    ...rest
  } = listing as T & Partial<Record<PrivateListingField, unknown>>;
  return { ...rest, ...resolveListingDisplay(listing) } as Omit<
    T, "pokemonCard" | "riftboundCard" | PrivateListingField
  > & ListingDisplayFields;
}

// Public view of a Buy Now hold. reservedUntil: when another buyer's hold
// ends (ISO), so the page can show "Reserved" — never who holds it.
// reservedByViewer: the viewer is the buyer checking out, so their page can
// close that checkout (they came back from Stripe without paying).
export function publicReservation(
  listing: { reservedById: string | null; reservedUntil: Date | null },
  viewerUserId: string | undefined
): { reservedUntil: string | null; reservedByViewer: boolean } {
  const active = listing.reservedUntil != null && listing.reservedUntil > new Date();
  const byViewer = active && !!viewerUserId && listing.reservedById === viewerUserId;
  return {
    reservedUntil: active && !byViewer ? listing.reservedUntil!.toISOString() : null,
    reservedByViewer: byViewer,
  };
}

// Single source of truth for the card-detail page's data, shared by GET
// /api/cards/[id] (the client's own fetch, used on a client-side navigation
// between sibling /cards/[id] pages) and the card-detail page's server
// component (the initial page load). Keeping this in one place means the
// server-rendered initial card and the client's later refetch can never
// drift into returning different shapes. viewerUserId is undefined for a
// logged-out visitor.
export async function getCardDetailForViewer(
  db: Prisma.TransactionClient,
  id: string,
  viewerUserId: string | undefined
): Promise<CardItem | null> {
  const [listing, watchlistEntry] = await Promise.all([
    db.listing.findUnique({
      where: { id },
      include: {
        // Public card detail page — email deliberately excluded (nothing in
        // the frontend reads it here, and card owners' emails shouldn't be
        // exposed to anonymous visitors).
        owner: { select: { id: true, username: true } },
        _count: { select: { watchlist: true } },
        ...listingCatalogInclude,
      },
    }),
    viewerUserId
      ? db.cardWatchlist.findUnique({
          where: { listingId_userId: { listingId: id, userId: viewerUserId } },
        })
      : Promise.resolve(null),
  ]);

  if (!listing) return null;

  const watchlistedByUser = !!watchlistEntry;
  const { _count, ...rest } = withListingDisplay(listing);
  return {
    ...rest,
    price: rest.price != null ? centsToDollars(rest.price) : null,
    watchlistCount: _count.watchlist,
    watchlistedByUser,
    ...publicReservation(listing, viewerUserId),
    // Same vocabulary GET /api/user/cards already uses for this field
    // (minus the collection-request case, not fetched here).
    status: listing.inAuction ? "in_auction" : listing.forSale ? "for_sale" : "available",
    // Prisma returns real Date objects; a normal fetch()+res.json() call
    // turns them into ISO strings, which is the shape CardItem declares.
    // Converted explicitly here so a server-rendered initialCard and a
    // later client fetch are byte-identical, whichever path a consumer hit.
    createdAt: rest.createdAt.toISOString(),
    updatedAt: rest.updatedAt.toISOString(),
    // Public page — pickup bookkeeping is the owner's business only.
    collectionRequestId: undefined,
    // `game` is stored as a plain String column (not a Prisma enum), so it
    // needs the same trust-the-application-invariant cast every other
    // consumer of this data already relies on implicitly.
  } as CardItem;
}
