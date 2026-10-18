"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { Box, Tabs, Tab } from "@mui/material";
import { motion } from "framer-motion";
import HomeFeatured, { type FeaturedData } from "./home/HomeFeatured";
import Carousell from "./home/carousell/Carousell";
import DuckReveal from "./home/DuckReveal";
import { pageBackgroundSx } from "@/app/utils/pageBackground";
import { NAVBAR_HEIGHT, frostedTabsSx } from "@/app/utils/navChrome";
import CollectionsIcon from "@mui/icons-material/Collections";
import StorefrontIcon from "@mui/icons-material/Storefront";
import GavelIcon from "@mui/icons-material/Gavel";
import UploadIcon from "@mui/icons-material/Upload";
import { useAuth } from "@/app/hooks/useAuth";

const TAB_VALUES = ["/myCollection", "/marketplace", "/auctions", "/upload"];

export default function HomePage({ initialFeatured }: { initialFeatured: FeaturedData | null }) {
  const pathname = usePathname();
  const { isLoggedIn, isAdmin } = useAuth();
  // The home page itself isn't one of the tabs — MUI's Tabs logs a console
  // warning if `value` doesn't match any Tab's `value`, so fall back to
  // `false` (its documented "no tab selected" state) instead of passing "/".
  const tabsValue = TAB_VALUES.includes(pathname) ? pathname : false;

  return (
    <Box
      component="main"
      sx={{
        ...pageBackgroundSx("/collateral/Riftbound_BG.webp"),
        mt: `-${NAVBAR_HEIGHT}px`,
        pt: `${NAVBAR_HEIGHT}px`,
        minHeight: "100vh",
      }}
    >
      {/* Visually hidden — gives the page a real h1 for screen readers/SEO
          without duplicating the hero carousel's own visual title. */}
      <Box
        component="h1"
        sx={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          m: -1,
        }}
      >
        MXYYC — Pokémon card marketplace
      </Box>

      {/* Hero Carousel */}
      <Carousell />

      {/* Tab Bar Section */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut", delay: 0.15 }}
      >
        <Box sx={{ mt: 4, px: { xs: 2, md: 4 } }}>
          <Box sx={{ display: "flex", justifyContent: "center" }}>
            <Tabs
              value={tabsValue}
              textColor="primary"
              indicatorColor="primary"
              variant="scrollable"
              scrollButtons="auto"
              sx={frostedTabsSx}
            >
              {isLoggedIn && (
                <Tab
                  component={Link}
                  href="/myCollection"
                  icon={<CollectionsIcon />}
                  label="My Collection"
                  iconPosition="start"
                  value="/myCollection"
                />
              )}
              <Tab
                component={Link}
                href="/marketplace"
                icon={<StorefrontIcon />}
                label="Marketplace"
                iconPosition="start"
                value="/marketplace"
              />
              <Tab
                component={Link}
                href="/auctions"
                icon={<GavelIcon />}
                label="Auctions"
                iconPosition="start"
                value="/auctions"
              />
              {isAdmin && (
                <Tab
                  component={Link}
                  href="/upload"
                  icon={<UploadIcon />}
                  label="Upload Card"
                  iconPosition="start"
                  value="/upload"
                />
              )}
            </Tabs>
          </Box>

          {/* Content */}
          <Box sx={{ mt: 4 }}>
            <HomeFeatured initialData={initialFeatured} />
          </Box>
        </Box>
      </motion.div>
      <DuckReveal />
    </Box>
  );
}
