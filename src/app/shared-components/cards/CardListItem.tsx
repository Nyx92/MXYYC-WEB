"use client";
/**
 * CardListItem — horizontal card tile used in the marketplace and home featured rows.
 *
 * Renders a fixed-width card with the card image on the left and metadata on the right.
 * A watchlist toggle button sits in the top-right corner of the tile; clicking it does not
 * navigate to the card detail page (stopPropagation). Owners cannot watchlist their own cards.
 *
 * When `auctionOverride` is supplied the price section is replaced with:
 *   - "Current bid" / "Starting bid" label + bold price
 *   - Live countdown timer (spinning hourglass)
 *   - Bid count
 * This lets the homepage "Ending Soon" row reuse the exact same tile without a separate component.
 */

import React, { useState, useEffect, useRef, startTransition } from "react";
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
import GavelIcon from "@mui/icons-material/Gavel";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import ConditionBadge from "./ConditionBadge";
import { getTimeLeft, pad, getLanguageChip, isCardOwner } from "./tileHelpers";
import { useAuth } from "@/app/hooks/useAuth";
import { useWatchlistAnimation } from "@/app/context/WatchlistAnimationContext";
import type { CardItem } from "@/types/card";

interface AuctionOverride {
  currentBid:  number | null;
  startingBid: number;
  endsAt:      string;
  bidCount:    number;
}

interface CardListItemProps {
  card: CardItem;
  onClick: (card: CardItem) => void;
  // Initial watchlist state — passed by parents that already know it (e.g. card detail).
  // Defaults to false in list views where per-card watchlist status isn't pre-fetched.
  watchlisted?: boolean;
  // Called after a successful toggle — useful for pages (e.g. /watchlist) that need to
  // react when a card is removed from the watchlist.
  onWatchlistToggle?: (cardId: string, nowWatchlisted: boolean) => void;
  // When provided, replaces the price section with live auction data (bid, timer, count).
  auctionOverride?: AuctionOverride;
  // Suppresses the watchlist bookmark button entirely — for contexts where
  // watchlisting the card makes no sense (e.g. an admin viewing someone
  // else's already-sold, pending-pickup card). Defaults to false so every
  // existing usage keeps showing the button exactly as before.
  hideWatchlist?: boolean;
  // Load the image at once instead of lazily — for the first few tiles,
  // which are on screen when the page opens.
  eager?: boolean;
}

