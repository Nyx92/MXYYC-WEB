// src/lib/sameSet.ts
//
// Order-independent equality between two string arrays. Shared by
// src/app/auctions/isSameAuctionsView.ts and
// src/app/marketplace/isSameMarketplaceView.ts, which each compare several
// facet arrays where a Select's onChange can return selections in a
// different order than they were set.

export function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((v, i) => v === sorted[i]);
}
