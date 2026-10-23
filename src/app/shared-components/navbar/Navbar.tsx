"use client";
/**
 * Navbar — fixed top navigation bar.
 *
 * When the user is logged in, clicking the profile button opens a dropdown menu
 * instead of navigating directly. The dropdown links to all account-section pages
 * (Profile, Watchlist, Purchases, Offers, Sold) and has a Log Out item at the bottom.
 *
 * The same nav items are mirrored in ProfileSidebar so both surfaces stay in sync.
 * If you add a new account page, update NAV_ITEMS in ProfileSidebar.tsx too.
 */

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { signOut } from "next-auth/react";
import {
  AppBar, Badge, Box, Button, Container, Divider, IconButton,
  ListItemIcon, Menu, MenuItem, Toolbar, Typography,
} from "@mui/material";
import PersonIcon from "@mui/icons-material/Person";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import ShoppingBagOutlinedIcon from "@mui/icons-material/ShoppingBagOutlined";
import GavelIcon from "@mui/icons-material/Gavel";
import SellOutlinedIcon from "@mui/icons-material/SellOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import ShoppingCartOutlinedIcon from "@mui/icons-material/ShoppingCartOutlined";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import { NAVBAR_HEIGHT, NAVBAR_BAR_HEIGHT, SHOW_TEST_BANNER, TEST_BANNER_HEIGHT } from "@/app/utils/navChrome";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import DocumentScannerOutlinedIcon from "@mui/icons-material/DocumentScannerOutlined";
import { useAuth } from "@/app/hooks/useAuth";
import { useWatchlistAnimation } from "@/app/context/WatchlistAnimationContext";
import { useCart } from "@/app/context/CartContext";
import { useNotifications } from "@/app/context/NotificationContext";

// ── Dropdown nav items ────────────────────────────────────────────────────────
// Mirrors the NAV_ITEMS list in ProfileSidebar.tsx — keep them in sync.
const ACCOUNT_ITEMS = [
  { label: "Profile",       href: "/profile",       Icon: PersonOutlineIcon },
  { label: "Watchlist",     href: "/watchlist",     Icon: BookmarkBorderIcon },
  { label: "Purchases",     href: "/purchases",     Icon: ShoppingBagOutlinedIcon },
  { label: "Offers",        href: "/offers",        Icon: GavelIcon },
  { label: "Sold",          href: "/sold",          Icon: SellOutlinedIcon },
  { label: "Notifications", href: "/notifications", Icon: NotificationsNoneOutlinedIcon },
] as const;

// Staff-only — appended to the dropdown below only when session.user.role === "admin".
const ADMIN_ITEMS = [
  { label: "Pickup Requests", href: "/admin/collection-requests", Icon: Inventory2OutlinedIcon },
  { label: "Card Intake", href: "/admin/ingest", Icon: DocumentScannerOutlinedIcon },
] as const;

const DARK = "#ffffff";

