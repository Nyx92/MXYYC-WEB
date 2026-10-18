// CSS-only entrance animation for the home page. It runs as soon as the
// server HTML is painted. The framer-motion version it replaces started
// every element at opacity 0 until the JavaScript loaded, which hid the
// whole feed for 2-3 s on a first visit.
export function fadeUpSx(delaySeconds = 0) {
  return {
    "@keyframes homeFadeUp": {
      from: { opacity: 0, transform: "translateY(16px)" },
      to: { opacity: 1, transform: "none" },
    },
    animation: `homeFadeUp 0.4s ease-out ${delaySeconds}s both`,
    "@media (prefers-reduced-motion: reduce)": { animation: "none" },
  };
}
