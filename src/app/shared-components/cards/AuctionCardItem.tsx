"use client";
/**
 * AuctionCardItem — auction tile used in the /auctions browse grid.
 *
 * Mirrors CardListItem's exact layout (image left, metadata right) with the following additions:
 *   - Live countdown timer with a spinning hourglass
 *   - "Current bid" / "Starting bid" label with the active price
 *   - SB / RP / BO breakdown as small stacked label-value pairs
 *   - Bid count
 *   - Watchlist toggle (non-owners only, identical to CardListItem)
 *
 * Clicking the tile navigates to the card detail page where the buyer can place a bid.
 * There is intentionally no inline BID button — the detail page handles the full bid flow.
 */

import React, { useEffect, useRef, useState, startTransition } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  Box,
  Card,
  CardContent,
  Chip,
  IconButton,
  Typography,
} from "@mui/material";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import ConditionBadge from "./ConditionBadge";
import { getTimeLeft, pad, getLanguageChip, fmtPrice, isCardOwner } from "./tileHelpers";
import { useAuth } from "@/app/hooks/useAuth";
import { useWatchlistAnimation } from "@/app/context/WatchlistAnimationContext";
import type { AuctionItem } from "@/types/auction";

// ── Component ────────────────────────────────────────────────────────────────

interface AuctionCardItemProps {
  auction:    AuctionItem;
  // Initial watchlist state — pass watchlistedIds.has(auction.cardId) from the parent
  // if you already have that set loaded; defaults to false otherwise.
  watchlisted?: boolean;
}

