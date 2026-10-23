// "Test phase" notice shown under the navbar on every page, so visitors don't
// take the listings for real cards on sale. Set to false at launch.
export const SHOW_TEST_BANNER = true;
export const TEST_BANNER_HEIGHT = SHOW_TEST_BANNER ? 36 : 0;

// Height of the navbar's own bar (logo, icons, login).
export const NAVBAR_BAR_HEIGHT = 64;

// Total height of the fixed AppBar in Navbar.tsx (bar + test banner) — used by
// layout.tsx's top padding and by pages that pull their content up under the
// navbar (see pageBackgroundSx usage).
export const NAVBAR_HEIGHT = NAVBAR_BAR_HEIGHT + TEST_BANNER_HEIGHT;

// Frosted-glass pill styling for the primary nav Tabs (Marketplace/Auctions/etc),
// shared by the homepage, marketplace, and auctions pages so they stay visually
// consistent against their dark backgrounds.
export const frostedTabsSx = {
  "& .MuiTabs-flexContainer": {
    justifyContent: "center",
    gap: 1.5,
  },
  "& .MuiTabs-indicator": {
    display: "none",
  },
  "& .MuiTabScrollButton-root": {
    color: "#fff",
  },
  "& .MuiTab-root": {
    fontWeight: 600,
    fontSize: "1.05rem",
    letterSpacing: "0.5px",
    textTransform: "none",
    color: "rgba(255,255,255,0.85)",
    minHeight: 44,
    px: 2.5,
    py: 1,
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.28)",
    backgroundColor: "rgba(255,255,255,0.10)",
    backdropFilter: "blur(8px)",
    transition: "background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease",
    "&:hover": {
      backgroundColor: "rgba(255,255,255,0.18)",
      borderColor: "rgba(255,255,255,0.45)",
    },
  },
  "& .Mui-selected": {
    color: "#111 !important",
    backgroundColor: "#fff",
    borderColor: "#fff",
    boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
  },
};
