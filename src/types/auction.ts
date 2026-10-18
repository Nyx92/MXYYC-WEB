// src/types/auction.ts

import type { CardBrowseIndexItem } from "./card";

// Lightweight, text-only projection of every active auction — fed by
// GET /api/auctions/browse-index. Structurally a CardBrowseIndexItem (so
// src/lib/marketplaceFacets.ts's computeFacets can be reused as-is for the
// set/rarity/condition/type/language facets) plus the auction-specific
// fields the auctions filter bar's own facets/sort need.
export interface AuctionBrowseIndexItem extends CardBrowseIndexItem {
  bidCount: number;
  endsAt: string; // ISO string
  hasBuyOut: boolean;
}

export interface AuctionCard {
  id: string;
  title: string;
  imageUrls: string[];
  condition: string;
  setName: string | null;
  language: string;
  cardNumber: string | null;
  rarity: string | null;
  tcgPlayerId: string;
  inAuction: boolean;
  owner: { id: string; username: string | null };
}

export interface AuctionItem {
  id:         string;
  cardId:     string;
  sellerId:   string;

  // All monetary values in dollars (converted from cents at the API layer)
  startingBid:  number;
  reservePrice: number | null;
  buyOutPrice:  number | null;
  currentBid:   number | null;

  // active | pending_seller_decision | sold | expired
  status: string;

  endsAt:                 string; // ISO string
  sellerDecisionDeadline: string | null;

  version:  number;
  bidCount: number;

  card: AuctionCard;
}
