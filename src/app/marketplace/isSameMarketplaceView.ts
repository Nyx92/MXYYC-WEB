// src/app/marketplace/isSameMarketplaceView.ts
//
// Structural equality between two filter states, order-independent on the
// facet arrays (a Select's onChange can return selections in a different
// order than they were set). MarketPlace.tsx uses this to decide whether
// the current view still matches the exact view the Server Component in
// page.tsx already fetched (its initial filters, derived from the URL's
// game/setName search params, defaulting to Riftbound/no-filters) — if so,
// it skips a redundant client-side fetch of data it already has.

import type { MarketplaceFilterState } from "./FilterBar";
import { sameSet } from "@/lib/sameSet";

export function isSameMarketplaceView(
  a: MarketplaceFilterState,
  b: MarketplaceFilterState
): boolean {
  return (
    a.game === b.game &&
    sameSet(a.setNames, b.setNames) &&
    sameSet(a.rarities, b.rarities) &&
    sameSet(a.types, b.types) &&
    sameSet(a.languages, b.languages) &&
    sameSet(a.conditions, b.conditions)
  );
}
