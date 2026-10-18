"use client";
/**
 * /offers — the current user's offer activity, split into two views:
 *
 *   "Offers Placed"   — offers I made on other sellers' cards
 *                       Data: GET /api/offers?mine=true
 *   "Incoming Offers" — offers other buyers made on my listings
 *                       Data: GET /api/offers?received=true
 *
 * Within each view, offers are split into two tabs:
 *   "Active"  — pending offers (still waiting for a response)
 *   "Expired" — ended offers (rejected, expired, or card sold to someone else)
 *
 * Both fetches run in parallel on mount.
 * Switching views resets the active tab.
 *
 * Auth:   client-side via useAuth; redirects to /auth/login if unauthenticated.
 * Layout: AccountLayout (sidebar + content panel)
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Box, Typography, Button, CircularProgress,
} from "@mui/material";
import GavelIcon from "@mui/icons-material/Gavel";

import { useAuth } from "@/app/hooks/useAuth";
import AccountLayout from "@/app/shared-components/AccountLayout";
import AccountLoadingGate from "@/app/shared-components/AccountLoadingGate";
import ErrorState from "@/app/shared-components/ErrorState";
import EmptyState from "@/app/shared-components/EmptyState";
import {
  PlacedOfferCard, ReceivedOfferCard,
  type OfferRow, type ReceivedOfferRow,
} from "@/app/shared-components/transaction-cards";
import { motion, AnimatePresence } from "framer-motion";

// ── Internal sub-components ───────────────────────────────────────────────────

/**
 * A tab button styled with a bottom underline when active — like a browser tab.
 */