// Wrapped in React.memo — same rationale as CardListItem.tsx: the
// /auctions grid re-renders on every search-box keystroke (search is local
// state alongside the grid), and this tile is rendered up to PAGE_SIZE (24)
// times per page. Unlike CardListItem, no parent passes an inline onClick
// here (the tile navigates via its own router.push), so `auction` (a stable
// array-element reference) and `watchlisted` (a primitive boolean) are
// already stable props — this memo is effective with no caller changes
// needed.
function AuctionCardItem({ auction, watchlisted: initialWatchlisted = false }: AuctionCardItemProps) {
  const router              = useRouter();
  const { userId, isLoggedIn } = useAuth();
  const { triggerFly, adjustCount } = useWatchlistAnimation();
  const bookmarkBtnRef      = useRef<HTMLButtonElement | null>(null);
  const languageChip        = getLanguageChip(auction.card.language);

  const [timeLeft,    setTimeLeft]    = useState(() => getTimeLeft(auction.endsAt));
  const [spin,        setSpin]        = useState(false);
  const [watchlisted, setWatchlisted] = useState(initialWatchlisted);

  // Sync when the parent resolves its watchlist data. `watchlisted` is also
  // toggled locally by handleWatchlistToggle below (optimistic update with
  // rollback), so it isn't a pure derived value of initialWatchlisted — but
  // adjusting it during render (React's documented pattern for "resetting
  // state when a prop changes"), guarded by comparing against the
  // initialWatchlisted value it last synced from, means this never needs a
  // synchronous pre-arm from an effect body.
  const [prevInitialWatchlisted, setPrevInitialWatchlisted] = useState(initialWatchlisted);
  if (initialWatchlisted !== prevInitialWatchlisted) {
    setPrevInitialWatchlisted(initialWatchlisted);
    setWatchlisted(initialWatchlisted);
  }

  // Live countdown — updates every second. Wrapped in startTransition so
  // this indefinitely-repeating default-priority update doesn't keep
  // preempting a pending route-change transition for as long as this card
  // stays mounted — see the same fix + rationale in HomeFeatured.tsx.
  useEffect(() => {
    const tick = () => startTransition(() => setTimeLeft(getTimeLeft(auction.endsAt)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [auction.endsAt]);

  // Briefly spin the hourglass every 2 s while the auction is live
  useEffect(() => {
    if (timeLeft.done) return;
    const id = setInterval(() => {
      startTransition(() => setSpin(true));
      setTimeout(() => startTransition(() => setSpin(false)), 600);
    }, 2000);
    return () => clearInterval(id);
  }, [timeLeft.done]);

  const isOwner = isCardOwner(userId, auction.card);

  const handleWatchlistToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isLoggedIn) {
      router.push(`/auth/login?callbackUrl=${encodeURIComponent(`/cards/${auction.cardId}`)}`);
      return;
    }
    const adding = !watchlisted;
    setWatchlisted(adding);
    let cancelFly: (() => void) | null = null;
    if (adding) {
      const rect = bookmarkBtnRef.current?.getBoundingClientRect();
      if (rect) cancelFly = triggerFly(rect, auction.card.imageUrls?.[0] || "/placeholder.png");
    } else {
      adjustCount(-1);
    }
    try {
      const res = await fetch(`/api/cards/${auction.cardId}/watchlist`, { method: "POST" });
      if (!res.ok) {
        setWatchlisted(!adding);
        if (adding) cancelFly?.();
        else adjustCount(+1);
      }
    } catch {
      setWatchlisted(!adding);
      if (adding) cancelFly?.();
      else adjustCount(+1);
    }
  };

  return (
    <Box sx={{ width: 340, flexShrink: 0 }}>
      <Card
        onClick={() => router.push(`/cards/${auction.cardId}`)}
        role="button"
        tabIndex={0}
        aria-label={auction.card.title}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            router.push(`/cards/${auction.cardId}`);
          }
        }}
        sx={{
          position:      "relative",
          width:         "100%",
          minHeight:     228,
          display:       "flex",
          flexDirection: "row",
          alignItems:    "stretch",
          boxShadow:     2,
          borderRadius:  3,
          cursor:        "pointer",
          overflow:      "hidden",
          transition:    "0.2s ease",
          "&:hover":     { boxShadow: 5, transform: "translateY(-2px)" },
          "&:focus-visible": { outline: "2px solid #0053ff", outlineOffset: 2 },
        }}
      >
        {/* ── Left: card image ──────────────────────────────────────────── */}
        <Box
          sx={{
            width:           138,
            minWidth:        138,
            backgroundColor: "#fff",
            p: 1.5,
          }}
        >
          {/* This inner box is the actual containing block for the `fill`
              image — see CardListItem.tsx for why the padding has to live
              on a separate, non-positioned ancestor. */}
          <Box sx={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
            <Image
              src={auction.card.imageUrls?.[0] || "/placeholder.png"}
              alt={auction.card.title}
              fill
              sizes="114px" // 138px box minus padding — see CardListItem.tsx
              style={{
                objectFit: "contain",
                objectPosition: "center",
                borderRadius: 8,
              }}
            />
          </Box>
        </Box>

        {/* ── Right: metadata ───────────────────────────────────────────── */}
        <CardContent
          sx={{
            flex:           1,
            display:        "flex",
            flexDirection:  "column",
            justifyContent: "space-between",
            pt:  1.75,
            pl:  0.75,
            pr:  3.5,  // space for the watchlist button
            "&:last-child": { pb: 1.75 },
          }}
        >
          <Box>
            {/* Language chip + card number */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap", mb: 0.5 }}>
              {languageChip && (
                <Chip
                  label={languageChip.label}
                  size="small"
                  sx={{ height: 24, fontWeight: 700, fontSize: "0.72rem", ...languageChip.sx }}
                />
              )}
              {auction.card.cardNumber && (
                <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600, fontSize: "0.8rem" }}>
                  {auction.card.cardNumber}
                </Typography>
              )}
            </Box>

            {/* Title */}
            <Typography
              fontWeight={700}
              sx={{
                fontSize:           { xs: "0.8rem", sm: "0.85rem", md: "0.9rem" },
                lineHeight:          1.2,
                minHeight:          "2.16rem",
                mb:                  0.5,
                display:            "-webkit-box",
                WebkitLineClamp:     2,
                WebkitBoxOrient:    "vertical",
                overflow:           "hidden",
              }}
              title={auction.card.title}
            >
              {auction.card.title}
            </Typography>

            {/* Set name */}
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", lineHeight: 1.35, mb: 1, fontSize: { xs: "0.6rem", sm: "0.65rem", md: "0.7rem" } }}
            >
              {auction.card.setName || "Unknown Set"}
            </Typography>

            <ConditionBadge condition={auction.card.condition} />

            {/* 1. Current bid — primary price.
                  Shows "No bids yet" in muted style when no bids have been placed. */}
            <Box sx={{ mt: 1 }}>
              <Typography sx={{ fontSize: "0.65rem", color: "text.secondary", lineHeight: 1 }}>
                Current bid
              </Typography>
              {auction.currentBid !== null ? (
                <Typography variant="h6" fontWeight={700} color="text.primary" sx={{ lineHeight: 1.1 }}>
                  S${fmtPrice(auction.currentBid)}
                </Typography>
              ) : (
                <Typography sx={{ fontSize: "0.78rem", color: "text.secondary", fontStyle: "italic", lineHeight: 1.2, mt: 0.3 }}>
                  No bids yet
                </Typography>
              )}
            </Box>

            {/* 2. SB / RP / BO — always all three; "—" when a price was not set by the seller. */}
            <Box sx={{ display: "flex", gap: 1.5, mt: 0.75, flexWrap: "wrap" }}>
              {([
                { label: "SB", value: auction.startingBid },
                { label: "RP", value: auction.reservePrice },
                { label: "BO", value: auction.buyOutPrice },
              ] as { label: string; value: number | null }[]).map(({ label, value }) => (
                <Box key={label}>
                  <Typography sx={{ fontSize: "0.58rem", color: "text.secondary", lineHeight: 1 }}>{label}</Typography>
                  <Typography sx={{ fontSize: "0.68rem", fontWeight: 700, lineHeight: 1.2 }}>
                    {value !== null ? `S$${fmtPrice(value)}` : "—"}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>

          {/* Timer + bid count */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.5 }}>
            <HourglassEmptyIcon
              sx={{
                fontSize:  13,
                color:     timeLeft.done ? "#6b7280" : "#f97316",
                animation: spin && !timeLeft.done ? "spin 0.6s linear" : "none",
                "@keyframes spin": { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(180deg)" } },
              }}
            />
            {/* suppressHydrationWarning: this text is computed from Date.now()
                (via getTimeLeft), so it legitimately differs by a second or
                two between the server-rendered HTML (now that /auctions is
                SSR'd) and the client's first render before the countdown
                effect below ticks it forward — a real, expected mismatch,
                not a bug, and exactly what this prop exists for. */}
            <Typography
              suppressHydrationWarning
              sx={{ fontSize: "0.7rem", fontWeight: 700, color: timeLeft.done ? "#6b7280" : "#f97316", whiteSpace: "nowrap" }}
            >
              {timeLeft.done ? "Ended" : `${timeLeft.h}h ${pad(timeLeft.m)}m ${pad(timeLeft.s)}s`}
            </Typography>
            <Typography sx={{ fontSize: "0.65rem", color: "#6b7280", whiteSpace: "nowrap" }}>
              · {auction.bidCount} {auction.bidCount === 1 ? "bid" : "bids"}
            </Typography>
          </Box>
        </CardContent>

        {/* ── Watchlist toggle — top-right corner, non-owners only ──────── */}
        {!isOwner && (
          <Box sx={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}>
            <IconButton
              ref={bookmarkBtnRef}
              size="small"
              onClick={handleWatchlistToggle}
              aria-label={watchlisted ? "Remove from watchlist" : "Add to watchlist"}
              sx={{
                backgroundColor: "rgba(255,255,255,0.90)",
                "&:hover":       { backgroundColor: "rgba(255,255,255,1)" },
                p: 0.6,
              }}
            >
              {watchlisted ? (
                <BookmarkIcon sx={{ fontSize: 17, color: "#0053ff" }} />
              ) : (
                <BookmarkBorderIcon sx={{ fontSize: 17, color: "#555" }} />
              )}
            </IconButton>
          </Box>
        )}
      </Card>
    </Box>
  );
}

export default React.memo(AuctionCardItem);
