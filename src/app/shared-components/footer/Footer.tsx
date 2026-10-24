"use client";

import { forwardRef, type ReactNode } from "react";
import Image from "next/image";
import { Box, Container, Link, Typography } from "@mui/material";
import LocationOnOutlinedIcon from "@mui/icons-material/LocationOnOutlined";
import PhoneOutlinedIcon from "@mui/icons-material/PhoneOutlined";
import MailOutlineIcon from "@mui/icons-material/MailOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import SendOutlinedIcon from "@mui/icons-material/SendOutlined";
import InstagramIcon from "@mui/icons-material/Instagram";
import FacebookIcon from "@mui/icons-material/Facebook";
import FavoriteIcon from "@mui/icons-material/Favorite";

// Layout follows the other WaveSEO-built sites (Mongolia Nomad Tours): a
// brand column and link columns, then a legal bar with copyright, policy
// links and the site credit.

// Amber, like the gold calls to action on the home page and the test
// banner; hover goes to near-black rather than another colour.
const ACCENT = "#b45309";
const HOVER = "#111";

const SHOP_LINKS = [
  { label: "Marketplace", href: "/marketplace" },
  { label: "Live Auctions", href: "/auctions" },
  { label: "Pokémon Cards", href: "/marketplace?game=POKEMON" },
  { label: "Riftbound Cards", href: "/marketplace?game=RIFTBOUND" },
  { label: "Sell Your Cards", href: "/upload" },
];

const LEGAL_LINKS = [
  { label: "Privacy Policy", href: "/privacy" },
  { label: "Terms of Service", href: "/terms" },
  { label: "Refund Policy", href: "/refund-policy" },
];

function ColumnTitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      component="span"
      sx={{
        display: "block",
        mb: 1.25,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: "#111",
      }}
    >
      {children}
    </Typography>
  );
}

// One icon + text row in the Visit Us / Follow Us columns.
function IconRow({
  icon,
  children,
  href,
  external = false,
}: {
  icon: ReactNode;
  children: ReactNode;
  href?: string;
  external?: boolean;
}) {
  const content = (
    <>
      <Box component="span" sx={{ display: "flex", color: ACCENT, mt: "1px", "& svg": { fontSize: 16 } }}>
        {icon}
      </Box>
      <span>{children}</span>
    </>
  );
  const sx = {
    display: "flex",
    alignItems: "flex-start",
    gap: 1,
    width: "fit-content",
    fontSize: 13,
    lineHeight: 1.4,
    color: "#4b5563",
  };
  if (!href) return <Box sx={sx}>{content}</Box>;
  return (
    <Link
      href={href}
      underline="none"
      {...(external && { target: "_blank", rel: "noopener noreferrer" })}
      sx={{ ...sx, "&:hover": { color: HOVER } }}
    >
      {content}
    </Link>
  );
}

