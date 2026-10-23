// This file: is read only by Next.js during build + dev startup
// controls framework features like images, routing, webpack, experimental flags

import { withSentryConfig } from "@sentry/nextjs/config";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // ===== IMAGE OPTIMIZATION SETTINGS =====
  images: {
    // Card images never change in place (each upload gets a new random file
    // name), so keep resized copies for 31 days instead of the 4-hour
    // default: fewer cold-cache misses and fewer Vercel transformations.
    minimumCacheTTL: 2678400,
    // 60 is for the large home carousel images (see Carousell.tsx).
    qualities: [60, 75],
    // remotePatterns is a SECURITY allow-list.
    // next/image will only load external images whose URL matches
    // one of these patterns.
    remotePatterns: [
      {
        // protocol that must match the image URL
        protocol: "https",

        // the exact domain / host name where your images are stored.
        // this is your Supabase project CDN host
        hostname: "oxfclrahdwnlbrszejik.supabase.co",

        // which URL paths under that host are allowed.
        // you can restrict to specific buckets if you want
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },

  // ===== SECURITY HEADERS =====
  // Applied to every route. Kept intentionally permissive in a few spots
  // (script/style 'unsafe-inline', script 'unsafe-eval') because this app
  // relies on:
  //   - MUI/emotion, which injects <style> tags at runtime (breaks under a
  //     strict style-src without 'unsafe-inline')
  //   - Next.js dev-mode HMR / React Fast Refresh, which uses eval
  //   - Next.js's own inline hydration <script> (__NEXT_DATA__)
  // An overly strict CSP that silently breaks Stripe Elements, next/image,
  // or the app's own styling would be worse than no CSP — see the plan doc
  // this was implemented from (docs/superpowers/plans/2026-09-13-pre-launch-hardening.md).
  async headers() {
    const csp = [
      "default-src 'self'",
      // Stripe.js loads its own script + posts to api.stripe.com.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com",
      "style-src 'self' 'unsafe-inline'",
      // Supabase Storage is the only external image host (matches
      // images.remotePatterns above); data:/blob: cover next/image
      // placeholders and any client-side blob previews.
      // tcgdex (Pokémon) and riftcodex's CDN (Riftbound) serve the official
      // catalog card images shown next to scans on /admin/ingest.
      "img-src 'self' data: blob: https://oxfclrahdwnlbrszejik.supabase.co https://assets.tcgdex.net https://cmsassets.rgpub.io",
      // next/font/google self-hosts fonts at build time — no external
      // font-src needed (see src/app/layout.tsx).
      "font-src 'self' data:",
      // Sentry's browser SDK posts error/performance events to this ingest
      // host — without it here, the CSP would silently block every report
      // before it left the browser.
      "connect-src 'self' https://api.stripe.com https://o4511460351475712.ingest.us.sentry.io",
      // Stripe Elements/Checkout render inside iframes from these hosts.
      "frame-src https://js.stripe.com https://hooks.stripe.com",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },

  // ===== REDIRECTS =====
  // permanent → 308, which Google treats like a 301 and passes ranking on.
  async redirects() {
    return [
      // The old pokemon-mvp.vercel.app domain must not compete with the real
      // one in search. /api is left alone: Stripe webhooks and crons may
      // still call that host, and Stripe does not follow redirects.
      {
        source: "/:path((?!api/).*)",
        has: [{ type: "host", value: "pokemon-mvp.vercel.app" }],
        destination: "https://www.mxyyc.community/:path",
        permanent: true,
      },
      // URLs from the old WooCommerce site that Google still has indexed.
      { source: "/product-category/pokemon/:path*", destination: "/marketplace?game=POKEMON", permanent: true },
      { source: "/product-category/:path*", destination: "/marketplace", permanent: true },
      { source: "/product/:path*", destination: "/marketplace", permanent: true },
      { source: "/shop/:path*", destination: "/marketplace", permanent: true },
      { source: "/blog/:path*", destination: "/", permanent: true },
      { source: "/category/:path*", destination: "/", permanent: true },
      { source: "/tag/:path*", destination: "/", permanent: true },
      { source: "/terms-conditions", destination: "/terms", permanent: true },
      { source: "/privacy-policy", destination: "/privacy", permanent: true },
      { source: "/my-account/:path*", destination: "/profile", permanent: true },
    ];
  },

  // You could later add:
  // - env exposure
  // - bundle analyzer
  // - experimental server actions
};

// Wraps the config to upload source maps to Sentry on every production
// build, so a stack trace in Sentry shows this app's real source instead
// of minified bundle code. Purely a build-time step — does not affect
// what ships to the browser or change any of the config above.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Quiets Sentry's own build-log noise outside CI, where it's more likely
  // to be someone actively watching `pnpm dev`'s output.
  silent: !process.env.CI,
  // Uploads a wider set of client source maps for cleaner stack traces —
  // Sentry's own recommended default for this option.
  widenClientFileUpload: true,
});
