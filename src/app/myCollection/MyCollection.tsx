"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Box,
  TextField,
  InputAdornment,
  Button,
  CircularProgress,
  Checkbox,
  Chip,
  Typography,
  Alert,
} from "@mui/material";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import SearchIcon from "@mui/icons-material/Search";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import FilterAltOffOutlinedIcon from "@mui/icons-material/FilterAltOffOutlined";
import { useRouter } from "next/navigation";
import { useFuzzySearch } from "@/app/utils/account/useFuzzySearch";
import { GameToggle } from "@/app/shared-components/filters/GameToggle";
import { SingleSelectFilter } from "@/app/shared-components/filters/SingleSelectFilter";
import { FilterBarShell } from "@/app/shared-components/filters/FilterBarShell";
import { ClearFiltersButton } from "@/app/shared-components/filters/ClearFiltersButton";
import { ToggleChip } from "@/app/shared-components/filters/ToggleChip";
import {
  CatalogFacetFilters,
  hasActiveCatalogFacetFilters,
  CLEARED_CATALOG_FACET_FILTERS,
} from "@/app/shared-components/filters/CatalogFacetFilters";
import type { MarketplaceFilterState } from "@/app/marketplace/FilterBar";
import { computeFacets } from "@/lib/marketplaceFacets";
import CardListItem from "../shared-components/cards/CardListItem";
import ErrorState from "../shared-components/ErrorState";
import EmptyState from "../shared-components/EmptyState";
import type { CardItem, MyCollectionBrowseIndexItem } from "@/types/card";
import { centsToDollars } from "@/lib/money";

// ── Animation variants ────────────────────────────────────────────────────────
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: "easeOut" } },
};
// Grid container: staggers card tiles and fades out once per settled fetch
// (gridKey bump), not on every filter/search keystroke — same rationale as
// MarketPlace.tsx's gridKey.
const gridVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
  exit: { opacity: 0, transition: { duration: 0.15 } },
};

// Hoisted so the reference is stable across renders — passing a new array
// literal here every render defeats useFuzzySearch's internal useMemo,
// rebuilding the entire Fuse index on every keystroke in the search box.
const MY_COLLECTION_SEARCH_KEYS = ["title", "condition", "setName", "rarity", "type"];
const PAGE_SIZE = 24;

// Maps the status filter's value to the server-side ?status= GET
// /api/user/cards understands (see that route + the identical per-card
// `status` field it computes). "For Collection" isn't here — it's a
// separate, always-visible toggle (see PENDING_COLLECTION_STATUS below),
// not one more option buried in this dropdown; that's what made it easy to
// miss before.
const STATUS_TO_QUERY: Record<string, string | undefined> = {
  all: undefined,
  forsale: "for_sale",
  inauction: "in_auction",
};
const STATUS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "forsale", label: "For Sale" },
  { value: "inauction", label: "In Auction" },
];
const PENDING_COLLECTION_STATUS = "pending_collection";

// Why a card can't be picked for a new pickup request — shown as a small
// neutral label in place of its checkbox while selecting (see eligibility
// notes in POST /api/collection-requests). Deliberately not a loud/red
// treatment — this isn't an error, just "not applicable right now."
const INELIGIBLE_LABEL: Record<string, string> = {
  for_sale: "For Sale",
  in_auction: "In Auction",
  pending_collection: "Already Marked",
};

const DEFAULT_FILTERS: MarketplaceFilterState = {
  game: "RIFTBOUND",
  setNames: [],
  rarities: [],
  types: [],
  languages: [],
  conditions: [],
};

async function postJson(url: string, body?: object) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const result = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}

