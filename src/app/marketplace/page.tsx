import type { Metadata } from "next";
import Marketplace from "./MarketPlace";
import MarketplacePageShell from "./MarketplacePageShell";
import { getListingsPage } from "@/lib/listingsQuery";
import type { MarketplaceFilterState } from "./FilterBar";

// Falls back to localhost only when NEXT_PUBLIC_SITE_URL isn't set (local
// dev) — same convention as src/app/robots.ts and sitemap.ts.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

export const metadata: Metadata = {
  title: "Marketplace | Pokémon MVP",
  description:
    "Browse and buy Pokémon and Riftbound cards for sale on Pokémon MVP's marketplace.",
  // The ?game=/&setName= deep-link variants (used by the home page carousel's
  // "Browse [Set] Cards" buttons) are the same page pre-filtered, not
  // distinct content — point search engines at the canonical unfiltered URL.
  alternates: { canonical: `${SITE_URL}/marketplace` },
};

// Card data must reflect the live DB on every visit; do not let this route
// be statically prerendered (MarketPlace.tsx skips its own client fetch on
// the initial view, so a build-time snapshot would freeze the grid
// permanently with no runtime symptom). This route is currently dynamic
// anyway because the root layout calls getServerSession (which reads
// cookies), but that's incidental to page.tsx and could change — this
// makes the requirement explicit and independent of that layout behavior.
export const dynamic = "force-dynamic";

// Matches MarketPlace.tsx's own PAGE_SIZE — page 1 of whichever view
// resolveInitialFilters below lands on.
const INITIAL_PAGE_SIZE = 24;

// The site default is Riftbound. A carousel "Browse [Set] Cards" button
// links to e.g. /marketplace?game=RIFTBOUND&setName=Origins — resolved here
// so the Server Component fetches the CORRECT already-filtered page 1
// (rather than always fetching the unfiltered default and letting the
// client fetch the real one after mount, which would flash wrong-then-right
// content). Any unrecognized/missing game falls back to the site default.
function resolveInitialFilters(
  searchParams: Record<string, string | string[] | undefined>
): MarketplaceFilterState {
  const rawGame = searchParams.game;
  const game = rawGame === "POKEMON" ? "POKEMON" : "RIFTBOUND";

  const rawSetName = searchParams.setName;
  const setNames = rawSetName
    ? Array.isArray(rawSetName)
      ? rawSetName
      : [rawSetName]
    : [];

  return { game, setNames, rarities: [], types: [], languages: [], conditions: [] };
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialFilters = resolveInitialFilters(await searchParams);

  const initial = await getListingsPage({
    game: initialFilters.game,
    setNames: initialFilters.setNames,
    page: 1,
    pageSize: INITIAL_PAGE_SIZE,
  });

  return (
    <MarketplacePageShell>
      <Marketplace
        initialCards={initial.cards}
        initialHasMore={initial.hasMore ?? false}
        initialFilters={initialFilters}
      />
    </MarketplacePageShell>
  );
}
