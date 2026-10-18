"use client";

import React, { useEffect, useState } from "react";
import { Box, Typography } from "@mui/material";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from "recharts";

import { toPriceVariantLabel } from "../../utils/mapCondition";
import { formatPrice } from "@/lib/money";
import type { CardItem } from "@/types/card";
import type { MarketData } from "@/types/market";

type PriceTooltipPayload = {
  dataKey?: string | number;
  value?: number | string | null;
};

type PriceTooltipProps = {
  active?: boolean;
  payload?: PriceTooltipPayload[];
  label?: string | number;
};

// Price dates are Singapore calendar days sent as "YYYY-MM-DD" (see
// src/lib/sgTime.ts). Formatted in UTC so the browser's own time zone can't
// shift the day: "2026-10-18" shows as 18/10 everywhere.
const formatShortDate = (isoDate: string) =>
  new Date(isoDate).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });

const PriceTooltip: React.FC<PriceTooltipProps> = ({
  active,
  payload,
  label,
}) => {
  if (!active || !payload || payload.length === 0) return null;

  const marketPoint = payload.find((p) => p.dataKey === "price");
  const listedPoint = payload.find((p) => p.dataKey === "listedPrice");

  return (
    <Box sx={{ p: 1.2 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>

      {marketPoint && typeof marketPoint.value === "number" && (
        <Typography variant="body2">
          Market (SGD): {marketPoint.value.toFixed(2)}
        </Typography>
      )}

      {listedPoint && typeof listedPoint.value === "number" && (
        <Typography variant="body2">
          Listed (SGD): {listedPoint.value.toFixed(2)}
        </Typography>
      )}
    </Box>
  );
};

interface CardMarketChartProps {
  card: CardItem;
}

const CardMarketChart: React.FC<CardMarketChartProps> = ({ card }) => {
  const [marketData, setMarketData] = useState<MarketData | null>(null);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const isForSale = card.forSale && card.status !== "sold";

  useEffect(() => {
    if (!card.tcgPlayerId) return;

    const variantLabel = toPriceVariantLabel(card.condition);

    const fetchMarket = async () => {
      setLoadingMarket(true);
      try {
        const res = await fetch(
          `/api/price-history/${card.tcgPlayerId}?game=${card.game}`
        );
        const json = await res.json();
        const variant = json?.variants?.[variantLabel];

        if (!variant) {
          setMarketData(null);
          return;
        }

        // For a graded listing, also surface the raw baseline price alongside
        // it — the grading premium only means something next to that number.
        const rawPrice =
          variantLabel !== "RAW" ? json?.variants?.RAW?.currentPrice ?? null : null;

        setMarketData({
          variantLabel,
          currentPrice: variant.currentPrice ?? null,
          lastUpdated: variant.lastUpdated ?? null,
          history: variant.history ?? [],
          rawPrice,
        });
      } catch (e) {
        console.error("Market fetch error:", e);
        setMarketData(null);
      } finally {
        setLoadingMarket(false);
      }
    };

    fetchMarket();
  }, [card.tcgPlayerId, card.game, card.condition]);

  if (loadingMarket) {
    return (
      <Box
        sx={{
          border: "1px solid #e6e6e6",
          borderRadius: 2,
          backgroundColor: "#fff",
          overflow: "hidden",
          p: 2,
        }}
      >
        <Typography variant="body2" color="text.secondary">
          Fetching market data...
        </Typography>
      </Box>
    );
  }

  if (
    !marketData ||
    !Array.isArray(marketData.history) ||
    marketData.history.length === 0
  ) {
    return (
      <Box
        sx={{
          border: "1px solid #e6e6e6",
          borderRadius: 2,
          backgroundColor: "#fff",
          overflow: "hidden",
        }}
      >
        <Box sx={{ px: 2, py: 1.2, borderBottom: "1px solid #eee" }}>
          <Typography sx={{ fontSize: 16, fontWeight: 900, color: "#111" }}>
            Global Market Data
          </Typography>
          <Typography sx={{ fontSize: 13, color: "#6b7280", mt: 0.2 }}>
            Compare values across international card markets
          </Typography>
        </Box>

        <Box sx={{ p: 2 }}>
          <Typography variant="body2" color="text.secondary">
            No price data available for this card
          </Typography>
        </Box>
      </Box>
    );
  }

  // Prices already arrive in SGD from the API — no client-side conversion needed.
  const chartData = marketData.history.map((h, idx, arr) => ({
    dateLabel: formatShortDate(h.date),
    price: h.price,
    listedPrice:
      isForSale && typeof card.price === "number" && idx === arr.length - 1
        ? card.price
        : null,
  }));

  return (
    <Box
      sx={{
        border: "1px solid #e6e6e6",
        borderRadius: 2,
        backgroundColor: "#fff",
        overflow: "hidden",
      }}
    >
      {/* Header inside chart */}
      <Box sx={{ px: 2, py: 1.2 }}>
        <Typography
          sx={{
            fontSize: { xs: 9, sm: 10, md: 12, lg: 14 },
            fontWeight: 700,
            color: "#111",
          }}
        >
          Historical Prices
        </Typography>
        <Typography
          sx={{
            fontSize: { xs: 8, sm: 9, md: 10, lg: 12 },
            color: "#6b7280",
            mt: 0.2,
          }}
        >
          Compare values across time
        </Typography>
      </Box>

      <Box sx={{ pl: 2, pr: 2, pb: 1 }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <Typography
            variant="subtitle2"
            color="text.secondary"
            sx={{
              fontSize: { xs: 6, sm: 7, md: 8, lg: 10 },
            }}
          >
            Price history — <strong>{marketData.variantLabel}</strong>
          </Typography>

          <Box sx={{ textAlign: "right" }}>
            {/* Current market price — shown directly, not just as a chart point. */}
            <Typography
              sx={{
                fontSize: { xs: 10, sm: 11, md: 13, lg: 15 },
                fontWeight: 700,
                color: "#111",
              }}
            >
              Current Market Price: {formatPrice(marketData.currentPrice)}
            </Typography>

            {/* A graded card's price only makes sense next to its raw baseline. */}
            {marketData.rawPrice != null && (
              <Typography sx={{ fontSize: { xs: 8, sm: 9, md: 10, lg: 11 }, color: "#6b7280" }}>
                Raw baseline: {formatPrice(marketData.rawPrice)}
              </Typography>
            )}

            {marketData.lastUpdated && (
              <Typography sx={{ fontSize: { xs: 8, sm: 9, md: 10, lg: 11 }, color: "#9ca3af", mt: 0.2 }}>
                Last updated: {formatShortDate(marketData.lastUpdated)}
              </Typography>
            )}
          </Box>
        </Box>

        <Box
          sx={{
            width: "100%",
            height: 220,
            bgcolor: "#fafafa",
            borderRadius: 2,
            border: "1px solid #eee",
            px: 0.2,
            py: 1.5,
            position: "relative",
          }}
        >
          {/* Legend bottom-right (inside) */}
          {isForSale && (
            <Box
              sx={{
                position: "absolute",
                bottom: 15,
                right: 12,
                display: "flex",
                alignItems: "center",
                gap: 0.6,
                px: 1,
                py: 0.3,
                borderRadius: 1,
                backdropFilter: "blur(4px)",
              }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: "#d32f2f",
                  border: "2px solid #b71c1c",
                }}
              />
              <Typography variant="caption" color="text.secondary">
                Listed Price (SGD)
              </Typography>
            </Box>
          )}

          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: 16, left: 0, bottom: 30 }}
              onMouseMove={(state: any) => {
                if (
                  state?.isTooltipActive &&
                  typeof state?.activeTooltipIndex === "number"
                ) {
                  setActiveIndex(state.activeTooltipIndex);
                } else {
                  setActiveIndex(null);
                }
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />

              <XAxis
                dataKey="dateLabel"
                tick={{ fontSize: 11, fill: "#757575" }}
                tickLine={false}
                axisLine={{ stroke: "#e0e0e0" }}
              />

              <YAxis
                tick={{ fontSize: 11, fill: "#757575" }}
                tickLine={false}
                axisLine={{ stroke: "#e0e0e0" }}
                width={60}
              />

              <Tooltip content={<PriceTooltip />} />

              {activeIndex !== null &&
                chartData[activeIndex] &&
                chartData[activeIndex].dateLabel && (
                  <ReferenceLine
                    x={chartData[activeIndex].dateLabel}
                    stroke="#1976d2"
                    strokeDasharray="3 3"
                  />
                )}

              <Line
                type="monotone"
                dataKey="price"
                name="price"
                stroke="#1976d2"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 6 }}
              />

              {isForSale && typeof card.price === "number" && (
                <Line
                  type="monotone"
                  dataKey="listedPrice"
                  name="listedPrice"
                  stroke="transparent"
                  strokeWidth={0}
                  dot={{
                    r: 6,
                    stroke: "#b71c1c",
                    strokeWidth: 2,
                    fill: "#d32f2f",
                  }}
                  activeDot={{
                    r: 8,
                    stroke: "#b71c1c",
                    strokeWidth: 2,
                    fill: "#d32f2f",
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </Box>
      </Box>
    </Box>
  );
};

export default CardMarketChart;
