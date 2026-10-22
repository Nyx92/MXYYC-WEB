"use client";
/**
 * AccountLayout — two-column wrapper for all account-section pages.
 *
 * Used by: /profile, /watchlist, /purchases, /offers, /sold
 *
 * Layout:
 *   [ ProfileSidebar (fixed 210px) ]  [ children (flex: 1) ]
 *
 * The sidebar stays sticky while the content area scrolls independently.
 */

import type { ReactNode } from "react";
import { Box } from "@mui/material";
import ProfileSidebar from "./ProfileSidebar";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 3,
        minHeight: "calc(100dvh / var(--ui-scale, 1))",
        bgcolor: "#f9fafb",
        px: { xs: 2, md: 4 },
        py: 3,
      }}
    >
      <ProfileSidebar />
      {/* Content area grows to fill remaining width */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {children}
      </Box>
    </Box>
  );
}
