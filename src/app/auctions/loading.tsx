"use client";

// src/app/auctions/loading.tsx
//
// Shown automatically by Next.js (via Suspense) while page.tsx's async
// getAuctionsPage() call is in flight — mirrors marketplace/loading.tsx.
// Tile dimensions match AuctionCardItem's real minHeight (228) and the
// grid's own minmax(340px, 1fr) column sizing, to minimize layout shift
// when real content replaces this skeleton.
import { Box, Skeleton } from "@mui/material";
import { pageBackgroundSx } from "@/app/utils/pageBackground";
import { NAVBAR_HEIGHT } from "@/app/utils/navChrome";

const SKELETON_COUNT = 12;

export default function AuctionsLoading() {
  return (
    <Box
      component="main"
      sx={{
        ...pageBackgroundSx("/collateral/Riftbound_BG_Ships.webp"),
        mt: `-${NAVBAR_HEIGHT}px`,
        pt: { xs: "88px", md: "112px" },
        minHeight: "100vh",
      }}
    >
      <Box sx={{ mt: 4, px: { xs: 2, md: 4 } }}>
        <Box sx={{ display: "flex", justifyContent: "center", mb: 4 }}>
          <Skeleton variant="rounded" width={200} height={40} sx={{ bgcolor: "rgba(255,255,255,0.12)" }} />
        </Box>

        <Box sx={{ mt: 4 }}>
          <Box sx={{ mb: 4 }}>
            <Skeleton variant="text" width={220} height={36} sx={{ bgcolor: "rgba(255,255,255,0.12)" }} />
            <Skeleton variant="text" width={340} height={20} sx={{ bgcolor: "rgba(255,255,255,0.08)" }} />
          </Box>

          {/* Approximates Auctions.tsx's centered search box. */}
          <Box sx={{ display: "flex", justifyContent: "center", mb: 4 }}>
            <Skeleton
              variant="rounded"
              width="100%"
              height={40}
              sx={{ maxWidth: 600, width: { xs: "100%", sm: 480, md: 600 }, bgcolor: "rgba(255,255,255,0.12)" }}
            />
          </Box>

          {/* Approximates AuctionFilterBar.tsx's single row of controls. */}
          <Skeleton
            variant="rounded"
            width="100%"
            height={56}
            sx={{ mb: 3, borderRadius: 3, bgcolor: "rgba(255,255,255,0.10)" }}
          />

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
              gap: "16px",
            }}
          >
            {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <Skeleton
                key={i}
                variant="rounded"
                height={228}
                sx={{ bgcolor: "rgba(255,255,255,0.10)" }}
              />
            ))}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
