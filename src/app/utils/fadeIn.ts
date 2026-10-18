// CSS-only entrance animation. It runs as soon as the server HTML is
// painted, without JavaScript. Use it for entrance animations on
// server-rendered content: a framer-motion `initial={{ opacity: 0 }}` hides
// that content until the JavaScript loads (2-3 s on a first visit).
// framer-motion stays the tool for animations after load (exit, layout,
// hover, filter changes).

export interface FadeIn {
  delay?: number; // seconds
  duration?: number; // seconds
  x?: number; // start offset, px
  y?: number; // start offset, px
  scale?: number; // start scale
  easing?: string;
}

export function fadeInSx({ delay = 0, duration = 0.4, x = 0, y = 16, scale = 1, easing = "ease-out" }: FadeIn = {}) {
  return {
    "@keyframes mxFadeIn": {
      // No `to`: it animates to the element's own opacity and transform.
      from: { opacity: 0, transform: "translate(var(--fade-x), var(--fade-y)) scale(var(--fade-scale))" },
    },
    "--fade-x": `${x}px`,
    "--fade-y": `${y}px`,
    "--fade-scale": scale,
    animation: `mxFadeIn ${duration}s ${easing} ${delay}s both`,
    "@media (prefers-reduced-motion: reduce)": { animation: "none" },
  };
}

// Overshoot curve, close to framer's spring (stiffness 320, damping 14).
export const SPRING_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
