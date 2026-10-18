"use client";
/**
 * Shared transaction card components and types.
 *
 * Used by: /purchases, /offers, /sold
 *
 * Exports:
 *   Types      — OrderRow, OfferRow, ReceivedOfferRow
 *   Constants  — OFFER_STATUS_LABEL
 *   Components — ConditionPill, HeaderMeta, OrderCard, PlacedOfferCard, ReceivedOfferCard
 *
 * Card API calls:
 *   ReceivedOfferCard → PATCH /api/offers/[id] { action: "accept" | "reject" }
 *     See: src/app/api/offers/[id]/route.ts
 */

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Box, Typography, Button, CircularProgress, Alert } from "@mui/material";
import { formatTimeRemaining } from "@/lib/formatTimeRemaining";

// ── Design tokens ──────────────────────────────────────────────────────────────

const PRIMARY_BLUE = "#0053ff";
const HEADER_BG    = "#f9fafb";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A completed order record as returned by GET /api/orders */
export interface OrderRow {
  id: string;
  status: string;
  amount: number;
  currency: string;
  createdAt: string;
  card: { id: string; title: string; imageUrl: string | null; condition: string };
  seller: { id: string; username: string | null };
  buyer:  { id: string; username: string | null };
}

/** An offer I placed on someone else's card — from GET /api/offers?mine=true */
export interface OfferRow {
  id: string;
  price: number | null;
  status: string;       // "pending" | "accepted" | "rejected" | "expired"
  archivedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
  card: { id: string; title: string; imageUrls: string[]; condition: string };
}

/** An offer received on one of my listings — from GET /api/offers?received=true */
export interface ReceivedOfferRow {
  id: string;
  price: number | null;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  card: { id: string; title: string; imageUrls: string[]; condition: string };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Human-readable label for each offer status.
 * Pending is overridden contextually in the card (buyer vs seller wording),
 * so the entry here is used only as a fallback.
 */
export const OFFER_STATUS_LABEL: Record<string, string> = {
  pending:  "Pending",
  accepted: "Accepted",
  // "paid" is the terminal accepted state — funds captured, card transferred.
  // Both "accepted" and "paid" render as "Accepted" to the user.
  paid:     "Accepted",
  rejected: "Declined",
  expired:  "Expired",
};

/** Background + foreground colours for each card condition grade. */
const CONDITION_META: Record<string, { bg: string; fg: string }> = {
  NM:  { bg: "rgba(16,185,129,0.12)",  fg: "#065f46" },
  LP:  { bg: "rgba(16,185,129,0.08)",  fg: "#047857" },
  MP:  { bg: "rgba(245,158,11,0.12)",  fg: "#92400e" },
  HP:  { bg: "rgba(239,68,68,0.12)",   fg: "#991b1b" },
  DMG: { bg: "rgba(107,114,128,0.12)", fg: "#374151" },
};

// ── Sub-components (internal) ──────────────────────────────────────────────────

/** Colour-coded badge showing a card's condition grade. */
export function ConditionPill({ condition }: { condition: string }) {
  const meta = CONDITION_META[condition] ?? { bg: "rgba(107,114,128,0.12)", fg: "#374151" };
  return (
    <Box sx={{ px: 1, py: 0.3, borderRadius: 1, backgroundColor: meta.bg, color: meta.fg, fontSize: 11, fontWeight: 700, display: "inline-block", letterSpacing: "0.3px" }}>
      {condition}
    </Box>
  );
}

/**
 * A labelled metadata field rendered in the card header row.
 * Renders a small uppercase label above a darker value.
 * "Order ID" uses monospace to visually distinguish the hash.
 */
export function HeaderMeta({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography sx={{ fontSize: 10, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", lineHeight: 1 }}>
        {label}
      </Typography>
      <Typography sx={{ fontSize: 13, color: "#111827", mt: 0.3, fontFamily: label === "Order ID" ? "monospace" : "inherit" }}>
        {value}
      </Typography>
    </Box>
  );
}

/** Clickable Pokémon card thumbnail — left column of every row. */
function CardThumb({ src, alt, onClick }: { src: string; alt: string; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={alt}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        width: { xs: 72, md: 100 }, height: { xs: 100, md: 140 }, borderRadius: 1.5, overflow: "hidden", backgroundColor: "#f3f4f6", position: "relative", border: "1px solid #c9cdd4", cursor: "pointer", p: "4px", flexShrink: 0,
        "&:focus-visible": { outline: "2px solid #0053ff", outlineOffset: 2 },
      }}
    >
      <Image src={src} alt={alt} fill style={{ objectFit: "contain" }} />
    </Box>
  );
}

// ── Card components ────────────────────────────────────────────────────────────

/**
 * Renders a single completed order row.
 * Used in both /purchases and /sold.
 *
 * Layout:
 *   Dark header: Order ID · Transaction date
 *   Body grid:   [image] [title + condition] [order total]
 */
export function OrderCard({ order }: { order: OrderRow }) {
  const router = useRouter();
  const dateStr = new Date(order.createdAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });

