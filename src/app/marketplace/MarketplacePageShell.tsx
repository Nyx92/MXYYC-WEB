"use client";

// The decorative chrome (background, tabs, animated header) around the
// marketplace's card grid. Split out from page.tsx so that file can stay an
// async Server Component doing the initial data fetch — @mui/material's Box/
// Typography and framer-motion's motion.div all rely on client-side context
// (theming, animation) that crashes Next's server-side "Collecting page
// data" pass when rendered directly from a Server Component (surfaced as
// "TypeError: (0 , o.unstable_createUseMediaQuery) is not a function" at
// build time). Marketplace itself (MarketPlace.tsx) is already its own
// "use client" component, so it's passed in as `children` rather than
// imported here directly — no need to duplicate that boundary.

import { Box, Typography } from "@mui/material";
import { fadeInSx } from "@/app/utils/fadeIn";
import MarketplaceTabs from "./MarketplaceTabs";
import { pageBackgroundSx } from "@/app/utils/pageBackground";
import { NAVBAR_HEIGHT } from "@/app/utils/navChrome";

export default function MarketplacePageShell({ children }: { children: React.ReactNode }) {
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
        <MarketplaceTabs />

        <Box sx={{ mt: 4 }}>
          {/* Page header */}
          <Box sx={fadeInSx({ duration: 0.4, y: 16 })}>
            <Box sx={{ mb: 4 }}>
              <Typography component="h1" sx={{ fontSize: { xs: 22, md: 28 }, fontWeight: 800, lineHeight: 1.1, color: "#fff" }}>
                Marketplace
              </Typography>
              <Typography sx={{ fontSize: 13, color: "rgba(255,255,255,0.6)", mt: 0.25 }}>
                Browse and buy Pokémon and Riftbound cards listed by other collectors.
              </Typography>
            </Box>
          </Box>

          {children}
        </Box>
      </Box>
    </Box>
  );
}