/** One pickup-request group inside the "For Collection" view. */
function CollectionRequestGroup({
  cards,
  onVerifyPickup,
}: {
  cards: CardItem[];
  onVerifyPickup: (requestId: string) => void;
}) {
  const first = cards[0];
  const status = first.collectionRequestStatus;

  return (
    <Box sx={{ width: "100%", mb: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5, px: 0.5 }}>
        <Inventory2OutlinedIcon sx={{ fontSize: 18, color: "#6b7280" }} />
        <Typography sx={{ fontWeight: 700, fontSize: 14 }}>{first.collectionRequestRef}</Typography>
        <Chip
          size="small"
          label={status === "PACKED" ? "Ready for pickup" : "Requested"}
          sx={{
            fontWeight: 600,
            bgcolor: status === "PACKED" ? "#dcfce7" : "#fef3c7",
            color: status === "PACKED" ? "#166534" : "#92400e",
          }}
        />
        {status === "PACKED" && (
          <Button
            size="small"
            variant="contained"
            onClick={() => onVerifyPickup(first.collectionRequestId!)}
            sx={{ textTransform: "none", fontWeight: 700, borderRadius: 1.5, bgcolor: "#111827", "&:hover": { bgcolor: "#1f2937" } }}
          >
            Verify pickup
          </Button>
        )}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: "16px" }}>
        {cards.map((card) => (
          <CardListItem key={card.id} card={card} onClick={() => {}} />
        ))}
      </Box>
    </Box>
  );
}

/** Send-code / enter-code dialog for confirming an in-person pickup. */
function VerifyPickupDialog({
  requestId,
  onClose,
  onConfirmed,
}: {
  requestId: string;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [step, setStep] = useState<"idle" | "sent" | "confirmed">("idle");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/collection-requests/${requestId}/otp/request`);
      setStep("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/collection-requests/${requestId}/otp/confirm`, { code });
      setStep("confirmed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Incorrect code");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box
      role="dialog"
      sx={{
        position: "fixed", inset: 0, zIndex: 1300, display: "flex",
        alignItems: "center", justifyContent: "center", bgcolor: "rgba(0,0,0,0.5)",
      }}
      onClick={onClose}
    >
      <Box
        onClick={(e) => e.stopPropagation()}
        sx={{ bgcolor: "#fff", borderRadius: 2, p: 3, width: 360, maxWidth: "90vw" }}
      >
        <Typography sx={{ fontWeight: 700, fontSize: 18, mb: 2 }}>Verify pickup</Typography>
        {step === "confirmed" ? (
          <Alert severity="success">Pickup confirmed — enjoy your cards!</Alert>
        ) : (
          <>
            <Typography sx={{ fontSize: 13, color: "#6b7280", mb: 2 }}>
              We&apos;ll text a one-time code to your verified phone number. Enter it here to confirm
              it&apos;s really you collecting these cards.
            </Typography>
            {step === "idle" ? (
              <Button variant="outlined" disabled={busy} onClick={handleSend} sx={{ textTransform: "none" }}>
                {busy ? "Sending…" : "Send code"}
              </Button>
            ) : (
              <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
                <TextField
                  size="small"
                  variant="standard"
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  sx={{ width: 140 }}
                />
                <Button
                  size="small"
                  variant="contained"
                  disabled={busy || code.length !== 6}
                  onClick={handleConfirm}
                  sx={{ textTransform: "none", fontWeight: 700, bgcolor: "#111827" }}
                >
                  {busy ? "Verifying…" : "Verify"}
                </Button>
                <Button size="small" disabled={busy} onClick={handleSend} sx={{ textTransform: "none" }}>
                  Resend
                </Button>
              </Box>
            )}
            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          </>
        )}
        <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 2 }}>
          <Button
            onClick={() => {
              if (step === "confirmed") onConfirmed();
              onClose();
            }}
          >
            Close
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * The one action this toolbar has (as opposed to a filter) — visually a
 * solid/outlined button, not a pill chip, so it doesn't read as just
 * another filter. Swaps to Cancel + Mark-N once selecting, instead of
 * opening a second bar elsewhere on the page.
 */
