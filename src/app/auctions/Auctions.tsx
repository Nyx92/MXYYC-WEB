"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import {
  Box,
  TextField,
  InputAdornment,
  CircularProgress,
  Button,
  Typography,
} from "@mui/material";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import SearchIcon from "@mui/icons-material/Search";
import GavelIcon from "@mui/icons-material/Gavel";
import { useFuzzySearch } from "@/app/utils/account/useFuzzySearch";
import { useWatchlistIds } from "@/app/hooks/useWatchlistIds";
import AuctionCardItem from "../shared-components/cards/AuctionCardItem";
import ErrorState from "../shared-components/ErrorState";
import type { AuctionItem } from "@/types/auction";
import type { AuctionBrowseIndexItem } from "@/types/auction";
import { computeFacets } from "@/lib/marketplaceFacets";
import AuctionFilterBar, { type AuctionFilterState } from "./AuctionFilterBar";
import { isSameAuctionsView } from "./isSameAuctionsView";

// ── Animation variants ────────────────────────────────────────────────────────
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};
const gridVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

// Hoisted for the same reason as MarketPlace.tsx's MARKETPLACE_SEARCH_KEYS —
// a new array literal every render would defeat useFuzzySearch's internal
// useMemo.
const AUCTION_SEARCH_KEYS = ["title", "setName", "rarity"];
const PAGE_SIZE = 24;
// Pokémon, not Riftbound (unlike the marketplace's default) — at time of
// writing there are zero active Riftbound auctions, so defaulting to it
// here would show every first-time visitor an empty page. Revisit once
// Riftbound auction inventory exists.
const DEFAULT_FILTERS: AuctionFilterState = {
  game: "POKEMON",
  setNames: [],
  rarities: [],
  types: [],
  languages: [],
  conditions: [],
  sort: "endingSoon",
  buyNowOnly: false,
  endingWithinHours: null,
};

interface AuctionsProps {
  initialAuctions: AuctionItem[];
  initialHasMore: boolean;
  // The exact filters page.tsx used for its server-side fetch — see
  // MarketPlace.tsx's identical prop for the full rationale.
  initialFilters?: AuctionFilterState;
}