// Wrapped in React.memo — this tile is rendered up to PAGE_SIZE (24) times
// per browse/search grid (Marketplace, MyCollection, HomeFeatured rows), and
// those parents re-render on every keystroke of their search box (search is
// local state in the same component as the grid). Without memo, every
// keystroke re-renders every on-screen tile (MUI Card + Typography/Chip
// tree, sometimes framer-motion) even though the tile's own props haven't
// changed. Effective only where callers pass a referentially-stable
// `onClick` (see MarketPlace.tsx/MyCollection.tsx's useCallback-wrapped
// handlers) — an inline arrow function recreated every render still defeats
// this.
function CardListItem({
  card,
  onClick,
  watchlisted: initialWatchlisted = false,
  onWatchlistToggle,
  auctionOverride,
  hideWatchlist = false,
  eager = false,
}: CardListItemProps) {
  const { userId, isLoggedIn } = useAuth();
  const { triggerFly, adjustCount } = useWatchlistAnimation();
  const router = useRouter();
  const languageChip = getLanguageChip(card.language);
  const bookmarkBtnRef = useRef<HTMLButtonElement | null>(null);

  const [watchlisted, setWatchlisted] = useState(initialWatchlisted);

  // Sync when the parent resolves its watchlist data (e.g. after
  // useWatchlistIds loads). `watchlisted` is also toggled locally by
  // handleWatchlistToggle below (optimistic update with rollback), so it
  // isn't a pure derived value of initialWatchlisted — but adjusting it
  // during render (React's documented pattern for "resetting state when a
  // prop changes"), guarded by comparing against the initialWatchlisted
  // value it last synced from, means this never needs a synchronous
  // pre-arm from an effect body.
  const [prevInitialWatchlisted, setPrevInitialWatchlisted] = useState(initialWatchlisted);
  if (initialWatchlisted !== prevInitialWatchlisted) {
    setPrevInitialWatchlisted(initialWatchlisted);
    setWatchlisted(initialWatchlisted);
  }

  // ── Auction countdown — only active when auctionOverride is provided ─────────
  const [timeLeft, setTimeLeft] = useState(() =>
    auctionOverride ? getTimeLeft(auctionOverride.endsAt) : { h: 0, m: 0, s: 0, done: true }
  );
  const [spin, setSpin] = useState(false);

  // Wrapped in startTransition — this fires every second for as long as
  // the card is mounted (e.g. on the home page), so an ordinary setState
  // here can otherwise keep preempting a pending route-change transition
  // indefinitely. See the same fix + rationale in HomeFeatured.tsx.
  useEffect(() => {
    if (!auctionOverride) return;
    const tick = () => startTransition(() => setTimeLeft(getTimeLeft(auctionOverride.endsAt)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [auctionOverride?.endsAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!auctionOverride || timeLeft.done) return;
    const id = setInterval(() => {
      startTransition(() => setSpin(true));
      setTimeout(() => startTransition(() => setSpin(false)), 600);
    }, 2000);
    return () => clearInterval(id);
  }, [auctionOverride, timeLeft.done]);

  // Owners cannot watchlist their own cards — see isCardOwner for why both
  // the ownerId scalar and the owner relation are checked.
  const isOwner = isCardOwner(userId, card);

  const handleWatchlistToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!isLoggedIn) {
      router.push(
        `/auth/login?callbackUrl=${encodeURIComponent(`/cards/${card.id}`)}`
      );
      return;
    }

    const adding = !watchlisted;
    setWatchlisted(adding);

    // Start animation immediately; get a cancel fn in case the API fails
    let cancelFly: (() => void) | null = null;
    if (adding) {
      const rect = bookmarkBtnRef.current?.getBoundingClientRect();
      if (rect)
        cancelFly = triggerFly(rect, card.imageUrls?.[0] || "/placeholder.png");
    } else {
      adjustCount(-1);
    }

    try {
      const res = await fetch(`/api/cards/${card.id}/watchlist`, {
        method: "POST",
      });
      if (!res.ok) {
        setWatchlisted(!adding);
        if (adding) cancelFly?.();
        else adjustCount(+1);
      } else {
        onWatchlistToggle?.(card.id, adding);
      }
    } catch {
      setWatchlisted(!adding);
      if (adding) cancelFly?.();
      else adjustCount(+1);
    }
  };

  return (
    <Box sx={{ width: 288, flexShrink: 0 }}>
      <Card
        onClick={() => onClick(card)}
        role="button"
        tabIndex={0}
        aria-label={card.title}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick(card);
          }
        }}
        sx={{
          position: "relative",
          width: "100%",
          maxWidth: 288,
          minHeight: 228,
          display: "flex",
          flexDirection: "row",
          alignItems: "stretch",
          boxShadow: 2,
          borderRadius: 3,
          cursor: "pointer",
          overflow: "hidden",
          transition: "0.2s ease",
          "&:hover": {
            boxShadow: 5,
            transform: "translateY(-2px)",
          },
          "&:focus-visible": {
            outline: "2px solid #0053ff",
            outlineOffset: 2,
          },
        }}
      >
        {/* Left image */}
        <Box
          sx={{
            width: 138,
            minWidth: 138,
            maxWidth: 138,
            backgroundColor: "#fff",
            p: 1.5,
          }}
        >
          {/* This inner box is the actual containing block for the `fill`
              image. It has to be a separate element from the padded box
              above: an absolutely-positioned `inset:0` child's containing
              block is its parent's PADDING box, not its content box, so a
              `fill` image placed directly in a padded, position:relative
              box completely covers the padding instead of being inset by it. */}
          <Box sx={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
            <Image
              src={card.imageUrls?.[0] || "/placeholder.png"}
              alt={card.title}
              fill
              // The image box is 138px minus 2 × 12px padding. Matching it
              // lets a 2× screen pick the 256px variant (~18 KB) over 384px (~32 KB).
              sizes="114px"
              loading={eager ? "eager" : "lazy"}
              style={{
                objectFit: "contain",
                objectPosition: "center",
                borderRadius: 8,
              }}
            />
          </Box>
        </Box>

        {/* Right content */}
        <CardContent
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            pt: 1.75,
            pl: 0.75,
            "&:last-child": { pb: 1.75 },
          }}
        >
          <Box>
            {/* Top row: language chip + card number */}
            <Box
              sx={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 1,
                mb: 0.5,
              }}
            >
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  flexWrap: "wrap",
                }}
              >
                {languageChip && (
                  <Chip
                    label={languageChip.label}
                    size="small"
                    sx={{
                      height: 24,
                      fontWeight: 700,
                      fontSize: "0.72rem",
                      ...languageChip.sx,
                    }}
                  />
                )}
                {card.cardNumber && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      fontWeight: 600,
                      fontSize: "0.8rem",
                    }}
                  >
                    {card.cardNumber}
                  </Typography>
                )}
              </Box>
            </Box>

            {/* Title */}
            <Typography
              fontWeight={700}
              sx={{
                fontSize: { xs: "0.8rem", sm: "0.85rem", md: "0.9rem" },
                lineHeight: 1.2,
                minHeight: "2.16rem",
                mb: 0.5,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
              title={card.title}
            >
              {card.title}
            </Typography>

            {/* Set name */}
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                lineHeight: 1.35,
                mb: 1,
                fontSize: { xs: "0.6rem", sm: "0.65rem", md: "0.7rem" },
              }}
            >
              {card.setName || "Unknown Set"}
            </Typography>

            <ConditionBadge condition={card.condition} />

            {/* Price section — three mutually exclusive states:
                1. auctionOverride: live auction tile (homepage "Ending Soon" row)
                2. card.inAuction:  owner's card is currently in an auction
                3. card.forSale:    fixed-price listing
                4. default:         not listed */}
            <Box sx={{ mt: 1 }}>
              {auctionOverride ? (
                <>
                  {/* 1. Bid price */}
                  <Typography variant="h6" fontWeight={700} color="text.primary" sx={{ lineHeight: 1 }}>
                    S${(auctionOverride.currentBid ?? auctionOverride.startingBid).toFixed(2)}
                  </Typography>
                  {/* Bid count directly under the price */}
                  <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", mt: 0.5, lineHeight: 1 }}>
                    {auctionOverride.bidCount} {auctionOverride.bidCount === 1 ? "Bid" : "Bids"}
                  </Typography>
                  {/* Timer on its own row */}
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.4, mt: 1 }}>
                    <HourglassEmptyIcon
                      sx={{
                        fontSize: 15,
                        color: timeLeft.done ? "#6b7280" : "#e53935",
                        animation: spin && !timeLeft.done ? "spin 0.6s linear" : "none",
                        "@keyframes spin": { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(180deg)" } },
                      }}
                    />
                    {/* The countdown depends on the current second, so the
                        server HTML and the first browser render always
                        differ — same as AuctionCardItem.tsx. Without this,
                        React throws away the whole server-rendered home page. */}
                    <Typography
                      suppressHydrationWarning
                      sx={{ fontSize: "0.8rem", fontWeight: 700, color: timeLeft.done ? "#6b7280" : "#e53935", whiteSpace: "nowrap" }}
                    >
                      {timeLeft.done ? "Ended" : `${timeLeft.h}h ${pad(timeLeft.m)}m ${pad(timeLeft.s)}s`}
                    </Typography>
                  </Box>
                </>
              ) : card.inAuction ? (
                // 2. Card is listed in an auction — show gavel badge instead of price
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  <GavelIcon sx={{ fontSize: 14, color: "#f97316" }} />
                  <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, color: "#f97316" }}>
                    In Auction
                  </Typography>
                </Box>
              ) : card.forSale && card.price != null ? (
                // 3. Fixed-price listing
                <Typography variant="h6" fontWeight={700} color="text.primary" sx={{ lineHeight: 1 }}>
                  S${card.price.toFixed(2)}
                </Typography>
              ) : (
                // 4. Not listed
                <Typography variant="subtitle2" fontWeight={700} color="text.secondary">
                  Not for sale
                </Typography>
              )}
            </Box>
          </Box>
        </CardContent>

        {/* Watchlist toggle — top-right corner, only shown to non-owners */}
        {!isOwner && !hideWatchlist && (
          <Box sx={{ position: "absolute", top: 8, right: 8, zIndex: 1 }}>
            <IconButton
              ref={bookmarkBtnRef}
              size="small"
              onClick={handleWatchlistToggle}
              aria-label={
                watchlisted ? "Remove from watchlist" : "Add to watchlist"
              }
              sx={{
                backgroundColor: "rgba(255,255,255,0.90)",
                "&:hover": { backgroundColor: "rgba(255,255,255,1)" },
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

export default React.memo(CardListItem);