function SelectionAction({
  selectMode,
  selectedCount,
  marking,
  onEnter,
  onCancel,
  onMark,
}: {
  selectMode: boolean;
  selectedCount: number;
  marking: boolean;
  onEnter: () => void;
  onCancel: () => void;
  onMark: () => void;
}) {
  if (!selectMode) {
    return (
      <Button
        variant="outlined"
        onClick={onEnter}
        sx={{
          height: 40, textTransform: "none", fontWeight: 700, borderRadius: 1.5,
          borderColor: "#c9cdd4", color: "#111827",
          "&:hover": { borderColor: "#111827", bgcolor: "#f9fafb" },
        }}
      >
        Select to Collect
      </Button>
    );
  }

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <Button
        variant="text"
        onClick={onCancel}
        sx={{ height: 40, textTransform: "none", fontWeight: 600, color: "#6b7280" }}
      >
        Cancel
      </Button>
      <Button
        variant="contained"
        disabled={selectedCount === 0 || marking}
        onClick={onMark}
        sx={{
          height: 40, textTransform: "none", fontWeight: 700, borderRadius: 1.5,
          bgcolor: "#111827", "&:hover": { bgcolor: "#1f2937" },
          "&.Mui-disabled": { bgcolor: "#e5e7eb", color: "#9ca3af" },
        }}
      >
        {marking ? "Marking…" : selectedCount > 0 ? `Mark ${selectedCount} for Collection` : "Mark for Collection"}
      </Button>
    </Box>
  );
}

