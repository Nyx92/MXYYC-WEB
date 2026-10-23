"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Box, Button, CircularProgress, Typography } from "@mui/material";
import { motion, type Variants } from "framer-motion";
import RemoveShoppingCartOutlinedIcon from "@mui/icons-material/RemoveShoppingCartOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { formatPrice } from "@/lib/money";
import type { CardItem } from "@/types/card";

// Same entrance motion as ErrorState, so the page feels like the rest of the app.
const iconVariant: Variants = {
  hidden: { opacity: 0, scale: 0.4 },
  visible: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 350, damping: 13 } },
};
const itemVariant: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: "easeOut" } },
};
const containerVariant: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1 } },
};

// "releasing" while POST /api/checkout/cancel runs; "paid" when the buyer's
// payment went through after all; "pending" when we couldn't close it
// (signed out, network error) — the 15-minute hold then ends on its own.
type Status = "releasing" | "released" | "paid" | "pending";

export default function CheckoutCancelled({
  cardId,
  fromCart,
}: {
  cardId: string | null;
  fromCart: boolean;
}) {
  const [status, setStatus] = useState<Status>("releasing");
  const [card, setCard] = useState<CardItem | null>(null);

  useEffect(() => {
    fetch("/api/checkout/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cardId ? { cardId } : {}),
    })
      .then(async (res) => {
        if (!res.ok) return setStatus("pending");
        const data = await res.json();
        setStatus(data.paid ? "paid" : "released");
      })
      .catch(() => setStatus("pending"));

    if (cardId) {
      fetch(`/api/cards/${encodeURIComponent(cardId)}`)
        .then((r) => r.json())
        .then((d) => { if (d.card) setCard(d.card); })
        .catch(() => {});
    }
  }, [cardId]);

  const what = cardId ? "This card is" : "Your cart items are";
  const copy: Record<Status, { title: string; subtitle: string }> = {
    releasing: { title: "Cancelling your checkout…", subtitle: "One moment." },
    released: {
      title: "Checkout cancelled",
      subtitle: `You haven't been charged. ${what} available again — to you and to other collectors, so don't wait too long.`,
    },
    paid: {
      title: "Your payment already went through",
      subtitle: "This checkout was completed before you left, so the order is yours. You'll find it in your purchases.",
    },
    pending: {
      title: "Checkout cancelled",
      subtitle: `You haven't been charged. ${what} held for up to 15 minutes, then available again.`,
    },
  };

  const back = cardId
    ? { label: "Back to card", href: `/cards/${encodeURIComponent(cardId)}` }
    : fromCart
      ? { label: "Back to cart", href: "/cart" }
      : { label: "Go to marketplace", href: "/marketplace" };
  const primary = status === "paid" ? { label: "View purchases", href: "/purchases" } : back;

  const paid = status === "paid";
  const Icon = paid ? CheckCircleOutlineIcon : RemoveShoppingCartOutlinedIcon;

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        px: 2,
        py: { xs: 8, md: 12 },
      }}
    >
      <motion.div
        variants={containerVariant}
        initial="hidden"
        animate="visible"
        style={{ width: "100%", maxWidth: 440, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}
      >
        <motion.div variants={iconVariant}>
          <Box
            sx={{
              width: 72,
              height: 72,
              borderRadius: "50%",
              backgroundColor: paid ? "#dcfce7" : "#eef2ff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              mb: 3,
            }}
          >
            {status === "releasing" ? (
              <CircularProgress size={30} sx={{ color: "#0053ff" }} />
            ) : (
              <Icon sx={{ fontSize: 36, color: paid ? "#16a34a" : "#0053ff" }} />
            )}
          </Box>
        </motion.div>

        <motion.div variants={itemVariant}>
          <Typography component="h1" sx={{ fontSize: { xs: 22, md: 26 }, fontWeight: 800, color: "#111", mb: 1 }}>
            {copy[status].title}
          </Typography>
          <Typography sx={{ fontSize: 14, lineHeight: 1.6, color: "#6b7280", mb: 3 }}>
            {copy[status].subtitle}
          </Typography>
        </motion.div>

        {card && (
          <motion.div variants={itemVariant} style={{ width: "100%" }}>
            <Box
              component={Link}
              href={back.href}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                p: 1.5,
                mb: 3,
                textAlign: "left",
                textDecoration: "none",
                color: "inherit",
                backgroundColor: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: 2,
                boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                "&:hover": { borderColor: "#c7d2fe" },
              }}
            >
              <Box sx={{ position: "relative", width: 56, height: 78, flexShrink: 0 }}>
                <Image
                  src={card.imageUrls?.[0] || "/placeholder.png"}
                  alt={card.title}
                  fill
                  sizes="56px"
                  style={{ objectFit: "contain" }}
                />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 700, color: "#111", lineHeight: 1.3 }}>
                  {card.title}
                </Typography>
                {card.setName && (
                  <Typography sx={{ fontSize: 12, color: "#6b7280", mt: 0.25 }}>{card.setName}</Typography>
                )}
                {card.price != null && (
                  <Typography sx={{ fontSize: 15, fontWeight: 700, color: "#0053ff", mt: 0.5 }}>
                    {formatPrice(card.price)}
                  </Typography>
                )}
              </Box>
            </Box>
          </motion.div>
        )}

        {status !== "releasing" && (
          <motion.div
            variants={itemVariant}
            style={{ width: "100%", display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}
          >
            <Button
              component={Link}
              href={primary.href}
              variant="contained"
              sx={{
                textTransform: "none",
                fontWeight: 600,
                borderRadius: 1.5,
                px: 3,
                backgroundColor: "#0053ff",
                boxShadow: "0 3px 10px rgba(0,83,255,0.25)",
                "&:hover": { backgroundColor: "#0041cc" },
              }}
            >
              {primary.label}
            </Button>
            <Button
              component={Link}
              href="/marketplace"
              variant="outlined"
              sx={{
                textTransform: "none",
                fontWeight: 500,
                borderRadius: 1.5,
                px: 3,
                color: "#111",
                borderColor: "#e5e7eb",
                backgroundColor: "#fff",
                "&:hover": { borderColor: "#d1d5db", backgroundColor: "#fafafa" },
              }}
            >
              Keep browsing
            </Button>
          </motion.div>
        )}
      </motion.div>
    </Box>
  );
}
