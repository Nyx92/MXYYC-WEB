"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Box,
  TextField,
  InputAdornment,
  CircularProgress,
  Button,
} from "@mui/material";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import SearchIcon from "@mui/icons-material/Search";
import { useFuzzySearch } from "@/app/utils/account/useFuzzySearch";
import { useAuth } from "@/app/hooks/useAuth";
import { useWatchlistIds } from "@/app/hooks/useWatchlistIds";
import CardListItem from "../shared-components/cards/CardListItem";
import ErrorState from "../shared-components/ErrorState";
import EmptyState from "../shared-components/EmptyState";
import type { CardItem, CardBrowseIndexItem } from "@/types/card";
import { computeFacets } from "@/lib/marketplaceFacets";
import FilterBar, { type MarketplaceFilterState } from "./FilterBar";
import { isSameMarketplaceView } from "./isSameMarketplaceView";

// ── Animation variants ────────────────────────────────────────────────────────
// 1. Individual card tile: fade up on enter.
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};
// 2. Grid container: staggers child cards and fades the whole grid out when
//    `search` changes (AnimatePresence key-swap triggers exit → enter cycle).
const gridVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

// Hoisted so the reference is stable across renders — passing a new array
// literal here every render defeats useFuzzySearch's internal useMemo,
// rebuilding the entire Fuse index on every keystroke in the search box.
// Scoped to the lightweight browse-index's own fields (not the full
// CardItem shape the old full-list search used).
const MARKETPLACE_SEARCH_KEYS = ["title", "setName", "rarity"];
const PAGE_SIZE = 24;
const DEFAULT_FILTERS: MarketplaceFilterState = {
  game: "RIFTBOUND",
  setNames: [],
  rarities: [],
  types: [],
  languages: [],
  conditions: [],
};

interface MarketplaceProps {
  initialCards: CardItem[];
  initialHasMore: boolean;
  // The exact filters page.tsx used for its server-side fetch (resolved
  // from the URL's game/setName search params, e.g. a carousel "Browse
  // Origins Cards" deep link) — defaults to DEFAULT_FILTERS for callers
  // that don't pass one.
  initialFilters?: MarketplaceFilterState;
}