export default function MyCollection() {
  const [browseIndex, setBrowseIndex] = useState<MyCollectionBrowseIndexItem[]>([]);
  const [browseIndexReady, setBrowseIndexReady] = useState(false);

  const [cards, setCards] = useState<CardItem[]>([]);
  const [gridKey, setGridKey] = useState(0);
  const [page, setPage] = useState(1);
  // Drops load-more responses from a previous filter/search (or from before
  // a refetchFirstPage) — see MarketPlace.tsx.
  const queryVersion = useRef(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchError, setFetchError] = useState(false);

  const [statusFilter, setStatusFilter] = useState("all");
  // A separate always-visible toggle, not one more option inside the status
  // dropdown — that's what made "cards waiting for pickup" easy to miss.
  const [showPendingCollection, setShowPendingCollection] = useState(false);
  const [filters, setFilters] = useState<MarketplaceFilterState>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const router = useRouter();

  // ── Mark-for-collection selection mode ──────────────────────────────────────
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [verifyRequestId, setVerifyRequestId] = useState<string | null>(null);

  // Fetch the lightweight browse-index once on mount — feeds search and
  // facet counts across the caller's whole collection regardless of which
  // page/filters are on screen, and the pending-collection count badge below.
  useEffect(() => {
    fetch("/api/user/cards/browse-index")
      .then((r) => r.json())
      .then((data) => setBrowseIndex(data.items ?? []))
      .catch(() => setBrowseIndex([]))
      .finally(() => setBrowseIndexReady(true));
  }, []);

  const facets = useMemo(() => computeFacets(browseIndex, filters.game), [browseIndex, filters.game]);
  const pendingCollectionCount = useMemo(
    () => browseIndex.filter((i) => i.status === PENDING_COLLECTION_STATUS).length,
    [browseIndex]
  );

  // fuse.js over the in-memory index — ranked by relevance, same pattern as
  // Marketplace.tsx.
  const searchMatches = useFuzzySearch({
    data: browseIndex,
    query: search,
    keys: MY_COLLECTION_SEARCH_KEYS,
  });
  const matchedIds = search ? searchMatches.map((m) => m.id) : null;
  const searchAwaitingIndex = Boolean(search) && !browseIndexReady;

  function buildQuery(pageNum: number) {
    const params = new URLSearchParams({ page: String(pageNum), pageSize: String(PAGE_SIZE) });
    const statusParam = showPendingCollection ? PENDING_COLLECTION_STATUS : STATUS_TO_QUERY[statusFilter];
    if (statusParam) params.set("status", statusParam);
    params.set("game", filters.game);
    filters.setNames.forEach((v) => params.append("setName", v));
    filters.rarities.forEach((v) => params.append("rarity", v));
    filters.types.forEach((v) => params.append("type", v));
    filters.languages.forEach((v) => params.append("language", v));
    filters.conditions.forEach((v) => params.append("condition", v));
    if (matchedIds) {
      const start = (pageNum - 1) * PAGE_SIZE;
      matchedIds.slice(start, start + PAGE_SIZE).forEach((id) => params.append("ids", id));
    }
    return params.toString();
  }

  function reorderToMatchSearch(fetchedCards: CardItem[]): CardItem[] {
    if (!matchedIds) return fetchedCards;
    const order = new Map(matchedIds.map((id, i) => [id, i]));
    return [...fetchedCards].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }

  // Refetch page 1 whenever the status/pending-collection toggle/facet
  // filters/search change — mirrors MarketPlace.tsx's identical effect; see
  // its comments for why searchAwaitingIndex is handled separately from
  // the zero-matches case.
  useEffect(() => {
    queryVersion.current++;
    if (searchAwaitingIndex) {
      // Can't tell yet whether this search has zero matches or many — see
      // MarketPlace.tsx's identical branch for the full rationale. Render
      // derives the spinner from `loading || searchAwaitingIndex` below
      // instead of syncing this into `loading` state here.
      return;
    }
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

    const controller = new AbortController();
    setLoading(true);
    setFetchError(false);
    fetch(`/api/user/cards?${buildQuery(1)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        const normalized = (data.cards ?? []).map((c: any) => ({
          ...c,
          price: c.price != null ? centsToDollars(c.price) : null,
        }));
        setCards(reorderToMatchSearch(normalized));
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
  }, [statusFilter, showPendingCollection, filters, search, searchAwaitingIndex]);

  function handleLoadMore() {
    const nextPage = page + 1;
    const version = queryVersion.current;
    setLoadingMore(true);
    fetch(`/api/user/cards?${buildQuery(nextPage)}`)
      .then((r) => r.json())
      .then((data) => {
        if (version !== queryVersion.current) return;
        const normalized = (data.cards ?? []).map((c: any) => ({
          ...c,
          price: c.price != null ? centsToDollars(c.price) : null,
        }));
        setCards((prev) => [...prev, ...reorderToMatchSearch(normalized)]);
        setHasMore(matchedIds ? matchedIds.length > nextPage * PAGE_SIZE : Boolean(data.hasMore));
        setPage(nextPage);
      })
      .finally(() => setLoadingMore(false));
  }

  // Refetches page 1 in place — used after marking cards for collection or
  // confirming a pickup, so the grid reflects the change without a full
  // page reload. Deliberately resets to page 1 (simplest correct state
  // after a mutation; re-clicking Load More recovers any later pages).
  const refetchFirstPage = useCallback(() => {
    queryVersion.current++;
    setLoading(true);
    fetch(`/api/user/cards?${buildQuery(1)}`)
      .then((r) => r.json())
      .then((data) => {
        const normalized = (data.cards ?? []).map((c: any) => ({
          ...c,
          price: c.price != null ? centsToDollars(c.price) : null,
        }));
        setCards(reorderToMatchSearch(normalized));
        setHasMore(matchedIds ? matchedIds.length > PAGE_SIZE : Boolean(data.hasMore));
        setPage(1);
      })
      .finally(() => setLoading(false));
    // Also refresh the search index (and the pending-collection count it
    // feeds) so a just-marked card's status is reflected immediately.
    fetch("/api/user/cards/browse-index")
      .then((r) => r.json())
      .then((data) => setBrowseIndex(data.items ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, showPendingCollection, filters, matchedIds]);

  // Stabilized so CardListItem's React.memo is actually effective — see the
  // identical rationale in MarketPlace.tsx's handleCardClick. Depends on
  // selectMode since the click behavior changes in select mode (navigation
  // is suppressed), but that only changes identity while actually toggling
  // select mode, not on every search/filter keystroke.
  const handleCardClick = useCallback(
    (card: CardItem) => {
      if (!selectMode) router.push(`/cards/${card.id}`);
    },
    [selectMode, router]
  );

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleMarkForCollection = async () => {
    setMarking(true);
    setMarkError(null);
    try {
      await postJson("/api/collection-requests", { listingIds: Array.from(selectedIds) });
      setSelectedIds(new Set());
      setSelectMode(false);
      refetchFirstPage();
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : "Failed to mark cards for collection");
    } finally {
      setMarking(false);
    }
  };

  // 2. Render error state if the fetch failed.
  if (fetchError) {
    return (
      <ErrorState
        variant="error"
        title="Couldn't load your collection"
        action={{ label: "Refresh page", onClick: () => window.location.reload() }}
      />
    );
  }

  const hasActiveFacetFilters = hasActiveCatalogFacetFilters(filters);

  // Cards eligible to be picked for a new pickup request — must not
  // already be for sale, in an auction, or part of another request.
  const eligibleForCollection = (c: CardItem) => c.status === "available";

  // Groups for the "For Collection" view — one header per pickup request.
  const collectionGroups = new Map<string, CardItem[]>();
  if (showPendingCollection) {
    for (const card of cards) {
      const key = card.collectionRequestRef ?? "unknown";
      collectionGroups.set(key, [...(collectionGroups.get(key) ?? []), card]);
    }
  }

  return (
    <Box>
      {/* Search — its own centered row above the filter bar, matching Marketplace. */}
      <Box sx={{ display: "flex", justifyContent: "center", mb: 2, width: "95%", mx: "auto" }}>
        <TextField
          placeholder="Search your collection..."
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
          sx={{ width: { xs: "100%", sm: 480, md: 600 }, backgroundColor: "#fff", borderRadius: 1 }}
        />
      </Box>

      <Box sx={{ width: "95%", mx: "auto" }}>
        {/* Filter bar — shares its shell/facet-filter/clear-button pieces
            with Marketplace/Auctions' filter bars (src/app/shared-components/filters/) —
            edit those, not this file, to change all three bars at once. */}
        <FilterBarShell
          trailing={
            <>
              {hasActiveFacetFilters && (
                <ClearFiltersButton onClick={() => setFilters({ ...filters, ...CLEARED_CATALOG_FACET_FILTERS })} />
              )}
              <SelectionAction
                selectMode={selectMode}
                selectedCount={selectedIds.size}
                marking={marking}
                onEnter={() => setSelectMode(true)}
                onCancel={() => { setSelectMode(false); setSelectedIds(new Set()); }}
                onMark={handleMarkForCollection}
              />
            </>
          }
        >
          <GameToggle
            value={filters.game}
            onChange={(value) => setFilters({ ...filters, game: value, ...CLEARED_CATALOG_FACET_FILTERS })}
          />
          <CatalogFacetFilters
            facets={facets}
            filters={filters}
            onChange={(patch) => setFilters({ ...filters, ...patch })}
            loading={!browseIndexReady}
          />
          <SingleSelectFilter
            icon={<FilterAltOffOutlinedIcon fontSize="inherit" />}
            label="Status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            defaultValue="all"
            onChange={(v) => { setStatusFilter(v); setShowPendingCollection(false); }}
          />

          {/* Always-visible, not nested in the Status dropdown above — a
              card waiting for pickup is easy to miss if finding it means
              opening a menu first. Highlighted amber whenever there's
              anything to collect, blue once you're actually viewing it. */}
          <ToggleChip
            icon={<Inventory2OutlinedIcon fontSize="inherit" />}
            label={`For Collection${pendingCollectionCount > 0 ? ` · ${pendingCollectionCount}` : ""}`}
            active={showPendingCollection}
            highlight={pendingCollectionCount > 0}
            onClick={() => setShowPendingCollection((v) => !v)}
          />
        </FilterBarShell>

        {markError && <Alert severity="error" sx={{ mb: 2 }}>{markError}</Alert>}

        {/* Card Grid */}
        <Box>
          {loading || searchAwaitingIndex ? (
            <Box sx={{ display: "flex", justifyContent: "center", mt: 10 }}>
              <CircularProgress />
            </Box>
          ) : (
            <Box sx={{ pb: 6 }}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={gridKey}
                  variants={gridVariants}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  style={{ display: "flex", flexWrap: "wrap", gap: "16px", justifyContent: showPendingCollection ? "flex-start" : "center" }}
                >
                  {cards.length === 0 ? (
                    <motion.div variants={cardVariants} style={{ width: "100%" }}>
                      <EmptyState
                        icon={<SearchIcon sx={{ fontSize: 40, color: "#d1d5db" }} />}
                        title="No cards match your filters."
                      />
                    </motion.div>
                  ) : showPendingCollection ? (
                    Array.from(collectionGroups.entries()).map(([ref, groupCards]) => (
                      <motion.div key={ref} variants={cardVariants} style={{ width: "100%" }}>
                        <CollectionRequestGroup cards={groupCards} onVerifyPickup={setVerifyRequestId} />
                      </motion.div>
                    ))
                  ) : (
                    cards.map((product) => {
                      const eligible = eligibleForCollection(product);
                      return (
                        <motion.div key={product.id} variants={cardVariants} style={{ position: "relative" }}>
                          {selectMode && (
                            eligible ? (
                              <Checkbox
                                checked={selectedIds.has(product.id)}
                                onChange={() => toggleSelected(product.id)}
                                sx={{
                                  position: "absolute", top: 4, left: 4, zIndex: 2,
                                  bgcolor: "rgba(255,255,255,0.9)", borderRadius: "50%",
                                  "&:hover": { bgcolor: "rgba(255,255,255,1)" },
                                }}
                              />
                            ) : (
                              <Chip
                                size="small"
                                label={INELIGIBLE_LABEL[product.status ?? ""] ?? "Unavailable"}
                                sx={{
                                  position: "absolute", top: 6, left: 6, zIndex: 2,
                                  height: 20, fontWeight: 600, fontSize: 10.5,
                                  bgcolor: "rgba(255,255,255,0.92)", color: "#6b7280",
                                  border: "1px solid #e5e7eb",
                                }}
                              />
                            )
                          )}
                          <Box sx={{ opacity: selectMode && !eligible ? 0.5 : 1, transition: "opacity 0.15s ease" }}>
                            <CardListItem
                              card={product}
                              onClick={handleCardClick}
                            />
                          </Box>
                        </motion.div>
                      );
                    })
                  )}
                </motion.div>
              </AnimatePresence>

              {hasMore && (
                <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
                  <Button
                    onClick={handleLoadMore}
                    disabled={loadingMore}
                    sx={{
                      minHeight: 44, px: 3, py: 1, fontWeight: 600, fontSize: "1.05rem",
                      letterSpacing: "0.5px", textTransform: "none", borderRadius: "999px",
                      border: "1px solid #c9cdd4", color: "#374151",
                      "&:hover": { borderColor: "#6b7280", bgcolor: "#f9fafb" },
                    }}
                  >
                    {loadingMore ? <CircularProgress size={20} /> : "Load more"}
                  </Button>
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Box>

      {verifyRequestId && (
        <VerifyPickupDialog
          requestId={verifyRequestId}
          onClose={() => setVerifyRequestId(null)}
          onConfirmed={refetchFirstPage}
        />
      )}
    </Box>
  );
}
