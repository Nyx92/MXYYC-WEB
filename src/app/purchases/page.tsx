"use client";
/**
 * /purchases — shows the current user's completed purchases (PAID orders only).
 *
 * Data:  GET /api/orders?type=purchases  → { orders: OrderRow[] }
 * Auth:  client-side via useAuth; redirects to /auth/login if unauthenticated.
 * Layout: AccountLayout (sidebar + content panel)
 *
 * The ?success=1 query param is set by the Stripe checkout redirect
 * (see src/app/api/checkout/route.ts successUrl) and triggers a success banner.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Box, Typography, TextField, InputAdornment, IconButton,
  CircularProgress, Button,
} from "@mui/material";
import ShoppingBagIcon from "@mui/icons-material/ShoppingBag";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";

import { useAuth } from "@/app/hooks/useAuth";
import AccountLayout from "@/app/shared-components/AccountLayout";
import AccountLoadingGate from "@/app/shared-components/AccountLoadingGate";
import ErrorState from "@/app/shared-components/ErrorState";
import EmptyState from "@/app/shared-components/EmptyState";
import { OrderCard, type OrderRow } from "@/app/shared-components/transaction-cards";
import { motion, AnimatePresence } from "framer-motion";

export default function PurchasesPage() {
  const { isLoggedIn, status } = useAuth();
  const router   = useRouter();
  const params   = useSearchParams();

  // ── Auth guard ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (status !== "loading" && !isLoggedIn) router.replace("/auth/login");
  }, [status, isLoggedIn, router]);

  // ── State ────────────────────────────────────────────────────────────────────
  const [purchases, setPurchases] = useState<OrderRow[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [q, setQ]                 = useState("");
  // Tracks the isLoggedIn value that `purchases`/`error` currently reflect.
  // `loading` is derived by comparing it against the live isLoggedIn value
  // instead of a separately re-armed boolean, so the fetch effect below
  // never needs to call setState synchronously as its first statement
  // (react-hooks/set-state-in-effect flags that shape).
  const [loadedFor, setLoadedFor] = useState<boolean | null>(null);
  const loading = isLoggedIn && loadedFor !== isLoggedIn;

  // Checkout outcome banner — "checking" while we poll the webhook result,
  // then "paid" / "refunded" / "timeout" once the status is known.
  const isCheckoutReturn = params.get("success") === "1";
  const sessionId        = params.get("session_id");
  type CheckoutState = "idle" | "checking" | "paid" | "refunded" | "timeout";
  // If there's no sessionId to poll, the outcome is already known at mount
  // (generic ?success=1 => treat as paid) — computed directly in the
  // initializer instead of a follow-up setCheckoutState("paid") call inside
  // the polling effect below, which react-hooks/set-state-in-effect flags
  // as a synchronous setState in the effect body.
  const [checkoutState, setCheckoutState] = useState<CheckoutState>(
    isCheckoutReturn ? (sessionId ? "checking" : "paid") : "idle"
  );

  // ── Fetch all purchases ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoggedIn) return;
    fetch("/api/orders?type=purchases")
      .then((r) => r.json())
      .then((d) => { if (d.orders) setPurchases(d.orders); else setError(d.error); })
      .catch(() => setError("Failed to load purchases."))
      .finally(() => setLoadedFor(isLoggedIn));
  }, [isLoggedIn]);

  // ── Poll session outcome after Stripe redirect ───────────────────────────────
  // The webhook runs asynchronously — orders may still be PENDING when the page
  // loads. Poll until all are in a terminal state (PAID / REFUNDED) or we time out.
  useEffect(() => {
    if (!isLoggedIn || !isCheckoutReturn || !sessionId) {
      // No session to poll — if it's a generic ?success=1, checkoutState was
      // already initialized to "paid" above (derived from the URL params at
      // mount), so there's nothing to do here.
      return;
    }

    let attempts = 0;
    // Stops the chain on unmount / dep change so a stale poll can't keep
    // firing requests or set state after the page is gone.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const MAX_ATTEMPTS = 8;   // 8 × 2 s = 16 s max
    const INTERVAL_MS  = 2000;

    const check = async () => {
      attempts++;
      try {
        const res  = await fetch(`/api/orders?sessionId=${encodeURIComponent(sessionId)}`);
        const data = await res.json();
        if (cancelled) return;
        const sessionOrders: OrderRow[] = data.orders ?? [];

        const allTerminal = sessionOrders.length > 0 &&
          sessionOrders.every((o) => o.status === "PAID" || o.status === "REFUNDED");

        if (allTerminal) {
          const anyRefunded = sessionOrders.some((o) => o.status === "REFUNDED");
          setCheckoutState(anyRefunded ? "refunded" : "paid");
          // Refresh the full list so newly PAID orders appear
          const full = await fetch("/api/orders?type=purchases").then((r) => r.json());
          if (!cancelled && full.orders) setPurchases(full.orders);
          return;
        }
      } catch {
        // Network hiccup — keep trying
      }

      if (cancelled) return;
      if (attempts >= MAX_ATTEMPTS) {
        setCheckoutState("timeout");
      } else {
        timer = setTimeout(check, INTERVAL_MS);
      }
    };

    // Small initial delay — give the webhook a head start
    timer = setTimeout(check, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, sessionId]);

  // ── Filter ───────────────────────────────────────────────────────────────────
  // Only show PAID orders — PENDING = abandoned checkout, EXPIRED = timed out
  const filtered = useMemo(() => {
    const paid = purchases.filter((o) => o.status === "PAID");
    if (!q.trim()) return paid;
    const lq = q.toLowerCase();
    return paid.filter((o) =>
      [o.card.title, o.card.condition, `S$${o.amount}`, o.id]
        .join(" ").toLowerCase().includes(lq)
    );
  }, [purchases, q]);

  // ── Loading / auth wait ──────────────────────────────────────────────────────
  if (status === "loading" || !isLoggedIn) {
    return <AccountLoadingGate />;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  // 1. Show full-page error state so the user has a clear recovery path.
  if (error) {
    return (
      <AccountLayout>
        <ErrorState
          variant="error"
          title="Couldn't load your purchases"
          action={{ label: "Refresh page", onClick: () => window.location.reload() }}
        />
      </AccountLayout>
    );
  }

  return (
    <AccountLayout>
      {/* Page header */}
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 2, mb: 3 }}>
        <Typography component="h1" sx={{ fontSize: { xs: 24, md: 28 }, fontWeight: 800, letterSpacing: "-0.5px" }}>
          Purchases
        </Typography>
        <TextField
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by card name, condition, amount…"
          size="small"
          sx={{ width: { xs: "100%", md: 340 }, "& .MuiOutlinedInput-root": { borderRadius: 2, backgroundColor: "#fff" } }}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start"><SearchIcon sx={{ color: "#6b7280" }} /></InputAdornment>,
              endAdornment: q ? (
                <InputAdornment position="end">
                  <IconButton onClick={() => setQ("")} aria-label="Clear search" size="small"><CloseIcon fontSize="small" /></IconButton>
                </InputAdornment>
              ) : null,
            },
          }}
        />
      </Box>
      </motion.div>

      {/* Checkout outcome banner — shown after Stripe redirect */}
      {checkoutState === "checking" && (
        <Box sx={{ mb: 3, border: "1px solid rgba(99,102,241,0.3)", backgroundColor: "rgba(99,102,241,0.06)", borderRadius: 2, px: 2.5, py: 1.4, display: "flex", alignItems: "center", gap: 1.5 }}>
          <CircularProgress size={18} sx={{ color: "#4f46e5" }} />
          <Typography sx={{ fontSize: 14, color: "#4338ca", fontWeight: 600 }}>
            Confirming your payment…
          </Typography>
        </Box>
      )}

      {checkoutState === "paid" && (
        <Box sx={{ mb: 3, border: "1px solid rgba(16,185,129,0.3)", backgroundColor: "rgba(16,185,129,0.07)", borderRadius: 2, px: 2.5, py: 1.4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2 }}>
          <Box sx={{ display: "flex", gap: 1.5, alignItems: "center" }}>
            <ShoppingBagIcon sx={{ color: "#065f46" }} />
            <Box>
              <Typography sx={{ fontWeight: 800, color: "#065f46" }}>Payment successful</Typography>
              <Typography sx={{ fontSize: 13, color: "#047857" }}>Your transaction has been recorded below.</Typography>
            </Box>
          </Box>
          <Button variant="text" sx={{ textTransform: "none", fontWeight: 700, color: "#047857" }} onClick={() => setCheckoutState("idle")}>
            Dismiss
          </Button>
        </Box>
      )}

      {checkoutState === "refunded" && (
        <Box sx={{ mb: 3, border: "1px solid rgba(239,68,68,0.35)", backgroundColor: "rgba(239,68,68,0.06)", borderRadius: 2, px: 2.5, py: 1.4, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2 }}>
          <Box>
            <Typography sx={{ fontWeight: 800, color: "#b91c1c" }}>Payment refunded</Typography>
            <Typography sx={{ fontSize: 13, color: "#dc2626" }}>
              Your payment could not be completed and has been refunded. Funds will appear within 5–10 business days.
            </Typography>
          </Box>
          <Button variant="text" sx={{ textTransform: "none", fontWeight: 700, color: "#b91c1c" }} onClick={() => setCheckoutState("idle")}>
            Dismiss
          </Button>
        </Box>
      )}

      {checkoutState === "timeout" && (
        <Box sx={{ mb: 3, border: "1px solid rgba(234,179,8,0.4)", backgroundColor: "rgba(234,179,8,0.07)", borderRadius: 2, px: 2.5, py: 1.4 }}>
          <Typography sx={{ fontWeight: 800, color: "#854d0e" }}>Payment processing</Typography>
          <Typography sx={{ fontSize: 13, color: "#a16207" }}>
            Your payment is being processed. Your order will appear below shortly — if it doesn&apos;t show up in a few minutes, please contact support.
          </Typography>
        </Box>
      )}

      {/* Order list */}
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 10 }}><CircularProgress /></Box>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<ShoppingBagIcon sx={{ fontSize: 40, color: "#d1d5db" }} />}
            title={q ? "No purchases match your search." : "You haven't purchased anything yet."}
          />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={q}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { staggerChildren: 0.06 } }}
              exit={{ opacity: 0, transition: { duration: 0.15 } }}
              style={{ display: "flex", flexDirection: "column", gap: "16px" }}
            >
              {filtered.map((o, i) => (
                <motion.div
                  key={o.id}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: "easeOut", delay: Math.min(i * 0.06, 0.3) }}
                >
                  <OrderCard order={o} />
                </motion.div>
              ))}
            </motion.div>
          </AnimatePresence>
        )}
      </Box>
    </AccountLayout>
  );
}