export default function Auctions({
  initialAuctions,
  initialHasMore,
  initialFilters = DEFAULT_FILTERS,
}: AuctionsProps) {
  const watchlistedIds = useWatchlistIds();

  const [browseIndex, setBrowseIndex] = useState<AuctionBrowseIndexItem[]>([]);
  const [browseIndexReady, setBrowseIndexReady] = useState(false);
  const [filters, setFilters] = useState<AuctionFilterState>(initialFilters);
  const [search, setSearch] = useState("");
  const [auctions, setAuctions] = useState<AuctionItem[]>(initialAuctions);
  // Same settle-based key as MarketPlace.tsx's gridKey — see its comment.
  const [gridKey, setGridKey] = useState(0);
  const [page, setPage] = useState(1);
  // Drops load-more responses from a previous filter/search — see MarketPlace.tsx.
  const queryVersion = useRef(0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  // Fetch the lightweight browse-index once on mount — feeds search +
  // facets (and gates AuctionFilterBar's loading skeleton). Deliberately
  // not abort-controlled — see MarketPlace.tsx's identical effect for why
  // that was tried and reverted for this exact route shape.
  useEffect(() => {
    fetch("/api/auctions/browse-index")
      .then((r) => r.json())
      .then((data) => setBrowseIndex(data.items ?? []))
      .catch(() => setBrowseIndex([]))
      .finally(() => setBrowseIndexReady(true));
  }, []);

  const facets = useMemo(() => computeFacets(browseIndex, filters.game), [browseIndex, filters.game]);

  const searchMatches = useFuzzySearch({
    data: browseIndex,
    query: search,
    keys: AUCTION_SEARCH_KEYS,
  });
  const matchedIds = search ? searchMatches.map((m) => m.id) : null;
  const searchAwaitingIndex = Boolean(search) && !browseIndexReady;

  function buildQuery(pageNum: number) {
    const params = new URLSearchParams({
      page: String(pageNum),
      pageSize: String(PAGE_SIZE),
      sort: filters.sort,
    });
    params.set("game", filters.game);
    filters.setNames.forEach((v) => params.append("setName", v));
    filters.rarities.forEach((v) => params.append("rarity", v));
    filters.types.forEach((v) => params.append("type", v));
    filters.languages.forEach((v) => params.append("language", v));
    filters.conditions.forEach((v) => params.append("condition", v));
    if (filters.buyNowOnly) params.set("buyNowOnly", "true");
    if (filters.endingWithinHours != null) params.set("endingWithinHours", String(filters.endingWithinHours));
    if (matchedIds) {
      const start = (pageNum - 1) * PAGE_SIZE;
      matchedIds.slice(start, start + PAGE_SIZE).forEach((id) => params.append("ids", id));
    }
    return params.toString();
  }

  function reorderToMatchSearch(fetched: AuctionItem[]): AuctionItem[] {
    if (!matchedIds) return fetched;
    const order = new Map(matchedIds.map((id, i) => [id, i]));
    return [...fetched].sort((a, b) => (order.get(a.cardId) ?? 0) - (order.get(b.cardId) ?? 0));
  }

  // Refetch page 1 whenever filters or search change — mirrors
  // MarketPlace.tsx's identical effect (see its comments for the full
  // rationale on the skip-check, the AbortController, and searchAwaitingIndex).
  useEffect(() => {
    queryVersion.current++;
    if (auctions === initialAuctions && search === "" && isSameAuctionsView(filters, initialFilters)) {
      return;
    }

    if (searchAwaitingIndex) {
      // Can't tell yet whether this search has zero matches or many — see
      // MarketPlace.tsx's identical branch for the full rationale. Render
      // derives the spinner from `loading || searchAwaitingIndex` below
      // instead of syncing this into `loading` state here.
      return;
    }

    if (matchedIds && matchedIds.length === 0) {
      // Resets 4 coupled pieces of state (auctions/gridKey/hasMore/loading)
      // together; deriving them individually risks changing the grid's
      // fade-replay animation timing, which must stay identical.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAuctions([]);
      setGridKey((k) => k + 1);
      setHasMore(false);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setFetchError(false);
    fetch(`/api/auctions?${buildQuery(1)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        setAuctions(reorderToMatchSearch(data.auctions ?? []));
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
    fetch(`/api/auctions?${buildQuery(nextPage)}`)
      .then((r) => r.json())
      .then((data) => {
        if (version !== queryVersion.current) return;
        setAuctions((prev) => [...prev, ...reorderToMatchSearch(data.auctions ?? [])]);
        setHasMore(matchedIds ? matchedIds.length > nextPage * PAGE_SIZE : Boolean(data.hasMore));
        setPage(nextPage);
      })
      .catch(() => setFetchError(true))
      .finally(() => setLoadingMore(false));
  }

  if (fetchError) {
    return (
      <ErrorState
        variant="error"
        title="Couldn't load auctions"
        action={{ label: "Refresh page", onClick: () => window.location.reload() }}
        dark
      />
    );
  }

  return (
    <Box>
      <Box sx={{ display: "flex", justifyContent: "center", mb: 4, width: "95%", mx: "auto" }}>
        <TextField
          placeholder="Search auctions..."
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
        <AuctionFilterBar facets={facets} filters={filters} onChange={setFilters} loading={!browseIndexReady} />

        {loading || searchAwaitingIndex ? (
          <Box sx={{ display: "flex", justifyContent: "center", mt: 10 }}>
            <CircularProgress />
          </Box>
        ) : auctions.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4 }}
            style={{ textAlign: "center", marginTop: "80px" }}
          >
            <motion.div
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 320, damping: 14, delay: 0.1 }}
              style={{ display: "inline-block" }}
            >
              <GavelIcon sx={{ fontSize: 48, color: "rgba(255,255,255,0.4)", mb: 2 }} />
            </motion.div>
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.2 }}
            >
              <Typography variant="h6" sx={{ color: "rgba(255,255,255,0.8)" }}>
                No live auctions match your filters.
              </Typography>
              <Typography sx={{ fontSize: 13, color: "rgba(255,255,255,0.5)", mt: 0.5 }}>
                Try a different set, or check back soon — sellers list new auctions regularly.
              </Typography>
            </motion.div>
          </motion.div>
        ) : (
          <Box sx={{ pb: 6 }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={gridKey}
                variants={gridVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
                  gap: "16px",
                }}
              >
                {auctions.map((auction) => (
                  <motion.div key={auction.id} variants={cardVariants}>
                    <AuctionCardItem auction={auction} watchlisted={watchlistedIds.has(auction.cardId)} />
                  </motion.div>
                ))}
              </motion.div>
            </AnimatePresence>

            {hasMore && (
              <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
                <Button
                  variant="outlined"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  sx={{
                    color: "#fff",
                    borderColor: "rgba(255,255,255,0.4)",
                    "&:hover": { borderColor: "#fff", backgroundColor: "rgba(255,255,255,0.08)" },
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
  );
}
