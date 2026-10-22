"use client";

import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";
import { Swiper, SwiperSlide } from "swiper/react";
import { Swiper as SwiperCore } from "swiper/types";
import { Navigation, Pagination, Autoplay } from "swiper/modules";
import { useRef, type ReactNode } from "react";
import { Box, Typography, Button } from "@mui/material";
import Image from "next/image";
import Link from "next/link";
import StorefrontIcon from "@mui/icons-material/Storefront";
import GavelIcon from "@mui/icons-material/Gavel";
import SellOutlinedIcon from "@mui/icons-material/SellOutlined";
import NightlightRoundIcon from "@mui/icons-material/NightlightRound";
import "./CarouselStyles.css";

// Blends a hex color toward white by `amount` (0-1) — used to derive the
// mid/light gradient stops for a button glow from a single accent color.
function lighten(hex: string, amount: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.round(((n >> 16) & 255) + (255 - ((n >> 16) & 255)) * amount);
  const g = Math.round(((n >> 8) & 255) + (255 - ((n >> 8) & 255)) * amount);
  const b = Math.round((n & 255) + (255 - (n & 255)) * amount);
  return `rgb(${r}, ${g}, ${b})`;
}

function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// CTA buttons always use this gold treatment, regardless of a slide's own
// accent (which still drives the small eyebrow badge).
const GOLD = "#f59e0b";
const GOLD_MID = lighten(GOLD, 0.15);
const GOLD_LIGHT = lighten(GOLD, 0.35);

// Placeholder promo copy for the featured-set overlay — swap in real set
// details when they're ready.
interface SlideOverlay {
  eyebrow: string;
  tag: string;
  title: string;
  subtitle: string;
  // external: true opens the link in a new tab instead of navigating the
  // visitor away from the marketplace in-place — for a CTA pointing off-site
  // (e.g. Nexus Night's registration page), not an internal route.
  primaryCta: { label: string; href: string; external?: boolean };
  secondaryCta: { label: string; href: string; external?: boolean };
  // Drives the eyebrow badge + CTA button gradient/glow. eyebrowAccent lets
  // the small badge use a different hue than the buttons (e.g. Vendetta's
  // pink badge with gold buttons); it defaults to `accent` when omitted.
  accent: string;
  eyebrowAccent?: string;
  primaryIcon?: ReactNode;
  secondaryIcon?: ReactNode;
}

interface SlideItem {
  id: number;
  image: string;
  overlay?: SlideOverlay;
}

const items: SlideItem[] = [
  { id: 1, image: "/carousell/carousell_1.webp" },
  {
    id: 2,
    image: "/carousell/carousell_2.webp",
    overlay: {
      eyebrow: "SET SPOTLIGHT",
      tag: "Origins",
      title: "Where It All Begins",
      subtitle: "The founding cards of Riftbound, together in one set for the first time.",
      primaryCta: { label: "Browse Origins Cards", href: "/marketplace?game=RIFTBOUND&setName=Origins" },
      secondaryCta: { label: "View Live Auctions", href: "/auctions" },
      accent: "#a855f7",
    },
  },
  {
    id: 3,
    image: "/carousell/carousell_3.webp",
    overlay: {
      eyebrow: "SET SPOTLIGHT",
      tag: "Vendetta",
      title: "Vendetta",
      subtitle:
        "Old rivalries, new blades. Chase the latest Vendetta singles before they're gone.",
      primaryCta: { label: "Browse Vendetta Cards", href: "/marketplace?game=RIFTBOUND&setName=Vendetta" },
      secondaryCta: { label: "View Live Auctions", href: "/auctions" },
      accent: "#f59e0b",
      eyebrowAccent: "#ec4899",
    },
  },
  {
    id: 4,
    image: "/carousell/carousell_4.webp",
    overlay: {
      eyebrow: "WEEKLY EVENT",
      tag: "Nexus Night",
      title: "Nexus Night",
      subtitle:
        "Every Saturday, 7–9 PM. Pull up a seat and battle it out with fellow collectors.",
      primaryCta: {
        label: "Join Nexus Night",
        href: "https://playriftbound.com/en-US/events?q=22%2C+%2308-087+Midview+City%2C+Singapore+573969&lat=1.358606&lng=103.83356599999999",
        external: true,
      },
      secondaryCta: { label: "Browse Marketplace", href: "/marketplace" },
      accent: "#38bdf8",
      primaryIcon: <NightlightRoundIcon />,
      secondaryIcon: <StorefrontIcon />,
    },
  },
  {
    id: 5,
    image: "/carousell/carousell_5.webp",
    overlay: {
      eyebrow: "SET SPOTLIGHT",
      tag: "Spiritforged",
      title: "Forged By Spirit",
      subtitle:
        "Ethereal blades and ribboned steel. The newest Riftbound set arrives in shimmering style.",
      primaryCta: { label: "Browse Spiritforged Cards", href: "/marketplace?game=RIFTBOUND&setName=Spiritforged" },
      secondaryCta: { label: "View Live Auctions", href: "/auctions" },
      accent: "#f472b6",
    },
  },
];

