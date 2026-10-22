import type { Metadata } from "next";
import Auctions from "./Auctions";
import AuctionsPageShell from "./AuctionsPageShell";
import { getAuctionsPage } from "@/lib/auctionsQuery";
import type { AuctionFilterState } from "./AuctionFilterBar";
import type { AuctionSort } from "@/lib/auctionsQuery";

export const metadata: Metadata = {
  title: "Live Auctions",
  description:
    "Bid on rare Pokémon and Riftbound cards. Funds are only charged if your bid wins.",
  alternates: { canonical: "/auctions" },
};

// Auction data must reflect the live DB on every visit (bids/endsAt change
// constantly) — same rationale as marketplace/page.tsx's identical export.
export const dynamic = "force-dynamic";

const INITIAL_PAGE_SIZE = 24;
const VALID_SORTS: AuctionSort[] = ["endingSoon", "mostBids", "newest", "priceLow", "priceHigh"];

// Same deep-link resolution as marketplace/page.tsx (a carousel "Browse
// [Set] Cards" button can point here too) — see that file's comment for the
// full rationale.
function resolveInitialFilters(
  searchParams: Record<string, string | string[] | undefined>
): AuctionFilterState {
  const rawGame = searchParams.game;
  // Defaults to Pokémon (not Riftbound, unlike marketplace/page.tsx) — see
  // Auctions.tsx's DEFAULT_FILTERS for why. An explicit ?game=RIFTBOUND
  // deep link (e.g. a future carousel button) still works either way.
  const game = rawGame === "RIFTBOUND" ? "RIFTBOUND" : "POKEMON";

  const rawSetName = searchParams.setName;
  const setNames = rawSetName ? (Array.isArray(rawSetName) ? rawSetName : [rawSetName]) : [];

  const rawSort = searchParams.sort;
  const sort = VALID_SORTS.includes(rawSort as AuctionSort) ? (rawSort as AuctionSort) : "endingSoon";

  return {
    game,
    setNames,
    rarities: [],
    types: [],
    languages: [],
    conditions: [],
    sort,
    buyNowOnly: searchParams.buyNowOnly === "true",
    endingWithinHours: searchParams.endingWithinHours ? Number(searchParams.endingWithinHours) : null,
  };
}

export default async function AuctionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialFilters = resolveInitialFilters(await searchParams);

  const initial = await getAuctionsPage({
    game: initialFilters.game,
    setNames: initialFilters.setNames,
    sort: initialFilters.sort,
    buyNowOnly: initialFilters.buyNowOnly,
    endingWithinHours: initialFilters.endingWithinHours,
    page: 1,
    pageSize: INITIAL_PAGE_SIZE,
  });

  return (
    <AuctionsPageShell>
      <Auctions
        initialAuctions={initial.auctions}
        initialHasMore={initial.hasMore ?? false}
        initialFilters={initialFilters}
      />
    </AuctionsPageShell>
  );
}