const Footer = forwardRef<HTMLDivElement>((_, ref) => {
  return (
    <Box
      component="footer"
      ref={ref}
      id="footer"
      sx={{ backgroundColor: "#e8e8ea", borderTop: "1px solid #d9d9de" }}
    >
      <Container
        maxWidth="lg"
        sx={{
          py: { xs: 3.5, md: 4.5 },
          display: "grid",
          // Phones: brand and contact full width, Shop and Follow Us side by side.
          gridTemplateColumns: { xs: "1fr 1fr", md: "1.3fr 1fr 1.3fr 1fr" },
          gap: { xs: 3, md: 5 },
        }}
      >
        {/* Brand */}
        <Box sx={{ gridColumn: { xs: "1 / -1", md: "auto" } }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.25, mb: 1.25 }}>
            {/* Black line art on a white background — multiply drops the
                white on this light footer (the dark navbar uses invert + screen). */}
            <Image
              src="/collateral/logo.png"
              alt="MXYYC"
              width={38}
              height={38}
              style={{ objectFit: "contain", mixBlendMode: "multiply" }}
            />
            <Box>
              <Typography sx={{ fontWeight: 800, fontSize: 17, color: "#111", lineHeight: 1.2 }}>
                MXYYC
              </Typography>
              <Typography
                sx={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: ACCENT }}
              >
                Online TCG Store
              </Typography>
            </Box>
          </Box>
          <Typography sx={{ fontSize: 13, lineHeight: 1.5, color: "#4b5563", maxWidth: 300 }}>
            A Singapore trading card store and marketplace for Pokémon and Riftbound — buy, sell
            and bid on Japanese and English singles.
          </Typography>
        </Box>

        {/* Shop */}
        <Box>
          <ColumnTitle>Shop</ColumnTitle>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "grid", gap: 0.75 }}>
            {SHOP_LINKS.map(({ label, href }) => (
              <li key={href}>
                <Link
                  href={href}
                  underline="none"
                  sx={{ fontSize: 13, color: "#4b5563", "&:hover": { color: HOVER } }}
                >
                  {label}
                </Link>
              </li>
            ))}
          </Box>
        </Box>

        {/* Visit / contact */}
        <Box sx={{ display: "grid", gap: 0.9, alignContent: "start", gridColumn: { xs: "1 / -1", md: "auto" }, order: { xs: 4, md: 0 } }}>
          <ColumnTitle>Visit Us</ColumnTitle>
          <IconRow icon={<LocationOnOutlinedIcon />}>22, #08-087 Midview City, Singapore 573969</IconRow>
          <IconRow icon={<PhoneOutlinedIcon />} href="tel:+6592954911">
            +65 9295 4911
          </IconRow>
          <IconRow icon={<MailOutlineIcon />} href="mailto:mxyychua@mxyyc.community">
            mxyychua@mxyyc.community
          </IconRow>
          <IconRow icon={<InfoOutlinedIcon />} href="/about-us">
            About Us
          </IconRow>
          <IconRow icon={<SendOutlinedIcon />} href="/contact-us">
            Contact Us
          </IconRow>
        </Box>

        {/* Socials */}
        <Box sx={{ display: "grid", gap: 0.9, alignContent: "start" }}>
          <ColumnTitle>Follow Us</ColumnTitle>
          <IconRow icon={<InstagramIcon />} href="https://www.instagram.com/mxyycards" external>
            @mxyycards
          </IconRow>
          <IconRow icon={<FacebookIcon />} href="https://www.facebook.com/profile.php?id=61553535959493" external>
            Facebook
          </IconRow>
        </Box>
      </Container>

      {/* Legal bar */}
      <Box sx={{ backgroundColor: "#dedee2", py: 1.5 }}>
        <Container
          maxWidth="lg"
          sx={{
            display: "flex",
            flexDirection: { xs: "column", md: "row" },
            alignItems: "center",
            justifyContent: "space-between",
            gap: { xs: 0.75, md: 2 },
            fontSize: 12,
            color: "#6b7280",
            textAlign: "center",
          }}
        >
          <span>© {new Date().getFullYear()} MXYYC. All rights reserved.</span>
          <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 2 }}>
            {LEGAL_LINKS.map(({ label, href }) => (
              <Link key={href} href={href} underline="none" sx={{ color: "inherit", "&:hover": { color: HOVER } }}>
                {label}
              </Link>
            ))}
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            Made with <FavoriteIcon sx={{ fontSize: 12, color: "#e11d48" }} /> for collectors
          </Box>
          {/* Site credit — same as the other WaveSEO-built sites. */}
          <Link
            href="https://waveseo.co"
            target="_blank"
            rel="noopener"
            underline="none"
            sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "inherit", "&:hover": { color: HOVER } }}
          >
            Proudly built by
            <Image
              src="/images/site/waveseo-logo-mark.png"
              alt=""
              width={16}
              height={16}
              style={{ borderRadius: 2 }}
            />
            <Box component="span" sx={{ fontWeight: 700 }}>
              waveseo.co
            </Box>
          </Link>
        </Container>
      </Box>
    </Box>
  );
});

Footer.displayName = "Footer";

export default Footer;