export default function Marketplace({
  initialCards,
  initialHasMore,
  initialFilters = DEFAULT_FILTERS,
}: MarketplaceProps) {
  const { userId } = useAuth();
  const router = useRouter();
  const watchlistedIds = useWatchlistIds();

  const [browseIndex, setBrowseIndex] = useState<CardBrowseIndexItem[]>([]);
  const [browseIndexReady, setBrowseIndexReady] = useState(false);
  const [filters, setFilters] = useState<MarketplaceFilterState>(initialFilters);
  const [search, setSearch] = useState("");
  const [cards, setCards] = useState<CardItem[]>(initialCards);
  // Bumped only when a settled (non-aborted) result is actually applied to
  // `cards` below — used as the AnimatePresence key instead of raw `search`
  // so the grid's exit/enter replay happens once per resolved query, not
  // once per keystroke (see the effect below for why keying on `search`
  // directly caused overlapping, doubled-up render generations).
  const [gridKey, setGridKey] = useState(0);
  const [page, setPage] = useState(1);
  // Bumped whenever filters/search change; a load-more response tagged with
  // an older version belongs to the previous query and is dropped instead of
  // being appended to the new results.
  const queryVersion = useRef(0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  // Fetch the lightweight browse-index once on mount — feeds search + facets
  // (and gates FilterBar's loading skeleton).
  //
  // Deliberately does NOT use an AbortController to cancel this on cleanup.
  // React's dev-only Strict Mode double-invokes this effect on mount, which
  // does fire two real requests to this route — but aborting the first one
  // was tried and reverted: under this Next 16 + Turbopack dev server, a
  // client-aborted request to this exact route left the SECOND (soon to be
  // the only surviving) request hanging indefinitely at the network layer —
  // no response, no failure event, ever — which permanently stuck
  // `browseIndexReady` at false for the rest of that page load. The
  // duplicate-request cost of leaving this un-aborted is dev-only (Strict
  // Mode's double-invoke never happens in production) and harmless; the
  // stuck-forever bug the "fix" caused was much worse. Confirmed via live
  // testing (network log showed request #1 aborted correctly, request #2
  // never resolving) before reverting.
  useEffect(() => {
    fetch("/api/cards/browse-index")
      .then((r) => r.json())
      .then((data) => setBrowseIndex(data.items ?? []))
      .catch(() => setBrowseIndex([])) // degrade gracefully — search/facets just show nothing
      .finally(() => setBrowseIndexReady(true));
  }, []);

  const facets = useMemo(() => computeFacets(browseIndex, filters.game), [browseIndex, filters.game]);

  // fuse.js over the in-memory index (existing hook, unchanged) — ranked by relevance.
  const searchMatches = useFuzzySearch({
    data: browseIndex,
    query: search,
    keys: MARKETPLACE_SEARCH_KEYS,
  });
  const matchedIds = search ? searchMatches.map((m) => m.id) : null;

  // True only while a search is typed but the index hasn't loaded yet — the
  // one case where matchedIds (computed from an empty browseIndex) can't be
  // trusted. This is deliberately NOT `!browseIndexReady` on its own: that
  // would flip false->true once on every page load regardless of whether a
  // search is active, re-triggering the page-1 effect below even when
  // nothing meaningful changed — which is exactly the redundant-fetch/flash
  // bug fixed in a prior commit. Gating on `search` too means this only
  // toggles (and so only forces a re-run) in the narrow case it exists for.
  const searchAwaitingIndex = Boolean(search) && !browseIndexReady;

  function buildQuery(pageNum: number) {
    const params = new URLSearchParams({
      page: String(pageNum),
      pageSize: String(PAGE_SIZE),
    });
    params.set("game", filters.game);
    filters.setNames.forEach((v) => params.append("setName", v));
    filters.rarities.forEach((v) => params.append("rarity", v));
    filters.types.forEach((v) => params.append("type", v));
    filters.languages.forEach((v) => params.append("language", v));
    filters.conditions.forEach((v) => params.append("condition", v));
    if (matchedIds) {
      // Search-mode: paginate the client-side relevance-ranked id list
      // rather than trusting server pagination order, and only send this
      // page's ids (bounded to PAGE_SIZE) to keep the query string short.
      const start = (pageNum - 1) * PAGE_SIZE;
      matchedIds.slice(start, start + PAGE_SIZE).forEach((id) => params.append("ids", id));
    }
    return params.toString();
  }

  function reorderToMatchSearch(fetchedCards: CardItem[]): CardItem[] {
    if (!matchedIds) return fetchedCards;
    // Preserve fuse.js's relevance ranking — Prisma's `id IN (...)` does
    // not guarantee the response is ordered like the input array.
    const order = new Map(matchedIds.map((id, i) => [id, i]));
    return [...fetchedCards].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  // Refetch page 1 whenever filters or search change. Deliberately does NOT
  // depend on browseIndex directly: browseIndex only changes what gets
  // fetched when a search is active (it feeds fuse.js's match-id list via
  // matchedIds), and `search` is already in the dependency list to cover
  // that case. Without this, the browse-index request finishing shortly
  // after mount would retrigger this effect with an identical query,
  // flipping `loading` back to true and remounting (and replaying the
  // entrance animation of) the card grid right after it had just rendered.
  // searchAwaitingIndex is the one exception: it only changes when a search
  // is typed before the index has loaded, so depending on it re-runs this
  // effect in exactly that case (see its own comment above) without
  // reintroducing the redundant-fetch problem in the common no-search case.
  useEffect(() => {
    queryVersion.current++;
    // The Server Component in page.tsx already fetched exactly `initialFilters`
    // (resolved from the URL's game/setName search params — defaults to
    // Riftbound/no-filters, or a carousel deep link's specific set) before
    // this component ever mounted — skip re-fetching it while the on-screen
    // `cards` are still that exact server-provided array (referentially
    // unchanged) and the view still matches `initialFilters`. This is
    // checked by comparing data state rather than a "have I run yet" ref
    // flag: a ref flag only flips once and has no matching cleanup, so
    // React's dev-only Strict Mode double-invocation of effects on mount
    // defeats it (the first invocation quietly flips the ref and returns;
    // the second sees the ref already flipped and falls through to a real,
    // redundant fetch — flashing a loading spinner over data that was
    // already correct). Comparing `cards === initialCards` instead is
    // idempotent regardless of how many times this effect body runs, and
    // still correctly refetches if the user leaves this view and later
    // returns to it (by then `cards` has been replaced by a real fetch
    // result, so the reference no longer matches `initialCards`).
    if (cards === initialCards && search === "" && isSameMarketplaceView(filters, initialFilters)) {
      return;
    }

    if (searchAwaitingIndex) {
      // Can't tell yet whether this search has zero matches or many — the
      // index it depends on hasn't loaded. Don't fetch, and don't take the
      // zero-matches shortcut below on stale/incomplete data; wait for
      // searchAwaitingIndex to flip false, which re-runs this effect.
      // Rendering derives the spinner from `loading || searchAwaitingIndex`
      // below instead of syncing this into `loading` state here — it's
      // already computable from state we have, so there's nothing to sync.
      return;
    }

    // A search with zero matches has nothing to fetch — skip the request.
    if (matchedIds && matchedIds.length === 0) {
      // Resets 4 coupled pieces of state (cards/gridKey/hasMore/loading)
      // together; deriving them individually risks changing the grid's
      // fade-replay animation timing, which must stay identical.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCards([]);
      setGridKey((k) => k + 1);
      setHasMore(false);
      setLoading(false);
      return;
    }

    // Every keystroke re-runs this effect and fires a new fetch — without
    // cancellation, an earlier, broader-matching keystroke's request can
    // resolve AFTER a later, narrower one (ordinary network/DB jitter) and
    // its plain setCards() replace clobbers the correct, more recent result
    // with a stale one. Abort the in-flight request from the previous run
    // (or on unmount) so only the latest query's response is ever applied.
    const controller = new AbortController();
    setLoading(true);
    setFetchError(false);
    fetch(`/api/cards?${buildQuery(1)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        setCards(reorderToMatchSearch(data.cards ?? []));
        setGridKey((k) => k + 1);
        setHasMore(matchedIds ? matchedIds.length > PAGE_SIZE : Boolean(data.hasMore));
        setPage(1);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setFetchError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, search, searchAwaitingIndex]);

  function handleLoadMore() {
    const nextPage = page + 1;
    const version = queryVersion.current;
    setLoadingMore(true);
    fetch(`/api/cards?${buildQuery(nextPage)}`)
      .then((r) => r.json())
      .then((data) => {
        if (version !== queryVersion.current) return;
        setCards((prev) => [...prev, ...reorderToMatchSearch(data.cards ?? [])]);
        setHasMore(matchedIds ? matchedIds.length > nextPage * PAGE_SIZE : Boolean(data.hasMore));
        setPage(nextPage);
      })
      .finally(() => setLoadingMore(false));
  }

  const filteredProducts = cards.filter(
    (product) => !(userId && product.owner?.id === userId)
  );

  // Stabilized so CardListItem's React.memo is actually effective — an
  // inline arrow passed directly in the .map() below would be a new
  // function on every render (e.g. every search-box keystroke), defeating
  // memoization for all ~24 on-screen tiles.
  const handleCardClick = useCallback(
    (card: CardItem) => router.push(`/cards/${card.id}`),
    [router]
  );

  // 2. Render error state if the fetch failed.
  if (fetchError) {
    return (
      <ErrorState
        variant="error"
        title="Couldn't load the marketplace"
        action={{ label: "Refresh page", onClick: () => window.location.reload() }}
        dark
      />
    );
  }

  return (
    <Box>
      {/* Toolbar */}
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          mb: 4,
          width: "95%",
          mx: "auto",
        }}
      >
        <TextField
          placeholder="Search cards..."
          variant="outlined"
          size="small"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon />
              </InputAdornment>
            ),
          }}
          sx={{
            width: { xs: "100%", sm: 480, md: 600 },
            backgroundColor: "rgba(255,255,255,0.95)",
            borderRadius: 1,
          }}
        />
      </Box>

      <Box sx={{ width: "95%", mx: "auto" }}>
        <FilterBar facets={facets} filters={filters} onChange={setFilters} loading={!browseIndexReady} />

        <Box>
          {loading || searchAwaitingIndex ? (
            <Box sx={{ display: "flex", justifyContent: "center", mt: 10 }}>
              <CircularProgress />
            </Box>
          ) : (
            // pb (not mb) deliberately — a bottom margin on the last element
            // in the page's content flow can collapse past the dark
            // pageBackgroundSx container's own bottom edge, leaving a gap
            // where the plain white page background shows through instead.
            // Padding stays inside the container, so it's always covered.
            // Applied here (not just inside the "hasMore" block below) so
            // the last row of cards still gets the same breathing room
            // before the footer once there's no more Load More button to
            // provide it.
            <Box sx={{ pb: 6 }}>
              {/* 3. key={gridKey} causes AnimatePresence to unmount + remount the grid
                     once per settled query result, replaying the stagger entrance.
                     Deliberately NOT key={search}: that changes on every keystroke,
                     so an in-progress exit/enter cycle from one keystroke could still
                     be animating out when the next keystroke's grid mounted in,
                     briefly rendering both generations' tiles at once. gridKey only
                     bumps when a fetch actually resolves and cards are applied (see
                     the effect above), so at most one exit/enter cycle is ever live. */}
              <AnimatePresence mode="wait">
                <motion.div
                  key={gridKey}
                  variants={gridVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  style={{ display: "flex", flexWrap: "wrap", gap: "16px", justifyContent: "center" }}
                >
                  {filteredProducts.length > 0 ? (
                    filteredProducts.map((product) => (
                      <motion.div key={product.id} variants={cardVariants}>
                        <CardListItem
                          card={product}
                          watchlisted={watchlistedIds.has(product.id)}
                          onClick={handleCardClick}
                        />
                      </motion.div>
                    ))
                  ) : (
                    <motion.div variants={cardVariants} style={{ width: "100%" }}>
                      <EmptyState
                        icon={<SearchIcon sx={{ fontSize: 40, color: "rgba(255,255,255,0.5)" }} />}
                        title="No cards match your filters."
                        tone="light"
                      />
                    </motion.div>
                  )}
                </motion.div>
              </AnimatePresence>

              {hasMore && (
                <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
                  <Button
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    sx={{
                      // Same frosted-glass pill treatment as the
                      // Marketplace/Auctions nav tabs (frostedTabsSx in
                      // navChrome.ts) — kept inline here since that helper
                      // targets MuiTab-root, not a plain Button.
                      minHeight: 44,
                      px: 3,
                      py: 1,
                      fontWeight: 600,
                      fontSize: "1.05rem",
                      letterSpacing: "0.5px",
                      textTransform: "none",
                      borderRadius: "999px",
                      border: "1px solid rgba(255,255,255,0.28)",
                      backgroundColor: "rgba(255,255,255,0.10)",
                      backdropFilter: "blur(8px)",
                      color: "rgba(255,255,255,0.85)",
                      transition: "background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease",
                      "&:hover": {
                        backgroundColor: "rgba(255,255,255,0.18)",
                        borderColor: "rgba(255,255,255,0.45)",
                      },
                      "&.Mui-disabled": {
                        color: "rgba(255,255,255,0.5)",
                        borderColor: "rgba(255,255,255,0.15)",
                      },
                    }}
                  >
                    {loadingMore ? <CircularProgress size={20} sx={{ color: "rgba(255,255,255,0.85)" }} /> : "Load more"}
                  </Button>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
