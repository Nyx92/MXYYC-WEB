"use client";
/**
 * ProfileSidebar — shared left-nav for all account pages.
 *
 * Used by: /profile, /watchlist, /purchases, /offers, /sold
 *
 * The active route is highlighted by comparing usePathname() against each
 * item's href. The sidebar is sticky so it stays visible while the right
 * content panel scrolls.
 */

import { usePathname } from "next/navigation";
import Link from "next/link";
import { signOut } from "next-auth/react";
import {
  Box, List, ListItem, ListItemButton,
  ListItemIcon, ListItemText, Divider, Typography,
} from "@mui/material";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import ShoppingBagOutlinedIcon from "@mui/icons-material/ShoppingBagOutlined";
import GavelIcon from "@mui/icons-material/Gavel";
import SellOutlinedIcon from "@mui/icons-material/SellOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import NotificationsNoneOutlinedIcon from "@mui/icons-material/NotificationsNoneOutlined";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import DocumentScannerOutlinedIcon from "@mui/icons-material/DocumentScannerOutlined";
import { useAuth } from "@/app/hooks/useAuth";

// ── Nav items ─────────────────────────────────────────────────────────────────
// Add new account-section pages here — they will appear in the sidebar
// automatically without touching any page file.
const NAV_ITEMS = [
  { label: "Profile",       href: "/profile",       Icon: PersonOutlineIcon },
  { label: "Watchlist",     href: "/watchlist",     Icon: BookmarkBorderIcon },
  { label: "Purchases",     href: "/purchases",     Icon: ShoppingBagOutlinedIcon },
  { label: "Offers",        href: "/offers",        Icon: GavelIcon },
  { label: "Sold",          href: "/sold",          Icon: SellOutlinedIcon },
  { label: "Notifications", href: "/notifications", Icon: NotificationsNoneOutlinedIcon },
] as const;

// Staff-only — mirrors ADMIN_ITEMS in Navbar.tsx's dropdown, keep in sync.
const ADMIN_ITEMS = [
  { label: "Pickup Requests", href: "/admin/collection-requests", Icon: Inventory2OutlinedIcon },
  { label: "Card Intake", href: "/admin/ingest", Icon: DocumentScannerOutlinedIcon },
] as const;

const ACTIVE_BLUE = "#0053ff";

export default function ProfileSidebar() {
  const pathname = usePathname();
  const { isAdmin } = useAuth();
  const items = isAdmin ? [...NAV_ITEMS, ...ADMIN_ITEMS] : NAV_ITEMS;

  return (
    <Box
      sx={{
        width: 210,
        flexShrink: 0,
        bgcolor: "#fff",
        borderRadius: 2.5,
        border: "1px solid #e5e7eb",
        p: 1.5,
        alignSelf: "flex-start",
        // Keeps the sidebar in view as the right panel scrolls.
        // top = navbar height (64px) + page top padding (24px)
        position: "sticky",
        top: 88,
      }}
    >
      {/* ── Account label ── */}
      <Typography
        sx={{
          fontSize: 11,
          fontWeight: 700,
          color: "#6b7280",
          textTransform: "uppercase",
          letterSpacing: "0.6px",
          px: 1.5,
          pb: 1,
        }}
      >
        Account
      </Typography>

      {/* ── Nav items ── */}
      {/* component={Link}, same prefetch rationale as Navbar.tsx's nav
          buttons/dropdown. */}
      <List disablePadding>
        {items.map(({ label, href, Icon }) => {
          const active = pathname === href;
          return (
            <ListItem key={href} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                component={Link}
                href={href}
                sx={{
                  borderRadius: 1.5,
                  px: 1.5,
                  py: 0.9,
                  bgcolor: active ? "rgba(0,83,255,0.08)" : "transparent",
                  "&:hover": {
                    bgcolor: active ? "rgba(0,83,255,0.12)" : "#f9fafb",
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 34 }}>
                  <Icon sx={{ fontSize: 19, color: active ? ACTIVE_BLUE : "#6b7280" }} />
                </ListItemIcon>
                <ListItemText
                  primary={label}
                  slotProps={{
                    primary: {
                      sx: {
                        fontSize: 14,
                        fontWeight: active ? 700 : 500,
                        color: active ? ACTIVE_BLUE : "#374151",
                      },
                    },
                  }}
                />
              </ListItemButton>
            </ListItem>
          );
        })}
      </List>

      <Divider sx={{ my: 1.5 }} />

      {/* ── Logout ── */}
      <List disablePadding>
        <ListItem disablePadding>
          <ListItemButton
            onClick={() => signOut({ callbackUrl: "/" })}
            sx={{
              borderRadius: 1.5,
              px: 1.5,
              py: 0.9,
              "&:hover": { bgcolor: "#f9fafb" },
            }}
          >
            <ListItemIcon sx={{ minWidth: 34 }}>
              <LogoutIcon sx={{ fontSize: 19, color: "#6b7280" }} />
            </ListItemIcon>
            <ListItemText
              primary="Log Out"
              slotProps={{
                primary: { sx: { fontSize: 14, fontWeight: 500, color: "#374151" } },
              }}
            />
          </ListItemButton>
        </ListItem>
      </List>
    </Box>
  );
}
