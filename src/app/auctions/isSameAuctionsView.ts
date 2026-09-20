// src/app/auctions/isSameAuctionsView.ts
//
// Structural equality between two auction filter states, order-independent
// on the facet arrays — mirrors src/app/marketplace/isSameMarketplaceView.ts.
// Auctions.tsx uses this to decide whether the current view still matches
// the exact view the Server Component in page.tsx already fetched, so it
// can skip a redundant client-side fetch of data it already has.

import type { AuctionFilterState } from "./AuctionFilterBar";
import { sameSet } from "@/lib/sameSet";

export function isSameAuctionsView(a: AuctionFilterState, b: AuctionFilterState): boolean {
  return (
    a.game === b.game &&
    a.sort === b.sort &&
    a.buyNowOnly === b.buyNowOnly &&
    a.endingWithinHours === b.endingWithinHours &&
    sameSet(a.setNames, b.setNames) &&
    sameSet(a.rarities, b.rarities) &&
    sameSet(a.types, b.types) &&
    sameSet(a.languages, b.languages) &&
    sameSet(a.conditions, b.conditions)
  );
}