function SlideOverlayCard({
  image,
  overlay,
  priority = false,
}: {
  image: string;
  overlay: SlideOverlay;
  priority?: boolean;
}) {
  const { accent, eyebrowAccent = accent } = overlay;

  return (
    <Box
      sx={{
        position: "relative",
        height: "100%",
        width: "100%",
        borderRadius: "12px",
        overflow: "hidden",
      }}
    >
      <Image
        src={image}
        alt={overlay.title}
        fill
        // Slide is 16:9 at 350px high (622px wide), 550px high (978px) from 1200px (zoomed below 1600px — see uiScale.ts).
        sizes="(min-width: 1200px) 978px, 622px"
        quality={60}
        style={{ objectFit: "cover" }}
        priority={priority}
      />

      {/* Scrim so the text stays legible over busy artwork */}
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(90deg, rgba(6,10,20,0.90) 0%, rgba(6,10,20,0.60) 45%, rgba(6,10,20,0.05) 75%)",
        }}
      />

      <Box
        sx={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          px: { xs: 3, md: 6 },
          maxWidth: { xs: "100%", md: "62%" },
        }}
      >
        {/* Badge row */}
        <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.25, mb: 2 }}>
          <Box
            sx={{
              px: 1.5,
              py: 0.5,
              borderRadius: "999px",
              border: `1px solid ${rgba(eyebrowAccent, 0.6)}`,
              bgcolor: rgba(eyebrowAccent, 0.12),
              color: lighten(eyebrowAccent, 0.4),
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {overlay.eyebrow}
          </Box>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              px: 1.5,
              py: 0.5,
              borderRadius: "999px",
              border: "1px solid rgba(255,255,255,0.25)",
              bgcolor: "rgba(10,14,22,0.6)",
              color: "#e5e7eb",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            <SellOutlinedIcon sx={{ fontSize: 14 }} />
            {overlay.tag}
          </Box>
        </Box>

        <Typography
          sx={{
            fontWeight: 900,
            fontSize: { xs: "1.8rem", sm: "2.4rem", md: "3rem" },
            lineHeight: 1.05,
            color: "#fff",
            textShadow: "0 4px 24px rgba(0,0,0,0.5)",
            mb: 1.5,
          }}
        >
          {overlay.title}
        </Typography>

        <Typography
          sx={{
            fontSize: { xs: "0.85rem", md: "1rem" },
            color: "rgba(255,255,255,0.8)",
            maxWidth: 480,
            lineHeight: 1.5,
            mb: 3,
          }}
        >
          {overlay.subtitle}
        </Typography>

        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5 }}>
          <Button
            component={Link}
            href={overlay.primaryCta.href}
            target={overlay.primaryCta.external ? "_blank" : undefined}
            rel={overlay.primaryCta.external ? "noopener noreferrer" : undefined}
            variant="contained"
            startIcon={overlay.primaryIcon ?? <StorefrontIcon />}
            sx={{
              background: `linear-gradient(to right, ${GOLD}, ${GOLD_MID}, ${GOLD})`,
              color: "#020617",
              fontWeight: 900,
              textTransform: "uppercase",
              letterSpacing: "0.03em",
              borderRadius: "12px",
              px: 2.5,
              py: 1.1,
              boxShadow: `0 0 25px ${rgba(GOLD, 0.5)}`,
              transition: "transform 0.2s ease, box-shadow 0.2s ease",
              "&:hover": {
                background: `linear-gradient(to right, ${GOLD_MID}, ${GOLD_LIGHT}, ${GOLD_MID})`,
                boxShadow: `0 0 32px ${rgba(GOLD, 0.65)}`,
                transform: "scale(1.05)",
              },
              "&:active": { transform: "scale(0.95)" },
            }}
          >
            {overlay.primaryCta.label}
          </Button>
          <Button
            component={Link}
            href={overlay.secondaryCta.href}
            target={overlay.secondaryCta.external ? "_blank" : undefined}
            rel={overlay.secondaryCta.external ? "noopener noreferrer" : undefined}
            variant="outlined"
            startIcon={overlay.secondaryIcon ?? <GavelIcon />}
            sx={{
              borderColor: rgba(GOLD, 0.5),
              color: GOLD_LIGHT,
              fontWeight: 700,
              textTransform: "none",
              borderRadius: "12px",
              px: 2.5,
              py: 1.1,
              bgcolor: "rgba(15,23,42,0.9)",
              backdropFilter: "blur(12px)",
              boxShadow: "0 10px 25px rgba(0,0,0,0.35)",
              transition: "transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease",
              "&:hover": {
                borderColor: GOLD_MID,
                bgcolor: "rgba(30,41,59,0.9)",
                boxShadow: `0 10px 25px rgba(0,0,0,0.35), 0 0 20px ${rgba(GOLD, 0.2)}`,
                transform: "scale(1.05)",
              },
              "&:active": { transform: "scale(0.95)" },
            }}
          >
            {overlay.secondaryCta.label}
          </Button>
        </Box>
      </Box>
    </Box>
  );
}

export default function Carousel() {
  const swiperRef = useRef<SwiperCore | null>(null);

  return (
    <Box sx={{ width: "100%", overflow: "hidden" }}>
      <Swiper
        className="custom-carousel"
        onSwiper={(swiper) => (swiperRef.current = swiper)}
        modules={[Navigation, Pagination, Autoplay]}
        grabCursor={true}
        centeredSlides={true}
        loop={true}
        spaceBetween={30} // Consistent gap
        slidesPerView={"auto"}
        speed={1500} // Much slower, smoother slide transition
        autoplay={{
          delay: 3000,
          disableOnInteraction: false,
          pauseOnMouseEnter: true,
        }}
        pagination={{ clickable: true }}
      >
        {items.map((item, index) => (
          <SwiperSlide key={index} className="custom-slide">
            {item.overlay ? (
              <SlideOverlayCard image={item.image} overlay={item.overlay} priority={index === 0} />
            ) : (
              <Box sx={{ position: "relative", height: "100%", width: "100%", borderRadius: "12px", overflow: "hidden" }}>
                <Image
                  src={item.image}
                  alt=""
                  fill
                  sizes="(min-width: 1200px) 978px, 622px"
                  quality={60}
                  style={{ objectFit: "cover" }}
                  priority={index === 0}
                />
              </Box>
            )}
          </SwiperSlide>
        ))}
      </Swiper>
    </Box>
  );
}
