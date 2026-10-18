"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, type SxProps, type Theme } from "@mui/material";
import { fadeInSx, type FadeIn } from "@/app/utils/fadeIn";

// Same behavior as framer-motion's `whileInView` with `viewport={{ once: true }}`,
// without hiding server-rendered content before the JavaScript loads:
// - In the server HTML the element is visible and plays the CSS load fade.
// - When the JavaScript starts, an element that is NOT on screen yet is
//   hidden (it is off screen, so nothing visibly flashes), then fades in
//   once when it scrolls into view.
export default function Reveal({
  children,
  sx,
  margin = "0px",
  amount = 0,
  ...fade
}: FadeIn & {
  children: ReactNode;
  sx?: SxProps<Theme>;
  margin?: string; // like framer's viewport.margin
  amount?: number; // like framer's viewport.amount (0-1)
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"load" | "armed" | "shown">("load");

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let reveal: IntersectionObserver | undefined;
    // First check with no margin: any visible pixel means the visitor
    // already saw its load fade, so leave it alone.
    const firstLook = new IntersectionObserver(([entry]) => {
      firstLook.disconnect();
      if (entry.isIntersecting) return;
      setState("armed");
      reveal = new IntersectionObserver(
        ([e]) => {
          if (!e.isIntersecting) return;
          setState("shown");
          reveal?.disconnect();
        },
        { rootMargin: margin, threshold: amount }
      );
      reveal.observe(el);
    });
    firstLook.observe(el);
    return () => {
      firstLook.disconnect();
      reveal?.disconnect();
    };
  }, [margin, amount]);

  const stateSx =
    state === "armed"
      ? { opacity: 0, transform: `translate(${fade.x ?? 0}px, ${fade.y ?? 16}px)`, animation: "none" }
      : fadeInSx(fade); // "load" plays at first paint; "shown" restarts it on scroll

  return (
    <Box ref={ref} sx={[stateSx, ...(Array.isArray(sx) ? sx : [sx])]}>
      {children}
    </Box>
  );
}
