"use client";

import { useEffect, useState, startTransition } from "react";
import { Box, Typography, Button, Divider, Alert, Tooltip } from "@mui/material";
import { useRouter } from "next/navigation";
import GavelIcon from "@mui/icons-material/Gavel";
import ShoppingCartIcon from "@mui/icons-material/ShoppingCart";
import EditIcon from "@mui/icons-material/Edit";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import {
  RAW_GRADES,
  PSA_GRADES,
  BECKETT_GRADES,
  CGC_GRADES,
  SGC_GRADES,
} from "@/constants/grades";
import { getTimeLeft, pad } from "./tileHelpers";
import type { CardItem } from "@/types/card";
import type { AuctionItem } from "@/types/auction";
import OfferCountdown from "./OfferCountdown";
import { formatPrice } from "@/lib/money";

type GradeCompany = "Raw" | "PSA" | "Beckett" | "CGC" | "SGC";
const GRADE_COMPANIES: GradeCompany[] = ["Raw", "PSA", "Beckett", "CGC", "SGC"];

function getCompany(condition: string): GradeCompany {
  if ((PSA_GRADES as readonly string[]).includes(condition)) return "PSA";
  if ((BECKETT_GRADES as readonly string[]).includes(condition))
    return "Beckett";
  if ((CGC_GRADES as readonly string[]).includes(condition)) return "CGC";
  if ((SGC_GRADES as readonly string[]).includes(condition)) return "SGC";
  return "Raw";
}

function getGradesForCompany(company: GradeCompany): string[] {
  switch (company) {
    case "PSA":
      return [...PSA_GRADES];
    case "Beckett":
      return [...BECKETT_GRADES];
    case "CGC":
      return [...CGC_GRADES];
    case "SGC":
      return [...SGC_GRADES];
    default:
      return [...RAW_GRADES];
  }
}

type ListingSummary = { id: string; condition: string; price: number | null };

export interface ActiveOffer {
  id: string;
  price: number;
  // Possible statuses after the manual-capture flow:
  //   pending  — buyer placed offer, waiting for seller response
  //   accepted — seller accepted, PI captured; card transfer in progress
  //   rejected — seller declined; PI cancelled, no charge
  //   expired  — seller didn't respond within 24h; PI cancelled by cron
  //   paid     — fully completed; card ownership transferred to buyer
  status: "pending" | "accepted" | "rejected" | "expired" | "paid" | string;
  message: string | null;
  expiresAt?: string | null; // ISO string — used for the countdown timer
}

// Tooltip text for a reserved card. Uses the clock time the hold ends (not
// a countdown) so it needs no timer and stays right while the tooltip is open.
function reservedTooltip(until: string) {
  const time = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `Another buyer is checking out this card. If they don't complete payment, it will be available again at ${time}.`;
}

interface BuyBoxProps {
  tcgPlayerId: string;
  currentCardId: string;
  currentCondition: string;
  currentPrice: number | null;

  isForSale: boolean;
  priceText: string;
  primaryBlue: string;

  onPlaceOffer: () => void;
  onBuyNow: () => void;
  // True while a Buy Now checkout request is in flight — disables the button
  // so a double click can't open two checkout sessions.
  buyNowPending?: boolean;
  // Set while another buyer is checking out this card (when their hold
  // ends) — Buy Now shows as "Reserved" until then.
  reservedUntil?: string | null;

  mode?: "viewer" | "owner";
  offersCount?: number;
  onEdit?: () => void;
  onViewListings?: () => void;

  // Viewer's own offer on this card (if any).
  // With manual-capture flow, the buyer never needs a separate "Pay Now" step —
  // funds are captured instantly when the seller accepts. So this is used only
  // to show the offer status callout (pending / rejected / expired).
  activeOffer?: ActiveOffer | null;

  // "Add to Cart" — viewer-mode only, shown when the card is for sale.
  // cartStatus reflects the last add attempt so we can show feedback text.
  onAddToCart?: () => void;
  cartStatus?: "idle" | "adding" | "added" | "already";

