// src/lib/collectionRequests.ts
//
// Shared helpers for the in-person collection workflow, used by every
// route under src/app/api/collection-requests/**.

import type { Prisma } from "@prisma/client";

// A request is still "open" (can accept more items, isn't finished yet)
// until it reaches COLLECTED.
export const OPEN_COLLECTION_STATUSES = ["REQUESTED", "PACKED"] as const;

// Human-readable reference shown to the customer and in the Discord
// staff alert, e.g. "PU-2609-A1B2" — easier to say/write than a cuid.
// requestRef is @unique in the schema; a same-month collision (1 in ~1.68M
// per pair, given the 4-char base36 suffix) isn't retried and would surface
// as a generic 500 from POST /api/collection-requests. Accepted odds for a
// small shop's request volume — revisit if that ever stops being true.
export function generateCollectionRef(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PU-${yy}${mm}-${rand}`;
}

/**
 * The Prisma WHERE fragment for "this listing is free to be locked or change
 * hands": not in an auction, not earmarked for pickup, and not held by a live
 * Buy Now reservation. The single source for every conditional write that
 * moves a card into an exclusive state (auction create, offer accept, owner
 * re-list) — checked under the row lock, so the read-then-write races
 * between those flows can't both win. Add any new lock here.
 */
export function listingLockableWhere(now: Date = new Date()): Prisma.ListingWhereInput {
  return {
    inAuction: false,
    collectionRequestId: null,
    OR: [{ reservedUntil: null }, { reservedUntil: { lt: now } }],
  };
}

/**
 * Whether a listing can be marked for in-person collection right now.
 * Mirrors the same mutual-exclusion guards already enforced for
 * forSale/inAuction elsewhere (POST /api/auctions, PUT /api/cards/[id]) —
 * a card can be for sale, in an auction, or earmarked for pickup, never
 * more than one at once. Pending-offer status isn't checked here since it
 * requires a DB query the caller already has to batch across listings;
 * see POST /api/collection-requests for that check.
 *
 * Returns an error message, or null if eligible.
 */
export function listingCollectionIneligibilityReason(listing: {
  forSale: boolean;
  inAuction: boolean;
  collectionRequestId: string | null;
  collectedAt: Date | null;
}): string | null {
  if (listing.collectedAt) return "has already been collected";
  if (listing.collectionRequestId) return "is already part of a pickup request";
  if (listing.forSale) return "is currently listed for sale";
  if (listing.inAuction) return "is currently in an active auction";
  return null;
}
