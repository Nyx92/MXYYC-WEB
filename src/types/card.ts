// src/types/card.ts
export interface CardItem {
  id: string;
  title: string;
  price: number | null;
  condition: string;
  status: "available" | "sold" | "reserved" | string;
  forSale: boolean;
  imageUrls: string[];
  tcgPlayerId: string;
  game: "POKEMON" | "RIFTBOUND";

  setName: string | null;
  rarity: string | null;
  description: string | null;
  language: string;
  cardNumber: string | null;
  // Riftbound-only — absent for a POKEMON card.
  type?: string;
  supertype?: string;

  // True while the card has an active (or cron-pending) auction.
  // Set by POST /api/auctions; cleared when the auction is settled or expired.
  inAuction?: boolean;

  // Optional fields populated by specific API endpoints
  watchlistCount?: number;
  watchlistedByUser?: boolean;

  // Card-detail only (see publicReservation in src/lib/listingDisplay.ts).
  // reservedUntil: another buyer is checking out until this time.
  // reservedByViewer: the viewer has an open checkout for this card.
  reservedUntil?: string | null;
  reservedByViewer?: boolean;

  // Populated by GET /api/user/cards — set while this card is earmarked
  // for in-person collection from the shop. See src/app/myCollection.
  collectionRequestId?: string | null;
  collectionRequestRef?: string | null;
  collectionRequestStatus?: "REQUESTED" | "PACKED" | "COLLECTED" | null;

  createdAt: string;
  updatedAt: string;

  owner?: {
    id: string;
    username: string | null;
    // Optional, not required: the marketplace/listings query path
    // (getListingsPage in src/lib/listingsQuery.ts) deliberately selects
    // only id/username for a public listing's owner — an anonymous
    // visitor shouldn't see another user's email. Nothing today reads
    // owner.email; keep it optional rather than widening that select
    // just to satisfy this type.
    email?: string;
  };

  // Raw ownerId scalar — present on every endpoint's response (it's just a
  // Listing column, unlike the `owner` relation object above, which some
  // routes such as GET /api/user/cards don't bother including since the
  // caller obviously already owns everything it returns). CardListItem's
  // isOwner check falls back to this so "hide the watchlist button on your
  // own card" still works on those routes too.
  ownerId?: string;
}

// Lightweight per-card fields for the marketplace's client-side search
// index and filter-facet computation — deliberately excludes
// price/images/description to keep this endpoint's payload small.
export interface CardBrowseIndexItem {
  id: string;
  title: string;
  setName: string | null;
  rarity: string | null;
  type: string | null;
  language: string;
  condition: string;
  game: "POKEMON" | "RIFTBOUND";
}

// My Collection's counterpart to CardBrowseIndexItem — same "small enough
// to fetch in full for client-side search" rationale, plus the one field
// its own filter UI needs (status) that the public marketplace index has
// no use for. See GET /api/user/cards/browse-index.
export interface MyCollectionBrowseIndexItem extends CardBrowseIndexItem {
  status: "available" | "for_sale" | "in_auction" | "pending_collection";
}
