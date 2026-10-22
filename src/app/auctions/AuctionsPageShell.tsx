"use client";

// The decorative chrome (background, tabs, animated header) around the
// auctions grid — mirrors src/app/marketplace/MarketplacePageShell.tsx's
// split for the same reason: Auctions.tsx is its own "use client" component
// passed in as `children`, so this file doesn't need to also be one, but
// MUI/framer-motion here need client context regardless.

import { Box, Typography } from "@mui/material";
import { fadeInSx } from "@/app/utils/fadeIn";
import MarketplaceTabs from "@/app/marketplace/MarketplaceTabs";
import { pageBackgroundSx } from "@/app/utils/pageBackground";
import { NAVBAR_HEIGHT } from "@/app/utils/navChrome";
import { FULL_VIEWPORT_HEIGHT } from "@/app/utils/uiScale";

export default function AuctionsPageShell({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="main"
      sx={{
        ...pageBackgroundSx("/collateral/Riftbound_BG_Ships.webp"),
        mt: `-${NAVBAR_HEIGHT}px`,
        pt: { xs: "88px", md: "112px" },
        minHeight: FULL_VIEWPORT_HEIGHT,
      }}
    >
      <Box sx={{ mt: 4, px: { xs: 2, md: 4 } }}>
        <MarketplaceTabs />

        <Box sx={{ mt: 4 }}>
          <Box sx={fadeInSx({ duration: 0.4, y: 16 })}>
            <Box sx={{ mb: 4 }}>
              <Typography component="h1" sx={{ fontSize: { xs: 22, md: 28 }, fontWeight: 800, lineHeight: 1.1, color: "#fff" }}>
                Live Auctions
              </Typography>
              <Typography sx={{ fontSize: 13, color: "rgba(255,255,255,0.6)", mt: 0.25 }}>
                Bid on rare Pokémon and Riftbound cards. Funds are only charged if your bid wins.
              </Typography>
            </Box>
          </Box>

          {children}
        </Box>
      </Box>
    </Box>
  );
}
