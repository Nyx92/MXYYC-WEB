"use client";

import { useEffect, useState } from "react";
import { Box, Typography, Button } from "@mui/material";
import { useRouter } from "next/navigation";
import type { CardItem } from "@/types/card";

const primaryBlue = "#0053ff";
const GROUPS = ["All", "Raw", "PSA", "Beckett", "CGC", "SGC"] as const;
type Group = (typeof GROUPS)[number];

function getGroup(condition: string): Group {
  if (condition.startsWith("PSA")) return "PSA";
  if (condition.startsWith("Beckett") || condition.startsWith("BGS"))
    return "Beckett";
  if (condition.startsWith("CGC")) return "CGC";
  if (condition.startsWith("SGC")) return "SGC";
  return "Raw";
}

interface AllListingsProps {
  tcgPlayerId: string;
  currentCardId: string;
}

export default function AllListings({
  tcgPlayerId,
  currentCardId,
}: AllListingsProps) {
  const router = useRouter();
  const [listings, setListings] = useState<CardItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Group | "All">("All");

  useEffect(() => {
    if (!tcgPlayerId) return;
    fetch(
      `/api/cards?tcgPlayerId=${encodeURIComponent(tcgPlayerId)}`
    )
      .then((r) => r.json())
      .then((data) => {
        if (data.cards) setListings(data.cards);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [tcgPlayerId]);

  const counts = GROUPS.reduce<Record<string, number>>((acc, g) => {
    acc[g] =
      g === "All"
        ? listings.length
        : listings.filter((l) => getGroup(l.condition) === g).length;
    return acc;
  }, {});

  const filtered =
    filter === "All"
      ? listings
      : listings.filter((l) => getGroup(l.condition) === filter);
  const sorted = [...filtered].sort(
    (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)
  );

  return (
    <Box
      sx={{
        border: "1px solid #e5e7eb",
        borderRadius: 2,
        backgroundColor: "#fff",
        overflow: "hidden",
        boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
      }}
    >
      {/* Header */}
      <Box sx={{ px: 3, py: 2, borderBottom: "1px solid #e5e7eb" }}>
        <Typography sx={{ fontWeight: 700, fontSize: 17, color: "#111" }}>
          {loading
            ? "Loading…"
            : `${listings.length} Listing${listings.length !== 1 ? "s" : ""}`}
        </Typography>
        <Typography sx={{ fontSize: 12, color: "#6b7280", mt: 0.3 }}>
          All available listings for this card
        </Typography>
      </Box>

      {/* Condition group filter */}
      <Box
        sx={{
          px: 3,
          py: 1.5,
          borderBottom: "1px solid #f3f4f6",
          display: "flex",
          gap: 1,
          flexWrap: "wrap",
        }}
      >
        {GROUPS.map((g) => {
          const count = counts[g];
          if (count === 0 && g !== "All") return null;
          const isSelected = filter === g;
          return (
            <Box
              key={g}
              onClick={() => setFilter(g)}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setFilter(g);
                }
              }}
              sx={{
                px: 1.5,
                py: 0.5,
                borderRadius: 999,
                cursor: "pointer",
                border: isSelected
                  ? `1.5px solid ${primaryBlue}`
                  : "1px solid #e5e7eb",
                backgroundColor: isSelected ? "#eff4ff" : "#fff",
                display: "flex",
                alignItems: "center",
                gap: 0.8,
                "&:hover": !isSelected ? { borderColor: "#6b7280" } : {},
                "&:focus-visible": { outline: `2px solid ${primaryBlue}`, outlineOffset: 2 },
              }}
            >
              <Typography
                sx={{
                  fontSize: 13,
                  fontWeight: isSelected ? 700 : 500,
                  color: isSelected ? primaryBlue : "#374151",
                }}
              >
                {g}
              </Typography>
              <Box
                sx={{
                  backgroundColor: isSelected ? primaryBlue : "#e5e7eb",
                  borderRadius: 999,
                  px: 0.8,
                  py: 0.1,
                  minWidth: 20,
                  textAlign: "center",
                }}
              >
                <Typography
                  sx={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: isSelected ? "#fff" : "#6b7280",
                  }}
                >
                  {count}
                </Typography>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Column headers */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "2fr 100px 100px",
          px: 3,
          py: 1,
          borderBottom: "1px solid #f3f4f6",
          backgroundColor: "#fafafa",
        }}
      >
        {["Condition", "Price", ""].map((h) => (
          <Typography
            key={h}
            sx={{
              fontSize: 11,
              fontWeight: 600,
              color: "#6b7280",
              textTransform: "uppercase",
              letterSpacing: "0.4px",
            }}
          >
            {h}
          </Typography>
        ))}
      </Box>

      {/* Rows */}
      {sorted.length === 0 ? (
        <Typography
          sx={{
            p: 3,
            color: "text.secondary",
            textAlign: "center",
            fontSize: 14,
          }}
        >
          No listings found.
        </Typography>
      ) : (
        sorted.map((listing, i) => {
          const isCurrent = listing.id === currentCardId;
          return (
            <Box
              key={listing.id}
              sx={{
                display: "grid",
                gridTemplateColumns: "2fr 100px 100px",
                alignItems: "center",
                px: 3,
                py: 1.4,
                borderBottom:
                  i < sorted.length - 1 ? "1px solid #f3f4f6" : "none",
                backgroundColor: isCurrent ? "#f5f8ff" : "#fff",
                "&:hover": !isCurrent ? { backgroundColor: "#fafafa" } : {},
              }}
            >
              {/* Condition */}
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography
                  sx={{ fontSize: 13, fontWeight: 700, color: "#111" }}
                >
                  {listing.condition}
                </Typography>
                {isCurrent && (
                  <Box
                    sx={{
                      px: 0.8,
                      py: 0.2,
                      backgroundColor: "#eff4ff",
                      border: `1px solid ${primaryBlue}`,
                      borderRadius: 1,
                    }}
                  >
                    <Typography
                      sx={{ fontSize: 10, fontWeight: 700, color: primaryBlue }}
                    >
                      Viewing
                    </Typography>
                  </Box>
                )}
              </Box>

              {/* Price */}
              <Typography sx={{ fontSize: 14, fontWeight: 700, color: "#111" }}>
                {listing.price != null ? `S$${listing.price.toFixed(2)}` : "—"}
              </Typography>

              {/* Action */}
              <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
                {!isCurrent && (
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => router.push(`/cards/${listing.id}`)}
                    sx={{
                      textTransform: "none",
                      fontSize: 12,
                      fontWeight: 600,
                      backgroundColor: "#5b7fe8",
                      "&:hover": { backgroundColor: "#0041cc" },
                      borderRadius: 1.5,
                      px: 2,
                      py: 0.5,
                      boxShadow: "none",
                    }}
                  >
                    View
                  </Button>
                )}
              </Box>
            </Box>
          );
        })
      )}
    </Box>
  );
}