export default function Navbar() {
  const { user, isLoggedIn } = useAuth();
  const displayUser = user?.username ?? "Profile";
  const { navbarIconRef, count } = useWatchlistAnimation();
  const { count: cartCount } = useCart();
  const { unreadCount: notifCount } = useNotifications();

  // Bounce the watchlist icon each time the count increases
  const prevCountRef = useRef(count);
  useEffect(() => {
    if (count > prevCountRef.current && navbarIconRef.current) {
      const el = navbarIconRef.current;
      el.style.animation = "none";
      void el.offsetHeight; // force reflow to restart animation
      el.style.animation =
        "watchlist-badge-pop 0.38s cubic-bezier(0.36, 0.07, 0.19, 0.97) both";
    }
    prevCountRef.current = count;
  }, [count, navbarIconRef]);

  // ── Dropdown state ────────────────────────────────────────────────────────────
  // anchorEl is the DOM element the Menu positions itself against.
  // null = closed, HTMLElement = open.
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const menuOpen = Boolean(anchorEl);

  const handleOpenMenu  = (e: React.MouseEvent<HTMLElement>) => setAnchorEl(e.currentTarget);
  const handleCloseMenu = () => setAnchorEl(null);

  return (
    <AppBar
      position="fixed"
      elevation={0}
      sx={{
        height: NAVBAR_HEIGHT,
        backgroundColor: "#000000",
        boxShadow: "0 2px 20px rgba(0, 0, 0, 0.40)",
        zIndex: 1300,
        overflow: "visible",
      }}
    >
      <Container maxWidth="xl" sx={{ height: NAVBAR_BAR_HEIGHT }}>
        <Toolbar disableGutters sx={{ height: "100%" }}>

          {/* ── Logo ──────────────────────────────────────────────────────── */}
          <Link
            href="/"
            style={{ display: "flex", alignItems: "center", textDecoration: "none", flexShrink: 0, gap: 8 }}
          >
            {/*
              The logo is a JPEG (black line-art psyduck on a white background).
              Two CSS tricks remove the white background on a black navbar:

              1. filter: invert(1)
                 Flips every colour: black lines → white, white background → black.

              2. mix-blend-mode: screen
                 Screen blends the image with whatever is behind it.
                 On a black navbar, black pixels (0) screen black (0) = 0 → invisible.
                 White pixels (255) screen black (0) = 255 → stay white.
                 Result: black JPEG background disappears, white psyduck lines remain.

              If you ever switch to a light/white navbar, swap both tricks back to
              mix-blend-mode: multiply (and remove the invert filter) — multiply
              makes white pixels transparent on light backgrounds instead.
            */}
            <Image
              src="/collateral/logo.png"
              alt="A logo"
              width={40}
              height={40}
              style={{ objectFit: "contain", filter: "invert(1)", mixBlendMode: "screen" }}
            />
            <Typography
              sx={{
                fontWeight: 700,
                fontSize: 18,
                color: "#ffffff",
                letterSpacing: "0.04em",
                // Icon-only on very narrow screens — logo + wordmark + 3 icon
                // buttons + auth buttons is too tight to fit under ~400px.
                display: { xs: "none", sm: "block" },
              }}
            >
              MXYYC
            </Typography>
          </Link>

          {/* ── Spacer ────────────────────────────────────────────────────── */}
          <Box sx={{ flex: 1 }} />

          {/* ── Icon buttons ──────────────────────────────────────────────── */}
          {/* component={Link} (not onClick + router.push) on every nav
              affordance in this bar — Cart/Watchlist/Notifications here and
              the account dropdown items below — so Next.js prefetches the
              destination on hover/focus instead of only starting that fetch
              at click time. That doesn't change scheduling priority the way
              wrapping a competing setState in startTransition does (see
              HomeFeatured.tsx for that separate fix) — it's a complementary
              technique that shrinks how long a click spends waiting on data,
              which is exactly the window during which a slow in-flight page
              fetch elsewhere in the tree could make the click feel stuck. */}
          <IconButton
            component={Link}
            href="/cart"
            aria-label="Cart"
            sx={{ color: "#ffffff", p: { xs: 0.75, sm: 1.25 }, "&:hover": { backgroundColor: "rgba(255,255,255,0.10)" } }}
          >
            <Badge
              badgeContent={cartCount > 0 ? cartCount : undefined}
              sx={{
                "& .MuiBadge-badge": {
                  backgroundColor: "#e53935",
                  color: "#fff",
                  fontSize: 10,
                  minWidth: 16,
                  height: 16,
                  padding: "0 3px",
                  top: 2,
                  right: 2,
                },
              }}
            >
              <ShoppingCartOutlinedIcon fontSize="small" />
            </Badge>
          </IconButton>

          <IconButton
            component={Link}
            href="/watchlist"
            // navbarIconRef is typed for a <button> since useWatchlistAnimation
            // is shared with contexts that don't render as a Link — only
            // getBoundingClientRect is ever called on it, which any element
            // ref supports, so the cast here is safe.
            ref={navbarIconRef as unknown as React.Ref<HTMLAnchorElement>}
            aria-label="Watchlist"
            sx={{ color: "#ffffff", p: { xs: 0.75, sm: 1.25 }, "&:hover": { backgroundColor: "rgba(255,255,255,0.10)" } }}
          >
            <Badge
              badgeContent={count > 0 ? count : undefined}
              sx={{
                "& .MuiBadge-badge": {
                  backgroundColor: "#0053ff",
                  color: "#fff",
                  fontSize: 10,
                  minWidth: 16,
                  height: 16,
                  padding: "0 3px",
                  top: 2,
                  right: 2,
                },
              }}
            >
              <BookmarkBorderIcon fontSize="small" />
            </Badge>
          </IconButton>

          <IconButton
            component={Link}
            href="/notifications"
            aria-label="Notifications"
            sx={{ color: "#ffffff", p: { xs: 0.75, sm: 1.25 }, mr: 0.5, "&:hover": { backgroundColor: "rgba(255,255,255,0.10)" } }}
          >
            <Badge
              badgeContent={notifCount > 0 ? notifCount : undefined}
              sx={{
                "& .MuiBadge-badge": {
                  backgroundColor: "#f59e0b",
                  color: "#fff",
                  fontSize: 10,
                  minWidth: 16,
                  height: 16,
                  padding: "0 3px",
                  top: 2,
                  right: 2,
                },
              }}
            >
              <NotificationsNoneIcon fontSize="small" />
            </Badge>
          </IconButton>

          {/* Thin divider */}
          <Box sx={{ width: "1px", height: 20, backgroundColor: "rgba(255,255,255,0.20)", mx: 1, display: { xs: "none", sm: "block" } }} />

          {/* ── Auth ──────────────────────────────────────────────────────── */}
          <Box sx={{ display: "flex", alignItems: "center", gap: { xs: 0.5, sm: 1 } }}>
            {!isLoggedIn ? (
              <>
                <Button
                  href="/auth/signup"
                  disableElevation
                  sx={{ textTransform: "none", fontWeight: 700, fontSize: 14, px: { xs: 1.5, sm: 2.5 }, py: 0.85, borderRadius: "10px", backgroundColor: "rgba(255,255,255,0.20)", color: "#ffffff", border: "1px solid rgba(255,255,255,0.50)", "&:hover": { backgroundColor: "rgba(255,255,255,0.30)" } }}
                >
                  Sign up
                </Button>
                <Button
                  href="/auth/login"
                  sx={{ textTransform: "none", fontWeight: 500, fontSize: 14, px: { xs: 1, sm: 2 }, color: "rgba(255,255,255,0.70)", "&:hover": { color: "#ffffff", backgroundColor: "transparent" } }}
                >
                  Login
                </Button>
              </>
            ) : (
              <>
                {/* Profile button — opens the dropdown on click */}
                <Button
                  onClick={handleOpenMenu}
                  disableElevation
                  aria-controls={menuOpen ? "account-menu" : undefined}
                  aria-haspopup="true"
                  aria-expanded={menuOpen ? "true" : undefined}
                  sx={{
                    textTransform: "none",
                    borderRadius: "10px",
                    px: 1.5,
                    py: 0.75,
                    color: DARK,
                    backgroundColor: menuOpen ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.15)",
                    border: "1px solid rgba(255,255,255,0.30)",
                    "&:hover": { backgroundColor: "rgba(255,255,255,0.25)" },
                    gap: 1,
                  }}
                >
                  <Box sx={{ width: 26, height: 26, borderRadius: "50%", backgroundColor: "rgba(255,255,255,0.20)", display: "grid", placeItems: "center" }}>
                    <PersonIcon sx={{ fontSize: 16, color: DARK }} />
                  </Box>
                  <Typography sx={{ fontWeight: 600, fontSize: 14, color: DARK }}>
                    {displayUser}
                  </Typography>
                </Button>

                {/* ── Account dropdown menu ── */}
                <Menu
                  id="account-menu"
                  anchorEl={anchorEl}
                  open={menuOpen}
                  onClose={handleCloseMenu}
                  // Align the left edge of the menu to the left edge of the button
                  anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                  transformOrigin={{ vertical: "top",    horizontal: "right" }}
                  slotProps={{
                    paper: {
                      sx: {
                        bgcolor: "#111827",
                        color: "#fff",
                        borderRadius: 2,
                        minWidth: 200,
                        mt: 0.75,              // small gap between button and menu
                        boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
                        "& .MuiMenuItem-root": {
                          fontSize: 14,
                          fontWeight: 500,
                          py: 1.2,
                          px: 2,
                          color: "rgba(255,255,255,0.85)",
                          "&:hover": { bgcolor: "rgba(255,255,255,0.08)", color: "#fff" },
                        },
                      },
                    },
                  }}
                >
                  {/* Account nav items — component={Link}, same prefetch
                      rationale as the Cart/Watchlist/Notifications buttons
                      above. */}
                  {[...ACCOUNT_ITEMS, ...(user?.role === "admin" ? ADMIN_ITEMS : [])].map(({ label, href, Icon }) => (
                    <MenuItem key={href} component={Link} href={href} onClick={handleCloseMenu}>
                      <ListItemIcon sx={{ minWidth: 32 }}>
                        <Icon sx={{ fontSize: 18, color: "rgba(255,255,255,0.6)" }} />
                      </ListItemIcon>
                      {label}
                    </MenuItem>
                  ))}

                  <Divider sx={{ borderColor: "rgba(255,255,255,0.12)", my: 0.5 }} />

                  {/* Log Out — red tint to signal a destructive action */}
                  <MenuItem
                    onClick={() => { handleCloseMenu(); signOut({ callbackUrl: "/" }); }}
                    sx={{ color: "#f87171 !important", "&:hover": { bgcolor: "rgba(248,113,113,0.08) !important" } }}
                  >
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      <LogoutIcon sx={{ fontSize: 18, color: "#f87171" }} />
                    </ListItemIcon>
                    Log Out
                  </MenuItem>
                </Menu>
              </>
            )}
          </Box>
        </Toolbar>
      </Container>
      {SHOW_TEST_BANNER && (
        <Box
          role="note"
          sx={{
            height: TEST_BANNER_HEIGHT,
            px: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 1,
            backgroundColor: "#fbbf24",
            color: "#1f2937",
          }}
        >
          <ScienceOutlinedIcon sx={{ fontSize: 18, flexShrink: 0 }} />
          <Typography
            sx={{
              fontSize: { xs: 11, sm: 13 },
              lineHeight: 1.25,
              fontWeight: 600,
              textAlign: "center",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            Test phase: this site is still being tested. Cards listed here are not actually for sale, and no orders will be fulfilled.
          </Typography>
        </Box>
      )}
    </AppBar>
  );
}
