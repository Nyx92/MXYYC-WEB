"use client";

// src/app/marketplace/loading.tsx
//
// Shown automatically by Next.js (via Suspense) while page.tsx's async
// getListingsPage() call is in flight — replaces the old client-only
// PoroLoader spinner, which couldn't appear until the JS bundle had
// already loaded. Card-tile dimensions match CardListItem.tsx (288x228),
// and placeholders below approximate the search box and FilterBar that
// sit above the grid in MarketPlace.tsx, to minimize (not fully eliminate —
// FilterBar's exact height varies with facet content) layout shift when
// real content replaces this skeleton.
import { Box, Skeleton } from "@mui/material";
import { pageBackgroundSx } from "@/app/utils/pageBackground";
import { NAVBAR_HEIGHT } from "@/app/utils/navChrome";

const SKELETON_COUNT = 25;

export default function MarketplaceLoading() {
  return (
    <Box
      component="main"
      sx={{
        ...pageBackgroundSx("/collateral/Riftbound_BG_Market.webp"),
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

          {/* Approximates MarketPlace.tsx's search TextField (centered,
              up to 600px wide) — see the "Toolbar" Box there. */}
          <Box sx={{ display: "flex", justifyContent: "center", mb: 4 }}>
            <Skeleton
              variant="rounded"
              width="100%"
              height={40}
              sx={{ maxWidth: 600, width: { xs: "100%", sm: 480, md: 600 }, bgcolor: "rgba(255,255,255,0.12)" }}
            />
          </Box>

          {/* Approximates FilterBar.tsx's single row of game-toggle +
              multi-select facet controls. */}
          <Skeleton
            variant="rounded"
            width="100%"
            height={56}
            sx={{ mb: 3, borderRadius: 3, bgcolor: "rgba(255,255,255,0.10)" }}
          />

          <Box sx={{ display: "flex", flexWrap: "wrap", gap: "16px", justifyContent: "center" }}>
            {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
              <Skeleton
                key={i}
                variant="rounded"
                width={288}
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
