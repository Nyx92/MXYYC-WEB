"use client";

import { useState, useEffect, useCallback, startTransition } from "react";
import { Box, CircularProgress, Typography } from "@mui/material";
import { useRouter } from "next/navigation";
import Reveal from "@/app/shared-components/Reveal";
import CardListItem from "@/app/shared-components/cards/CardListItem";
import ErrorState from "@/app/shared-components/ErrorState";
import { useWatchlistIds } from "@/app/hooks/useWatchlistIds";
import type { CardItem } from "@/types/card";
import type { AuctionItem } from "@/types/auction";

export interface FeaturedData {
  bestSellers: CardItem[];
  highestTransacted: CardItem[];
  newlyListed: CardItem[];
  auctionsEndingSoon: AuctionItem[];
}

interface SectionRowProps {
  title: string;
  subtitle: string;
  cards: CardItem[];
  onCardClick: (card: CardItem) => void;
  watchlistedIds: Set<string>;
  // Load the first tiles' images at once — only for a row that is on screen
  // when the page opens.
  eager?: boolean;
}

// How many tiles per on-screen row load their image at once (not lazily).
const EAGER_CARDS = 4;

function SectionRow({ title, subtitle, cards, onCardClick, watchlistedIds, eager = false }: SectionRowProps) {
  return (
    <Box sx={{ mb: 3 }}>
      <Reveal y={14} duration={0.4} margin="-40px">
        <Typography
          variant="h5"
          fontWeight={700}
          sx={{ mb: 2, fontSize: { xs: "1.15rem", md: "1.35rem" }, color: "#fff" }}
        >
          {title}{" "}
          <Typography
            component="span"
            fontWeight={400}
            sx={{ fontSize: { xs: "0.85rem", md: "0.95rem" }, color: "rgba(255,255,255,0.6)" }}
          >
            {subtitle}
          </Typography>
        </Typography>
      </Reveal>

      {cards.length === 0 ? (
        <Typography sx={{ color: "rgba(255,255,255,0.6)" }}>No cards available yet.</Typography>
      ) : (
        <Box
          sx={{
            display: "flex",
            gap: 2,
            overflowX: "auto",
            pb: 1,
            "&::-webkit-scrollbar": { height: 4 },
            "&::-webkit-scrollbar-thumb": { backgroundColor: "#ccc", borderRadius: 2 },
          }}
        >
          {/* Each card staggers in; capped at 0.35 s so long rows don't
               leave the last card waiting. */}
          {cards.map((card, i) => (
            <Reveal key={card.id} sx={{ flexShrink: 0 }} y={18} duration={0.35} amount={0.1} delay={Math.min(i * 0.05, 0.35)}>
              <CardListItem
                card={card}
                watchlisted={watchlistedIds.has(card.id)}
                onClick={onCardClick}
                eager={eager && i < EAGER_CARDS}
              />
            </Reveal>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── Converts an AuctionItem into the CardItem shape CardListItem expects ──────
// Price/forSale are irrelevant here — the auctionOverride prop handles display.
function auctionToCard(auction: AuctionItem): CardItem {
  return {
    id:          auction.cardId,
    // Auctions don't carry a game field yet (out of scope here) — every
    // existing auction is a Pokemon listing.
    game:        "POKEMON",
    title:       auction.card.title,
    price:       null,
    condition:   auction.card.condition,
    status:      "available",
    forSale:     false,
    imageUrls:   auction.card.imageUrls,
    tcgPlayerId: auction.card.tcgPlayerId,
    setName:     auction.card.setName,
    rarity:      auction.card.rarity,
    description: null,
    language:    auction.card.language,
    cardNumber:  auction.card.cardNumber,
    createdAt:   "",
    updatedAt:   "",
    owner:       auction.card.owner
      ? { id: auction.card.owner.id, username: auction.card.owner.username, email: "" }
      : undefined,
  };
}

// ── Auction row — "Ending Soon" horizontal scroll ────────────────────────────
// Reuses CardListItem with auctionOverride to show bid/timer/count instead of price.
// Auctions are passed from HomeFeatured (fetched as part of /api/home/featured)
// so the row renders together with the rest of the page without a separate fetch.

function AuctionRow({ auctions, watchlistedIds, onCardClick }: { auctions: AuctionItem[]; watchlistedIds: Set<string>; onCardClick: (card: CardItem) => void }) {
  if (auctions.length === 0) return null;

  return (
    <Box sx={{ mb: 3 }}>
      <Reveal y={14} duration={0.4} margin="-40px">
        <Typography
          variant="h5"
          fontWeight={700}
          sx={{ mb: 2, fontSize: { xs: "1.15rem", md: "1.35rem" }, color: "#fff" }}
        >
          Auction.{" "}
          <Typography
            component="span"
            fontWeight={400}
            sx={{ fontSize: { xs: "0.85rem", md: "0.95rem" }, color: "rgba(255,255,255,0.6)" }}
          >
            Live auctions closing shortly.
          </Typography>
        </Typography>
      </Reveal>

      <Box
        sx={{
          display: "flex",
          gap: 2,
          overflowX: "auto",
          pb: 1,
          "&::-webkit-scrollbar": { height: 4 },
          "&::-webkit-scrollbar-thumb": { backgroundColor: "#ccc", borderRadius: 2 },
        }}
      >
        {auctions.map((auction, i) => (
          <Reveal key={auction.id} sx={{ flexShrink: 0 }} y={18} duration={0.35} amount={0.1} delay={Math.min(i * 0.05, 0.35)}>
            <CardListItem
              card={auctionToCard(auction)}
              watchlisted={watchlistedIds.has(auction.cardId)}
              onClick={onCardClick}
              eager={i < EAGER_CARDS}
              auctionOverride={{
                currentBid:  auction.currentBid,
                startingBid: auction.startingBid,
                endsAt:      auction.endsAt,
                bidCount:    auction.bidCount,
              }}
            />
          </Reveal>
        ))}
      </Box>
    </Box>
  );
}

// ── Main featured component ───────────────────────────────────────────────────

// initialData comes from the server render (src/app/page.tsx), so the cards
// and their images are in the first HTML. null means the server could not
// load it — then this falls back to fetching it in the browser.
export default function HomeFeatured({ initialData = null }: { initialData?: FeaturedData | null }) {
  const router = useRouter();
  const [data,       setData]       = useState<FeaturedData | null>(initialData);
  const [loading,    setLoading]    = useState(!initialData);
  const [fetchError, setFetchError] = useState(false);
  const watchlistedIds = useWatchlistIds();

  // 1. Fetch all featured data in one request; surface error state on failure.
  //
  // The state updates below are wrapped in startTransition so React treats
  // "swap the spinner for the loaded feed" as low priority. Next.js's App
  // Router itself queues every client-side navigation (router.push, <Link>)
  // as a transition — without this, an ordinary (default-priority) setState
  // here always wins the scheduler over a pending route change, so clicking
  // a nav link while this fetch is in flight visibly waits for it to finish
  // before the URL actually changes.
  useEffect(() => {
    if (initialData) return;
    fetch("/api/home/featured")
      .then((r) => r.json())
      .then((json) => {
        startTransition(() => {
          setData(json);
          setLoading(false);
        });
      })
      .catch(() => {
        startTransition(() => {
          setFetchError(true);
          setLoading(false);
        });
      });
  }, [initialData]);

  // Stabilized so CardListItem's React.memo is actually effective — same
  // rationale as MarketPlace.tsx's handleCardClick.
  const handleCardClick = useCallback(
    (card: CardItem) => {
      router.push(`/cards/${card.id}`);
    },
    [router]
  );

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  // 2. Render error state if the featured data fetch failed.
  if (fetchError) {
    return (
      <ErrorState
        variant="error"
        title="Couldn't load featured cards"
        action={{ label: "Refresh page", onClick: () => window.location.reload() }}
        dark
      />
    );
  }

  return (
    <Box>
      {/* Auction row sits at the very top — hidden when no auctions are ending soon */}
      <AuctionRow auctions={data?.auctionsEndingSoon ?? []} watchlistedIds={watchlistedIds} onCardClick={handleCardClick} />
      <SectionRow
        title="Best Sellers."
        subtitle="Trending products."
        cards={data?.bestSellers ?? []}
        onCardClick={handleCardClick}
        watchlistedIds={watchlistedIds}
        eager
      />
      <SectionRow
        title="Highest Transacted."
        subtitle="Popular cards."
        cards={data?.highestTransacted ?? []}
        onCardClick={handleCardClick}
        watchlistedIds={watchlistedIds}
      />
      <SectionRow
        title="Newly Listed."
        subtitle="Our newest products."
        cards={data?.newlyListed ?? []}
        onCardClick={handleCardClick}
        watchlistedIds={watchlistedIds}
      />
    </Box>
  );
}