  // "Start Auction" — owner-mode only, shown when the card is not yet in auction.
  onStartAuction?: () => void;
  // True when a zero-bid auction just expired client-side but the cron hasn't
  // cleared card.inAuction yet (~5 min lag). Replaces "Start Auction" with an
  // info banner so the seller isn't confused by a misleading "already in auction" error.
  auctionPendingCleanup?: boolean;

  // ── Auction mode ──────────────────────────────────────────────────────────
  // When provided, the price/action section switches to auction UI while the
  // conditions section (grade pills) continues to show as normal.
  auction?: AuctionItem | null;
  // Viewer: "Place Bid" button
  onPlaceBid?: () => void;
  // Viewer: "Buy Now" button at the buy-out price (only enabled when buyOutPrice is set)
  onBuyOut?: () => void;
  // Owner: Accept or Decline the highest bid during the pending_seller_decision window
  onAuctionDecide?: (action: "accept" | "reject") => void;
  // True when the viewer is the actual seller of THIS auction. Kept separate from
  // `mode` because `mode="owner"` also covers admins managing someone else's listing
  // (canManageListing = isOwner || isAdmin) — an admin browsing another seller's
  // auction must still see the bid / buy-out buttons, not the seller's Accept/Decline
  // controls. Falls back to isOwnerMode when omitted so non-auction callers are unaffected.
  isAuctionSeller?: boolean;
}