function TabButton({
  label, active, onClick,
}: {
  label: string; active: boolean; onClick: () => void;
}) {
  return (
    <Box
      component="button"
      onClick={onClick}
      sx={{
        background: "none", border: "none", cursor: "pointer",
        pb: 1.5, px: 0.5, mr: 3,
        borderBottom: active ? "2px solid #111827" : "2px solid transparent",
        color: active ? "#111827" : "#6b7280",
        fontWeight: active ? 700 : 500,
        fontSize: 14,
        transition: "color 0.15s",
        "&:hover": { color: "#111827" },
      }}
    >
      {label}
    </Box>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function OffersPage() {
  const { isLoggedIn, status } = useAuth();
  const router = useRouter();

  // ── Auth guard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "loading" && !isLoggedIn) router.replace("/auth/login");
  }, [status, isLoggedIn, router]);

  // ── State ────────────────────────────────────────────────────────────────────
  const [placedOffers, setPlacedOffers]     = useState<OfferRow[]>([]);
  const [receivedOffers, setReceivedOffers] = useState<ReceivedOfferRow[]>([]);
  const [error, setError]                   = useState<string | null>(null);
  // Tracks the isLoggedIn value that the offer lists currently reflect.
  // `loading` is derived by comparing it against the live isLoggedIn value
  // instead of a separately re-armed boolean, so the fetch effect below
  // never needs to call setState synchronously as its first statement
  // (react-hooks/set-state-in-effect flags that shape).
  const [loadedFor, setLoadedFor] = useState<boolean | null>(null);
  const loading = isLoggedIn && loadedFor !== isLoggedIn;

  // Top-level view: which side of the marketplace the user is looking at
  const [offerView, setOfferView] = useState<"placed" | "received">("placed");
  // Secondary tab: lifecycle stage — Active → Accepted → Declined → Expired
  const [offerTab, setOfferTab]   = useState<"active" | "accepted" | "declined" | "expired">("active");

  // ── Fetch (parallel) ─────────────────────────────────────────────────────────
  // Both endpoints called simultaneously to avoid sequential loading waterfalls.
  useEffect(() => {
    if (!isLoggedIn) return;
    Promise.all([
      fetch("/api/offers?mine=true").then((r) => r.json()),
      fetch("/api/offers?received=true").then((r) => r.json()),
    ])
      .then(([placed, received]) => {
        if (placed.offers)   setPlacedOffers(placed.offers);
        else                 setError(placed.error);
        if (received.offers) setReceivedOffers(received.offers);
      })
      .catch(() => setError("Failed to load offers."))
      .finally(() => setLoadedFor(isLoggedIn));
  }, [isLoggedIn]);

  // ── View switch ───────────────────────────────────────────────────────────────
  // Reset tab to Active so the user always lands on the actionable view first.
  const handleViewChange = (view: "placed" | "received") => {
    setOfferView(view);
    setOfferTab("active");
  };

  // ── Split placed offers into 4 lifecycle buckets ─────────────────────────────
  // Active:   pending and not archived (seller hasn't responded yet)
  // Accepted: paid/accepted — seller said yes and the card was transferred
  // Declined: seller explicitly rejected the offer
  // Expired:  offer timed out (cron set status "expired") OR card was sold to
  //           someone else via direct checkout before the seller responded
  //           (archivedAt set, status still "pending")
  const placedActive   = useMemo(() => placedOffers.filter((o) => o.status === "pending" && !o.archivedAt),            [placedOffers]);
  const placedAccepted = useMemo(() => placedOffers.filter((o) => o.status === "paid" || o.status === "accepted"),     [placedOffers]);
  const placedDeclined = useMemo(() => placedOffers.filter((o) => o.status === "rejected"),                            [placedOffers]);
  const placedExpired  = useMemo(() => placedOffers.filter((o) => o.status === "expired" || (o.status === "pending" && !!o.archivedAt)), [placedOffers]);

  // ── Split received offers into 4 lifecycle buckets ────────────────────────────
  // Active:   pending (seller can still accept or decline)
  // Accepted: paid/accepted — seller accepted the offer, card was transferred
  // Declined: seller explicitly rejected the offer
  // Expired:  offer timed out without a response
  const receivedActive   = useMemo(() => receivedOffers.filter((o) => o.status === "pending"),                          [receivedOffers]);
  const receivedAccepted = useMemo(() => receivedOffers.filter((o) => o.status === "paid" || o.status === "accepted"),  [receivedOffers]);
  const receivedDeclined = useMemo(() => receivedOffers.filter((o) => o.status === "rejected"),                         [receivedOffers]);
  const receivedExpired  = useMemo(() => receivedOffers.filter((o) => o.status === "expired"),                          [receivedOffers]);

  const visiblePlaced = {
    active:   placedActive,
    accepted: placedAccepted,
    declined: placedDeclined,
    expired:  placedExpired,
  }[offerTab];

  const visibleReceived = {
    active:   receivedActive,
    accepted: receivedAccepted,
    declined: receivedDeclined,
    expired:  receivedExpired,
  }[offerTab];

  // ── Loading / auth wait ──────────────────────────────────────────────────────
  if (status === "loading" || !isLoggedIn) {
    return <AccountLoadingGate />;
  }

  // ── Shared button style factory ───────────────────────────────────────────────
  // Selected view button: dark fill. Unselected: outlined/ghost.
  const viewBtnSx = (isActive: boolean) => ({
    textTransform: "none" as const,
    fontWeight: 700,
    fontSize: 14,
    borderRadius: "10px",
    px: 2.5,
    py: 1,
    border: "1px solid",
    ...(isActive
      ? { bgcolor: "#111827", color: "#fff", borderColor: "#111827", "&:hover": { bgcolor: "#1f2937" } }
      : { bgcolor: "#fff", color: "#374151", borderColor: "#c9cdd4", "&:hover": { bgcolor: "#f9fafb", borderColor: "#6b7280" } }),
  });

  // ── Render ───────────────────────────────────────────────────────────────────

  // 1. Show full-page error state so the user has a clear recovery path.
  if (error) {
    return (
      <AccountLayout>
        <ErrorState
          variant="error"
          title="Couldn't load your offers"
          action={{ label: "Refresh page", onClick: () => window.location.reload() }}
        />
      </AccountLayout>
    );
  }

  return (
    <AccountLayout>
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}>
        <Typography component="h1" sx={{ fontSize: { xs: 24, md: 28 }, fontWeight: 800, letterSpacing: "-0.5px", mb: 3 }}>
          My Offers
        </Typography>
      </motion.div>

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", py: 10 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {/* ── View toggle: Offers Placed | Incoming Offers ─────────────────── */}
          <Box sx={{ display: "flex", gap: 1.5, mb: 3, flexWrap: "wrap" }}>
            <Button disableElevation onClick={() => handleViewChange("placed")}   sx={viewBtnSx(offerView === "placed")}>
              Offers Placed
            </Button>
            <Button disableElevation onClick={() => handleViewChange("received")} sx={viewBtnSx(offerView === "received")}>
              Incoming Offers
            </Button>
          </Box>

          {/* ── Lifecycle tabs: Active → Accepted → Declined → Expired ──────── */}
          <Box sx={{ display: "flex", borderBottom: "1px solid #c9cdd4", mb: 3 }}>
            <TabButton label="Active"   active={offerTab === "active"}   onClick={() => setOfferTab("active")}   />
            <TabButton label="Accepted" active={offerTab === "accepted"} onClick={() => setOfferTab("accepted")} />
            <TabButton label="Declined" active={offerTab === "declined"} onClick={() => setOfferTab("declined")} />
            <TabButton label="Expired"  active={offerTab === "expired"}  onClick={() => setOfferTab("expired")}  />
          </Box>

          {/* ── Offers Placed ─────────────────────────────────────────────────── */}
          {/* 2. AnimatePresence mode="wait" means the old panel fully exits
                 before the new one enters — prevents two panels overlapping.
                 key combines view + tab so switching either triggers the transition. */}
          <AnimatePresence mode="wait">
          {offerView === "placed" && (
            <motion.div
              key={`placed-${offerTab}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
            {visiblePlaced.length === 0 ? (
              <EmptyState
                icon={<GavelIcon sx={{ fontSize: 40, color: "#d1d5db" }} />}
                title={{
                  active:   "No active offers. Place an offer on a card listing to get started.",
                  accepted: "No accepted offers yet.",
                  declined: "No declined offers.",
                  expired:  "No expired offers.",
                }[offerTab]}
              />
            ) : (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {visiblePlaced.map((o, i) => (
                  <motion.div
                    key={o.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, ease: "easeOut", delay: Math.min(i * 0.06, 0.3) }}
                  >
                    <PlacedOfferCard offer={o} />
                  </motion.div>
                ))}
              </Box>
            )}
            </motion.div>
          )}

          {/* ── Incoming Offers ───────────────────────────────────────────────── */}
          {offerView === "received" && (
            <motion.div
              key={`received-${offerTab}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
              transition={{ duration: 0.25, ease: "easeOut" }}
            >
            {visibleReceived.length === 0 ? (
              <EmptyState
                icon={<GavelIcon sx={{ fontSize: 40, color: "#d1d5db" }} />}
                title={{
                  active:   "No pending offers on your listings.",
                  accepted: "No accepted offers yet.",
                  declined: "No declined offers.",
                  expired:  "No expired offers.",
                }[offerTab]}
              />
            ) : (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {visibleReceived.map((o, i) => (
                  <motion.div
                    key={o.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.28, ease: "easeOut", delay: Math.min(i * 0.06, 0.3) }}
                  >
                    <ReceivedOfferCard
                      offer={o}
                      onRespond={(id, action) =>
                        setReceivedOffers((prev) =>
                          prev.map((r) =>
                            r.id === id
                              ? { ...r, status: action === "accept" ? "paid" : "rejected" }
                              : r
                          )
                        )
                      }
                      onStale={() =>
                        fetch("/api/offers?received=true")
                          .then((r) => r.json())
                          .then((data) => { if (data.offers) setReceivedOffers(data.offers); })
                          .catch(() => {})
                      }
                    />
                  </motion.div>
                ))}
              </Box>
            )}
            </motion.div>
          )}
          </AnimatePresence>
        </>
      )}
    </AccountLayout>
  );
}