  return (
    <Box sx={{ border: "1px solid #c9cdd4", borderRadius: 2.5, overflow: "hidden", backgroundColor: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", transition: "box-shadow 0.15s", "&:hover": { boxShadow: "0 2px 8px rgba(0,0,0,0.08)" } }}>
      <Box sx={{ backgroundColor: HEADER_BG, px: 2.5, py: 1.6, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", borderBottom: "1px solid #c9cdd4" }}>
        <HeaderMeta label="Order ID" value={`#${order.id.slice(0, 8).toUpperCase()}`} />
        <HeaderMeta label="Transaction date" value={dateStr} />
      </Box>
      <Box sx={{ px: 2.5, py: 2.5, display: "grid", gridTemplateColumns: { xs: "72px 1fr auto", md: "100px 1fr auto" }, gap: 2.5, alignItems: "center" }}>
        <CardThumb src={order.card.imageUrl ?? "/placeholder.png"} alt={order.card.title} onClick={() => router.push(`/cards/${order.card.id}`)} />
        <Box sx={{ minWidth: 0 }}>
          <Typography onClick={() => router.push(`/cards/${order.card.id}`)} sx={{ fontWeight: 800, fontSize: { xs: 15, md: 17 }, cursor: "pointer", lineHeight: 1.3, mb: 1, "&:hover": { color: PRIMARY_BLUE } }}>
            {order.card.title}
          </Typography>
          <ConditionPill condition={order.card.condition} />
        </Box>
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <Typography sx={{ fontSize: 10, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", mb: 0.5 }}>Order total</Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: 17, md: 20 }, color: "#111" }}>S${order.amount.toFixed(2)}</Typography>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Renders an offer I placed on someone else's card (buyer POV).
 * Used in /offers → "Offers Placed" → Active and Expired tabs.
 *
 * Layout:
 *   Header: Status · Offer validity (pending only) · Offer date
 *   Body:   [image] [title + condition] [offer amount]
 *
 * Status label priority:
 *   archivedAt set  → "Card no longer available" (card sold to someone else via checkout)
 *   status pending  → "Awaiting seller's response"
 *   anything else   → canonical label from OFFER_STATUS_LABEL (Declined, Expired…)
 */
export function PlacedOfferCard({ offer }: { offer: OfferRow }) {
  const router = useRouter();

  // "Card no longer available" only applies when archivedAt is set AND status is
  // still "pending" — meaning the card was sold to another buyer via direct checkout
  // before the seller responded to this offer. The offer was never acted on.
  //
  // Paid/accepted offers also have archivedAt set (step 5c of the accept flow
  // archives everything on the card), but those should show "Accepted" — not this.
  const statusLabel = (offer.archivedAt && offer.status === "pending")
    ? "Card no longer available"
    : offer.status === "pending"
      ? "Awaiting seller's response"
      : (OFFER_STATUS_LABEL[offer.status] ?? offer.status);

  // Only show the countdown for live pending offers — not for archived or ended ones.
  const timeLeft = (!offer.archivedAt && offer.status === "pending")
    ? formatTimeRemaining(offer.expiresAt)
    : null;

  const dateStr = new Date(offer.createdAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });

  return (
    <Box sx={{ border: "1px solid #c9cdd4", borderRadius: 2.5, overflow: "hidden", backgroundColor: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", transition: "box-shadow 0.15s", "&:hover": { boxShadow: "0 2px 8px rgba(0,0,0,0.08)" } }}>
      <Box sx={{ backgroundColor: HEADER_BG, px: 2.5, py: 1.6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, flexWrap: "wrap", borderBottom: "1px solid #c9cdd4" }}>
        <Box sx={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <HeaderMeta label="Status" value={statusLabel} />
          {timeLeft && <HeaderMeta label="Offer validity" value={timeLeft} />}
        </Box>
        <HeaderMeta label="Offer date" value={dateStr} />
      </Box>
      <Box sx={{ px: 2.5, py: 2.5, display: "grid", gridTemplateColumns: { xs: "72px 1fr auto", md: "100px 1fr auto" }, gap: 2.5, alignItems: "center" }}>
        <CardThumb src={offer.card.imageUrls?.[0] ?? "/placeholder.png"} alt={offer.card.title} onClick={() => router.push(`/cards/${offer.card.id}`)} />
        <Box sx={{ minWidth: 0 }}>
          <Typography onClick={() => router.push(`/cards/${offer.card.id}`)} sx={{ fontWeight: 800, fontSize: { xs: 15, md: 17 }, cursor: "pointer", lineHeight: 1.3, mb: 1, "&:hover": { color: PRIMARY_BLUE } }}>
            {offer.card.title}
          </Typography>
          <ConditionPill condition={offer.card.condition} />
        </Box>
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <Typography sx={{ fontSize: 10, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", mb: 0.5 }}>Offer amount</Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: 17, md: 20 }, color: "#111" }}>
            {offer.price != null ? `S$${offer.price.toFixed(2)}` : "—"}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Renders an offer received on one of my listings (seller POV).
 * Used in /offers → "Incoming Offers" → Active and Expired tabs.
 *
 * Layout:
 *   Header: Status · Offer validity (pending only) · Received date
 *   Body:   [image] [title + condition] [offered amount + Accept/Decline (pending only)]
 *
 * Pending offers:  "Action required" status + Accept/Decline buttons
 * Ended offers:    canonical status label (Declined / Expired) + no action buttons
 *
 * onRespond(id, action):
 *   Called on successful API response. The parent uses the action to decide
 *   whether to remove the offer (accept → card is gone) or update its status
 *   in-place (reject → moves to Expired tab without requiring a page refresh).
 *   See: src/app/api/offers/[id]/route.ts for the full accept/reject flow.
 *
 * onStale():
 *   Called on a 409 — the offer changed underneath us (expired, withdrawn,
 *   already handled) so the parent should refetch its list.
 */
export function ReceivedOfferCard({
  offer,
  onRespond,
  onStale,
}: {
  offer: ReceivedOfferRow;
  onRespond: (id: string, action: "accept" | "reject") => void;
  onStale?: () => void;
}) {
  const router = useRouter();
  const [actioning, setActioning] = useState<"accept" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Determines which display mode to use — actionable vs history-only.
  const isPending = offer.status === "pending";

  // "Action required" for pending offers; canonical label for ended ones.
  const statusLabel = isPending
    ? "Action required"
    : (OFFER_STATUS_LABEL[offer.status] ?? offer.status);

  // Only show the countdown while the offer is still live.
  const timeLeft = isPending ? formatTimeRemaining(offer.expiresAt) : null;

  const dateStr = new Date(offer.createdAt).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });

  const handleAction = async (action: "accept" | "reject") => {
    setActioning(action);
    setError(null);
    try {
      const res = await fetch(`/api/offers/${offer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      // Pass the action to the parent so it can decide how to update local state:
      //   accept → remove the card entirely (card is now sold to the buyer)
      //   reject → update status in-place so the offer moves to the Expired tab
      if (res.ok) {
        onRespond(offer.id, action);
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Failed to update offer.");
      if (res.status === 409) onStale?.();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setActioning(null);
    }
  };

  return (
    <Box sx={{ border: "1px solid #c9cdd4", borderRadius: 2.5, overflow: "hidden", backgroundColor: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)", transition: "box-shadow 0.15s", "&:hover": { boxShadow: "0 2px 8px rgba(0,0,0,0.08)" } }}>
      <Box sx={{ backgroundColor: HEADER_BG, px: 2.5, py: 1.6, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, flexWrap: "wrap", borderBottom: "1px solid #c9cdd4" }}>
        <Box sx={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <HeaderMeta label="Status" value={statusLabel} />
          {timeLeft && <HeaderMeta label="Offer validity" value={timeLeft} />}
        </Box>
        <HeaderMeta label="Received on" value={dateStr} />
      </Box>
      <Box sx={{ px: 2.5, py: 2.5, display: "grid", gridTemplateColumns: { xs: "72px 1fr auto", md: "100px 1fr auto" }, gap: 2.5, alignItems: "center" }}>
        <CardThumb src={offer.card.imageUrls?.[0] ?? "/placeholder.png"} alt={offer.card.title} onClick={() => router.push(`/cards/${offer.card.id}`)} />
        <Box sx={{ minWidth: 0 }}>
          <Typography onClick={() => router.push(`/cards/${offer.card.id}`)} sx={{ fontWeight: 800, fontSize: { xs: 15, md: 17 }, cursor: "pointer", lineHeight: 1.3, mb: 1, "&:hover": { color: PRIMARY_BLUE } }}>
            {offer.card.title}
          </Typography>
          <ConditionPill condition={offer.card.condition} />
        </Box>
        <Box sx={{ textAlign: "right", flexShrink: 0 }}>
          <Typography sx={{ fontSize: 10, fontWeight: 600, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.5px", mb: 0.5 }}>Offered</Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: 17, md: 20 }, color: "#111", mb: isPending ? 1.5 : 0 }}>
            {offer.price != null ? `S$${offer.price.toFixed(2)}` : "—"}
          </Typography>
          {/* Accept / Decline buttons — only shown for pending (actionable) offers */}
          {isPending && (
            <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end" }}>
              <Button size="small" variant="contained" onClick={() => handleAction("accept")} disabled={!!actioning} sx={{ bgcolor: "#065f46", "&:hover": { bgcolor: "#047857" }, textTransform: "none", fontWeight: 700, fontSize: 12, px: 1.5, minWidth: 64 }}>
                {actioning === "accept" ? <CircularProgress size={12} sx={{ color: "#fff" }} /> : "Accept"}
              </Button>
              <Button size="small" variant="outlined" onClick={() => handleAction("reject")} disabled={!!actioning} sx={{ borderColor: "#dc2626", color: "#dc2626", "&:hover": { bgcolor: "rgba(220,38,38,0.06)", borderColor: "#dc2626" }, textTransform: "none", fontWeight: 700, fontSize: 12, px: 1.5, minWidth: 64 }}>
                {actioning === "reject" ? <CircularProgress size={12} sx={{ color: "#dc2626" }} /> : "Decline"}
              </Button>
            </Box>
          )}
        </Box>
      </Box>
      {error && <Alert severity="error" sx={{ mx: 2.5, mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
    </Box>
  );
}