export default function BuyBox({
  tcgPlayerId,
  currentCardId,
  currentCondition,
  currentPrice,
  isForSale,
  priceText,
  primaryBlue,
  onPlaceOffer,
  onBuyNow,
  buyNowPending = false,
  reservedUntil = null,
  mode = "viewer",
  offersCount = 0,
  onEdit,
  onViewListings,
  activeOffer = null,
  onAddToCart,
  cartStatus = "idle",
  onStartAuction,
  auctionPendingCleanup = false,
  auction = null,
  onPlaceBid,
  onBuyOut,
  onAuctionDecide,
  isAuctionSeller,
}: BuyBoxProps) {
  const router = useRouter();
  const isOwnerMode = mode === "owner";

  const [listings, setListings] = useState<ListingSummary[]>([]);
  const currentCompany = getCompany(currentCondition);
  const [selectedCompany, setSelectedCompany] =
    useState<GradeCompany>(currentCompany);

  useEffect(() => {
    if (!tcgPlayerId) return;
    fetch(
      `/api/cards?tcgPlayerId=${encodeURIComponent(tcgPlayerId)}`
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.cards) {
          setListings(
            data.cards.map((c: CardItem) => ({
              id: c.id,
              condition: c.condition,
              price: c.price,
            }))
          );
        }
      })
      .catch(console.error);
  }, [tcgPlayerId]);

  // ── Auction countdown — only active when auction prop is present ──────────
  // The timer target switches to sellerDecisionDeadline once the auction ends
  // and the seller has 24 h to accept or decline the highest bid.
  const [auctionTimeLeft, setAuctionTimeLeft] = useState(() => {
    if (!auction) return { h: 0, m: 0, s: 0, done: true };
    const target =
      auction.status === "pending_seller_decision" && auction.sellerDecisionDeadline
        ? auction.sellerDecisionDeadline
        : auction.endsAt;
    return getTimeLeft(target);
  });
  const [auctionSpin, setAuctionSpin] = useState(false);

  useEffect(() => {
    if (!auction) return;
    const target =
      auction.status === "pending_seller_decision" && auction.sellerDecisionDeadline
        ? auction.sellerDecisionDeadline
        : auction.endsAt;
    // Wrapped in startTransition — this fires every second for as long as
    // this component is mounted, so an ordinary setState here can
    // otherwise keep preempting a pending route-change transition
    // indefinitely. See the same fix + rationale in HomeFeatured.tsx.
    const tick = () => startTransition(() => setAuctionTimeLeft(getTimeLeft(target)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [auction?.endsAt, auction?.sellerDecisionDeadline, auction?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!auction || auctionTimeLeft.done) return;
    const id = setInterval(() => {
      startTransition(() => setAuctionSpin(true));
      setTimeout(() => startTransition(() => setAuctionSpin(false)), 600);
    }, 2000);
    return () => clearInterval(id);
  }, [auction, auctionTimeLeft.done]);

  // Cheapest listing per condition
  const cheapestByCondition = new Map<string, ListingSummary>();
  for (const l of listings) {
    const existing = cheapestByCondition.get(l.condition);
    if (
      !existing ||
      (l.price !== null &&
        (existing.price === null || l.price < existing.price))
    ) {
      cheapestByCondition.set(l.condition, l);
    }
  }

  // Same-condition listings excluding the current card
  const sameConditionOthers = listings.filter(
    (l) => l.condition === currentCondition && l.id !== currentCardId
  );
  const otherCount = sameConditionOthers.length;
  const lowestOther = sameConditionOthers.reduce<number | null>((min, l) => {
    if (l.price === null) return min;
    return min === null ? l.price : Math.min(min, l.price);
  }, null);

  // Is the current card the cheapest for its condition?
  const lowestForCondition = listings
    .filter((l) => l.condition === currentCondition)
    .reduce<number | null>((min, l) => {
      if (l.price === null) return min;
      return min === null ? l.price : Math.min(min, l.price);
    }, null);
  const isLowest =
    currentPrice !== null &&
    lowestForCondition !== null &&
    currentPrice <= lowestForCondition;

  // Companies that have at least one listing
  const companiesWithListings = new Set(
    listings.map((l) => getCompany(l.condition))
  );

  // Condition pill renderer (shared for raw and graded)
  const renderPill = (
    grade: string,
    listing: ListingSummary | undefined,
    isCurrent: boolean
  ) => {
    const isCurrentCard = listing?.id === currentCardId;
    const hasListing = !!listing;
    const clickable = hasListing && !isCurrentCard;

    // Strip company prefix for graded display (show just "10", "9.5 Gem Mint", etc.)
    const prefixes = ["PSA ", "Beckett ", "CGC ", "SGC "];
    const displayLabel = prefixes.reduce(
      (label, p) => (label.startsWith(p) ? label.slice(p.length) : label),
      grade
    );

    return (
      <Box
        key={grade}
        onClick={() => {
          if (clickable) router.push(`/cards/${listing!.id}`);
        }}
        sx={{
          px: 1.2,
          py: 0.7,
          borderRadius: 1.5,
          border: isCurrent ? `2px solid ${primaryBlue}` : "1px solid #e5e7eb",
          backgroundColor: isCurrent
            ? "#eff4ff"
            : hasListing
              ? "#fff"
              : "#f9fafb",
          cursor: clickable ? "pointer" : "default",
          transition: "all 0.12s",
          minWidth: selectedCompany === "Raw" ? 76 : 56,
          textAlign: "center",
          "&:hover": clickable
            ? { borderColor: primaryBlue, backgroundColor: "#f5f8ff" }
            : {},
        }}
      >
        <Typography
          sx={{
            fontSize: 11,
            fontWeight: 600,
            color: isCurrent ? primaryBlue : hasListing ? "#374151" : "#d1d5db",
            whiteSpace: "nowrap",
          }}
        >
          {displayLabel}
        </Typography>
        <Typography
          sx={{
            fontSize: 12,
            fontWeight: 700,
            mt: 0.15,
            color: isCurrent ? primaryBlue : hasListing ? "#111" : "#d1d5db",
          }}
        >
          {formatPrice(listing?.price)}
        </Typography>
      </Box>
    );
  };

  // ── Derived viewer offer state ─────────────────────────────────────────────
  const offerIsPending = activeOffer?.status === "pending";
  // "accepted" is now a very brief transient state — the PATCH endpoint captures
  // the PI and transfers the card immediately. The buyer rarely sees this; they
  // are more likely to see "paid" on next page load. We still handle it for safety.
  const offerIsAccepted = activeOffer?.status === "accepted";
  const offerIsRejected = activeOffer?.status === "rejected";
  const offerIsExpired = activeOffer?.status === "expired";

  // Left button — "See Offers (N)" for the seller, "Place Offer" for the buyer.
  // Label flips to "Amend Offer" when the buyer has a pending offer (they can
  // update the price/message, which will cancel the old PI and create a new one).
  const leftBtnLabel = isOwnerMode
    ? `See Offers (${offersCount})`
    : "Place Offer";
  const leftBtnDisabled = isOwnerMode ? false : !isForSale || offerIsAccepted; // can't amend while offer is mid-capture

  // Right button — always "Buy Now" or "Edit" (no "Pay Now" button in the
  // new flow since payment is captured automatically on seller accept).
  const isReserved = !isOwnerMode && isForSale && reservedUntil != null;
  const rightBtnLabel = isOwnerMode ? "Edit" : isReserved ? "Reserved" : "Buy Now";
  const rightBtnDisabled = isOwnerMode ? false : !isForSale || isReserved;

  // ── Auction-specific derived values ───────────────────────────────────────
  // 0. auctionSellerMode: who sees the seller-side auction controls (Accept/Decline,
  //    "bids are open" banner) vs the buyer-side ones (Place Bid / Buy Now).
  //    Defaults to isOwnerMode so this is a no-op unless the caller opts in.
  const auctionSellerMode = isAuctionSeller ?? isOwnerMode;

  // 1. biddingOpen: auction is live and the client-side timer hasn't expired.
  const biddingOpen = !!auction && auction.status === "active" && !auctionTimeLeft.done;

  // 2. pendingSystemUpdate: timer has run out and the server still shows "active"
  //    with bids. The cron will flip it to pending_seller_decision within ~5 min.
  //    We show an info box ("refresh shortly") and "AWAITING DECISION" badge.
  const pendingSystemUpdate =
    !!auction && auction.status === "active" && auctionTimeLeft.done && auction.bidCount > 0;

  // 3. inDecisionWindow: cron has processed the auction — seller can now decide.
  //    Accept/Decline buttons are gated here because the decide endpoint requires
  //    status === "pending_seller_decision".
  const inDecisionWindow = !!auction && auction.status === "pending_seller_decision";

  // 4. auctionDisplayEnded: auction is functionally over with nothing to decide.
  //    Covers: server-expired, or active + timer done + zero bids (no cron update needed).
  const auctionDisplayEnded =
    !auction ||
    auction.status === "expired" ||
    (auction.status === "active" && auctionTimeLeft.done && auction.bidCount === 0);

  // 5. Badge reflects the display state, not the raw server status.
  const auctionBadge = auctionDisplayEnded
    ? { label: "ENDED",             bg: "#f3f4f6", color: "#6b7280" }
    : pendingSystemUpdate || inDecisionWindow
    ? { label: "AWAITING DECISION", bg: "#fef9c3", color: "#92400e" }
    : { label: "ACTIVE",            bg: "#dcfce7", color: "#16a34a" };

  return (
    <Box
      sx={{
        border: "1px solid #e5e7eb",
        borderRadius: 2,
        backgroundColor: "#fff",
        overflow: "hidden",
        boxShadow: "0 2px 12px rgba(0,0,0,0.07)",
      }}
    >
      <Box sx={{ p: { xs: 1.5, sm: 2 } }}>
        {/* ── 1. CONDITION / GRADE SECTION ── */}
        {/* Unchanged in both standard and auction mode — shows all grade pills with */}
        {/* the cheapest fixed-price listing for each condition across all sellers. */}
        <Box sx={{ mb: 1.5 }}>
          <Typography
            sx={{
              fontSize: 11,
              fontWeight: 600,
              color: "#6b7280",
              mb: 1,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            Condition
          </Typography>

          {/* Company tabs — always visible */}
          <Box sx={{ display: "flex", gap: 0.8, mb: 1.2, flexWrap: "wrap" }}>
            {GRADE_COMPANIES.map((company) => {
              const hasData =
                companiesWithListings.has(company) ||
                company === currentCompany;
              const isSelected = company === selectedCompany;
              return (
                <Box
                  key={company}
                  onClick={() => setSelectedCompany(company)}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedCompany(company);
                    }
                  }}
                  sx={{
                    px: 1.2,
                    py: 0.4,
                    borderRadius: 1,
                    border: isSelected
                      ? `1.5px solid ${primaryBlue}`
                      : "1px solid #e5e7eb",
                    backgroundColor: isSelected ? "#eff4ff" : "#fff",
                    cursor: "pointer",
                    "&:hover": !isSelected ? { borderColor: "#6b7280" } : {},
                    "&:focus-visible": { outline: `2px solid ${primaryBlue}`, outlineOffset: 2 },
                  }}
                >
                  <Typography
                    sx={{
                      fontSize: 12,
                      fontWeight: isSelected ? 700 : 500,
                      color: isSelected
                        ? primaryBlue
                        : hasData
                          ? "#374151"
                          : "#6b7280",
                    }}
                  >
                    {company}
                  </Typography>
                </Box>
              );
            })}
          </Box>

          {/* Grade/condition pills for selected company */}
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.8 }}>
            {getGradesForCompany(selectedCompany).map((grade) =>
              renderPill(
                grade,
                cheapestByCondition.get(grade),
                grade === currentCondition
              )
            )}
          </Box>
          <Typography sx={{ fontSize: 11, color: "#6b7280", mt: 0.8 }}>
            Lowest listed price per condition
          </Typography>
        </Box>

        <Divider sx={{ mb: 1.5 }} />

        {/* ── 2. VIEWER OFFER STATUS CALLOUT (standard mode only) ── */}
        {/* Hidden in auction mode — offers are blocked while card is in auction. */}
        {!isOwnerMode && !auction && activeOffer && (
          <Box sx={{ mb: 1.2 }}>
            {/* Accepted: PI was captured, card transfer is in progress. */}
            {offerIsAccepted && (
              <Alert
                icon={<CheckCircleOutlineIcon fontSize="small" />}
                severity="success"
                sx={{ py: 0.5, fontSize: 12 }}
              >
                Your offer of <strong>{formatPrice(activeOffer.price)}</strong>{" "}
                was accepted and payment is being processed.
              </Alert>
            )}
            {/* Pending: waiting for seller to accept or reject */}
            {offerIsPending && (
              <Alert
                icon={<AccessTimeIcon fontSize="small" />}
                severity="info"
                sx={{ py: 0.5, fontSize: 12 }}
              >
                Your offer of <strong>{formatPrice(activeOffer.price)}</strong>{" "}
                is pending — funds are authorised and held.
                {activeOffer.expiresAt && (
                  <Box sx={{ mt: 0.4 }}>
                    <OfferCountdown expiresAt={activeOffer.expiresAt} />
                  </Box>
                )}
              </Alert>
            )}
            {/* Rejected: seller declined; PI was cancelled, no charge */}
            {offerIsRejected && (
              <Alert severity="error" sx={{ py: 0.5, fontSize: 12 }}>
                Your offer of <strong>{formatPrice(activeOffer.price)}</strong>{" "}
                was declined. No charge was made.
              </Alert>
            )}
            {/* Expired: seller didn't respond within 24h; PI was cancelled by cron */}
            {offerIsExpired && (
              <Alert severity="warning" sx={{ py: 0.5, fontSize: 12 }}>
                Your offer expired (seller didn&apos;t respond in time). No
                charge was made.
              </Alert>
            )}
          </Box>
        )}

        {/* ── 3. PRICE ROW ── */}
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            mb: 1.2,
          }}
        >
          <Box>
            {auction ? (
              <>
                {/* "Highest Bid" label + status badge */}
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                  <Typography sx={{ fontSize: 11, color: "#6b7280" }}>
                    Highest Bid
                  </Typography>
                  <Box sx={{ px: 1, py: 0.25, borderRadius: 1, backgroundColor: auctionBadge.bg }}>
                    <Typography sx={{ fontSize: 11, fontWeight: 700, color: auctionBadge.color }}>
                      {auctionBadge.label}
                    </Typography>
                  </Box>
                </Box>
                {/* Highest bid — S$0.00 when no bids have been placed */}
                <Typography
                  sx={{ fontSize: { xs: 22, sm: 26 }, fontWeight: 700, lineHeight: 1.05, color: "#111" }}
                >
                  {formatPrice(auction.currentBid ?? 0)}
                </Typography>
                {/* Bid count */}
                <Typography sx={{ fontSize: 11, color: "#6b7280", mt: 0.3 }}>
                  {auction.bidCount} {auction.bidCount === 1 ? "bid" : "bids"}
                </Typography>
              </>
            ) : (
              <>
                <Typography sx={{ fontSize: 11, color: "#6b7280" }}>
                  {isOwnerMode ? "Listed for" : "Buy Now for"}
                </Typography>
                <Typography
                  sx={{
                    fontSize: { xs: 22, sm: 26 },
                    fontWeight: 700,
                    lineHeight: 1.05,
                    color: "#111",
                    mt: 0.3,
                  }}
                >
                  {priceText}
                </Typography>
              </>
            )}
          </Box>

          {/* "Lowest price" badge — standard mode only */}
          {!auction && isLowest && !isOwnerMode && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.4,
                backgroundColor: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 1,
                px: 1,
                py: 0.4,
                mb: 0.5,
              }}
            >
              <CheckCircleOutlineIcon sx={{ fontSize: 14, color: "#16a34a" }} />
              <Typography
                sx={{ fontSize: 11, fontWeight: 600, color: "#16a34a" }}
              >
                Lowest price
              </Typography>
            </Box>
          )}
        </Box>

        {/* ── 4. ACTION BUTTONS ── */}
        {/* Auction mode renders 4.1–4.6 below; standard mode follows in the else branch. */}
        {auction ? (
          // ── Auction mode ─────────────────────────────────────────────────
          <>
            {/* 4.1. Viewer: Place Bid + Buy Now (buy-out).
                  Both buttons are disabled when biddingOpen = false — i.e. the
                  client-side timer has expired or the server status is no longer "active". */}
            {!auctionSellerMode && (
              <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, mb: 1.2 }}>
                <Button
                  fullWidth
                  variant="outlined"
                  startIcon={<GavelIcon />}
                  onClick={onPlaceBid}
                  disabled={!biddingOpen}
                  sx={{
                    textTransform: "none",
                    borderColor: "#e5e7eb",
                    color: "#111",
                    backgroundColor: "#fff",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                    "&:hover": { borderColor: "#d1d5db", backgroundColor: "#fafafa" },
                    fontWeight: 500,
                    borderRadius: 1.5,
                  }}
                >
                  Place Bid
                </Button>
                <Button
                  fullWidth
                  variant="contained"
                  startIcon={<ShoppingCartIcon />}
                  onClick={onBuyOut}
                  disabled={!biddingOpen || auction.buyOutPrice === null}
                  sx={{
                    textTransform: "none",
                    backgroundColor: "#5b7fe8",
                    "&:hover": { backgroundColor: "#0041cc" },
                    boxShadow: "0 3px 10px rgba(0,83,255,0.25)",
                    fontWeight: 500,
                    letterSpacing: "0.3px",
                    borderRadius: 1.5,
                  }}
                >
                  {auction.buyOutPrice !== null
                    ? `Buy Now ${formatPrice(auction.buyOutPrice)}`
                    : "No Buy-out"}
                </Button>
              </Box>
            )}

            {/* 4.2. Owner (decision window): Accept or Decline the highest bid.
                  Shown only when inDecisionWindow = true (status === "pending_seller_decision").
                  The decide endpoint enforces this — it rejects any other status with 409. */}
            {auctionSellerMode && inDecisionWindow && auction.currentBid !== null && (
              <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, mb: 1.2 }}>
                <Button
                  fullWidth
                  variant="contained"
                  onClick={() => onAuctionDecide?.("accept")}
                  sx={{
                    backgroundColor: "#16a34a",
                    "&:hover": { backgroundColor: "#15803d" },
                    textTransform: "none",
                    fontWeight: 700,
                    borderRadius: 1.5,
                  }}
                >
                  Accept {formatPrice(auction.currentBid)}
                </Button>
                <Button
                  fullWidth
                  variant="outlined"
                  color="error"
                  onClick={() => onAuctionDecide?.("reject")}
                  sx={{ textTransform: "none", fontWeight: 700, borderRadius: 1.5 }}
                >
                  Decline
                </Button>
              </Box>
            )}

            {/* 4.3. Owner (pre-cron window): timer expired with bids, status still "active".
                  The cron hasn't run yet (up to ~5 min lag). We can't show Accept/Decline
                  here because the decide endpoint requires pending_seller_decision. */}
            {auctionSellerMode && pendingSystemUpdate && (
              <Box sx={{ p: 1.2, backgroundColor: "#fef9c3", borderRadius: 1.5, mb: 1.2 }}>
                <Typography sx={{ fontSize: 12, color: "#92400e" }}>
                  Auction ended — results are being processed. Refresh in a moment to accept or decline.
                </Typography>
              </Box>
            )}

            {/* 4.4. Owner (auction live): informational banner while bids are still open. */}
            {auctionSellerMode && biddingOpen && (
              <Box sx={{ p: 1.2, backgroundColor: "#f0f9ff", borderRadius: 1.5, mb: 1.2 }}>
                <Typography sx={{ fontSize: 12, color: "#0369a1" }}>
                  Auction is live — bids are open.
                </Typography>
              </Box>
            )}

            {/* 4.5. SB / RP / BO — always show all three; "—" when a price is not set. */}
            <Box sx={{ display: "flex", gap: 2.5, mb: 1.2, flexWrap: "wrap" }}>
              {[
                { label: "Starting Bid",   value: auction.startingBid },
                { label: "Reserve Price",  value: auction.reservePrice },
                { label: "Buy-out",        value: auction.buyOutPrice },
              ].map(({ label, value }) => (
                <Box key={label}>
                  <Typography sx={{ fontSize: 10, color: "#6b7280", mb: 0.25 }}>{label}</Typography>
                  <Typography sx={{ fontSize: 13, fontWeight: 700 }}>
                    {formatPrice(value)}
                  </Typography>
                </Box>
              ))}
            </Box>

            {/* 4.6. Countdown timer — target switches between endsAt and sellerDecisionDeadline.
                  When done = true the label freezes at "Auction ended" in grey. */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 1.2 }}>
              <HourglassEmptyIcon
                sx={{
                  fontSize: 16,
                  color: auctionTimeLeft.done ? "#6b7280" : "#f97316",
                  animation: auctionSpin && !auctionTimeLeft.done ? "spin 0.6s linear" : "none",
                  "@keyframes spin": {
                    "0%": { transform: "rotate(0deg)" },
                    "100%": { transform: "rotate(180deg)" },
                  },
                }}
              />
              <Typography
                sx={{
                  fontSize: 14,
                  fontWeight: 700,
                  color: auctionTimeLeft.done ? "#6b7280" : "#f97316",
                }}
              >
                {auctionTimeLeft.done
                  ? "Auction ended"
                  : `${auctionTimeLeft.h}h ${pad(auctionTimeLeft.m)}m ${pad(auctionTimeLeft.s)}s`}
              </Typography>
              {!auctionTimeLeft.done && inDecisionWindow && (
                <Typography sx={{ fontSize: 11, color: "#92400e", ml: 0.5 }}>
                  (seller decision window)
                </Typography>
              )}
            </Box>
          </>
        ) : (
          // ── Standard mode ─────────────────────────────────────────────────
          <>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 1,
                mb: 1.2,
              }}
            >
              <Button
                fullWidth
                variant="outlined"
                startIcon={<GavelIcon />}
                onClick={onPlaceOffer}
                disabled={leftBtnDisabled}
                sx={{
                  textTransform: "none",
                  borderColor: "#e5e7eb",
                  color: "#111",
                  backgroundColor: "#fff",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                  "&:hover": { borderColor: "#d1d5db", backgroundColor: "#fafafa" },
                  fontWeight: 500,
                  borderRadius: 1.5,
                }}
              >
                {offerIsPending && !isOwnerMode ? "Amend Offer" : leftBtnLabel}
              </Button>

              <Tooltip
                arrow
                enterTouchDelay={0}
                // The title only renders when the tooltip opens (in the
                // browser), so the locale-formatted time can't cause a
                // server/browser hydration mismatch.
                title={isReserved ? reservedTooltip(reservedUntil!) : ""}
              >
              {/* span: a disabled button fires no events, so the tooltip needs a wrapper */}
              <span style={{ display: "block" }}>
              <Button
                fullWidth
                variant="contained"
                startIcon={isOwnerMode ? <EditIcon /> : isReserved ? <HourglassEmptyIcon /> : <ShoppingCartIcon />}
                onClick={isOwnerMode ? onEdit : onBuyNow}
                disabled={rightBtnDisabled || (!isOwnerMode && buyNowPending)}
                sx={{
                  textTransform: "none",
                  backgroundColor: "#5b7fe8",
                  "&:hover": { backgroundColor: "#0041cc" },
                  boxShadow: "0 3px 10px rgba(0,83,255,0.25)",
                  fontWeight: 500,
                  letterSpacing: "0.3px",
                  borderRadius: 1.5,
                }}
              >
                {rightBtnLabel}
              </Button>
              </span>
              </Tooltip>
            </Box>

            {/* ── START AUCTION (owner only, when card is not yet in auction) ── */}
            {/* auctionPendingCleanup = previous zero-bid auction ended but cron hasn't
                cleared inAuction yet. Show an info banner instead of the button so the
                seller isn't confused by an "already in auction" error on submit. */}
            {isOwnerMode && auctionPendingCleanup && (
              <Box sx={{ p: 1.2, backgroundColor: "#fef9c3", borderRadius: 1.5, mb: 1.2 }}>
                <Typography sx={{ fontSize: 12, color: "#92400e" }}>
                  Auction ended — results are being processed. You can start a new auction in a moment.
                </Typography>
              </Box>
            )}
            {isOwnerMode && onStartAuction && !auctionPendingCleanup && (
              <Button
                fullWidth
                variant="outlined"
                startIcon={<GavelIcon />}
                onClick={onStartAuction}
                sx={{
                  textTransform: "none",
                  borderColor: "#e5e7eb",
                  color: "#111",
                  backgroundColor: "#fff",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                  "&:hover": { borderColor: "#d1d5db", backgroundColor: "#fafafa" },
                  fontWeight: 500,
                  borderRadius: 1.5,
                  mb: 1.2,
                }}
              >
                Start Auction
              </Button>
            )}

            {/* ── ADD TO CART (viewer only, when for sale) ── */}
            {!isOwnerMode && isForSale && onAddToCart && (
              <Button
                fullWidth
                variant="outlined"
                startIcon={<ShoppingCartIcon />}
                onClick={onAddToCart}
                disabled={
                  cartStatus === "adding" ||
                  cartStatus === "added" ||
                  cartStatus === "already"
                }
                sx={{
                  textTransform: "none",
                  borderColor:
                    cartStatus === "added" || cartStatus === "already"
                      ? "#16a34a"
                      : "#e5e7eb",
                  color:
                    cartStatus === "added" || cartStatus === "already"
                      ? "#16a34a"
                      : "#111",
                  backgroundColor: "#fff",
                  boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                  "&:hover": { borderColor: "#d1d5db", backgroundColor: "#fafafa" },
                  fontWeight: 500,
                  borderRadius: 1.5,
                  mb: 1.2,
                }}
              >
                {cartStatus === "added"
                  ? "Added to cart ✓"
                  : cartStatus === "already"
                    ? "Already in cart ✓"
                    : cartStatus === "adding"
                      ? "Adding…"
                      : "Add to Cart"}
              </Button>
            )}

            {/* ── OTHER LISTINGS (same condition) — standard mode only ── */}
            {!isOwnerMode && (
              <Box
                onClick={otherCount > 0 ? onViewListings : undefined}
                sx={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 1.5,
                  px: 1.6,
                  py: 0.8,
                  textAlign: "center",
                  backgroundColor: otherCount > 0 ? "#fafafa" : "#f9fafb",
                  cursor: otherCount > 0 ? "pointer" : "default",
                  "&:hover": otherCount > 0 ? { backgroundColor: "#f3f4f6" } : {},
                }}
              >
                {otherCount > 0 ? (
                  <>
                    <Typography
                      sx={{ fontSize: 12, color: primaryBlue, fontWeight: 500 }}
                    >
                      {otherCount} other {currentCondition} listing
                      {otherCount !== 1 ? "s" : ""}
                    </Typography>
                    {lowestOther !== null && (
                      <Typography sx={{ fontSize: 11, color: "#6b7280", mt: 0.15 }}>
                        As low as {formatPrice(lowestOther)}
                      </Typography>
                    )}
                  </>
                ) : (
                  <Typography
                    sx={{ fontSize: 12, color: "#6b7280", fontWeight: 400 }}
                  >
                    Only listing for this condition
                  </Typography>
                )}
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
