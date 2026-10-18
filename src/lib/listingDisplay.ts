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
      cardNumber: p.localId,
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
      cardNumber: r.collectorNumber,
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

// Admin upload/edit (POST/PUT /api/cards) still accepts flat identity fields
// via FormData, matching the pre-catalog form contract — no frontend changes
// needed. This finds an existing PokemonCardCatalog row by tcgPlayerId (the
// closest thing this app already had to a natural per-card key — see
// BestSeller.tcgPlayerId) or creates one, so repeated uploads of "the same"
// card reuse one catalog row instead of creating a new one every time.
//
// setId has no natural source in this manual-entry path (the form only
// collects a display-friendly setName, not a real set code) — tcgPlayerId
// is reused as a stand-in, matching the accepted pattern from the seed-data
// task in the schema-migration plan, which faced the same gap.
export async function findOrCreatePokemonCatalogEntry(
  prismaOrTx: Prisma.TransactionClient,
  fields: {
    title: string;
    setName: string;
    rarity: string;
    tcgPlayerId: string;
    language: string;
    cardNumber: string;
  }
) {
  return prismaOrTx.pokemonCardCatalog.upsert({
    where: { tcgPlayerId: fields.tcgPlayerId },
    update: {}, // an existing row wins as-is — matches the prior find-and-reuse behavior
    create: {
      externalId: `manual-${fields.tcgPlayerId}`,
      nameEn: fields.title,
      setNameEn: fields.setName,
      rarity: fields.rarity,
      language: fields.language,
      localId: fields.cardNumber || null,
      tcgPlayerId: fields.tcgPlayerId,
      setId: fields.tcgPlayerId,
    },
  });
}

// Admin edit (PUT /api/cards/[id]) for an existing POKEMON listing updates
// the catalog row directly by id, rather than re-running the find-or-create
// lookup — the listing already has a pokemonCardId, and catalog data is
// shared across every listing of that card, so an identity edit here is
// meant to update the canonical row (visible to every other seller's
// listing of the same card), not spawn or silently ignore a second one.
export async function updatePokemonCatalogEntry(
  prismaOrTx: Prisma.TransactionClient,
  catalogId: string,
  fields: {
    title: string;
    setName: string;
    rarity: string;
    tcgPlayerId: string;
    language: string;
    cardNumber: string;
  }
) {
  return prismaOrTx.pokemonCardCatalog.update({
    where: { id: catalogId },
    data: {
      nameEn: fields.title,
      setNameEn: fields.setName,
      rarity: fields.rarity,
      language: fields.language,
      localId: fields.cardNumber || null,
      tcgPlayerId: fields.tcgPlayerId,
    },
  });
}

// Riftbound counterpart to findOrCreatePokemonCatalogEntry above — same
// tcgPlayerId-keyed find-or-create shape, and the same setId-from-tcgPlayerId
// stand-in (no real set code source in this manual-entry path). Unlike
// PokemonCardCatalog, collectorNumber is a required (non-nullable) column, so
// there's no empty-string-to-null normalization here.
export async function findOrCreateRiftboundCatalogEntry(
  prismaOrTx: Prisma.TransactionClient,
  fields: {
    title: string;
    setName: string;
    rarity: string;
    tcgPlayerId: string;
    cardNumber: string;
    type: string;
    supertype: string;
  }
) {
  return prismaOrTx.riftboundCardCatalog.upsert({
    where: { tcgPlayerId: fields.tcgPlayerId },
    update: {}, // an existing row wins as-is — matches the prior find-and-reuse behavior
    create: {
      riftboundId: `manual-${fields.tcgPlayerId}`,
      name: fields.title,
      setLabel: fields.setName,
      rarity: fields.rarity,
      collectorNumber: fields.cardNumber,
      type: fields.type,
      supertype: fields.supertype,
      tcgPlayerId: fields.tcgPlayerId,
      setId: fields.tcgPlayerId,
      // Required, no default, and unused anywhere in the app today (unlike
      // Listing.imageUrls, the per-copy photos) — meant for a future real
      // catalog import, same category as Pokemon's unused nameJa/illustrator.
      imageUrl: "",
    },
  });
}

// Riftbound counterpart to updatePokemonCatalogEntry above — updates the
// shared catalog row by id, visible to every other listing pointing at it.
export async function updateRiftboundCatalogEntry(
  prismaOrTx: Prisma.TransactionClient,
  catalogId: string,
  fields: {
    title: string;
    setName: string;
    rarity: string;
    tcgPlayerId: string;
    cardNumber: string;
    type: string;
    supertype: string;
  }
) {
  return prismaOrTx.riftboundCardCatalog.update({
    where: { id: catalogId },
    data: {
      name: fields.title,
      setLabel: fields.setName,
      rarity: fields.rarity,
      collectorNumber: fields.cardNumber,
      type: fields.type,
      supertype: fields.supertype,
      tcgPlayerId: fields.tcgPlayerId,
    },
  });
}
