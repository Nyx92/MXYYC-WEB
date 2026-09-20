// instrumentation-client.ts
//
// Next.js's client-side instrumentation hook — executes in the browser
// before React hydrates (https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation-client).

import * as Sentry from "@sentry/nextjs";

// NEXT_PUBLIC_VERCEL_ENV mirrors the server-only VERCEL_ENV for the
// browser bundle — only set on Vercel, never during local `pnpm dev`, so
// a visitor's local dev session never reports here either.
if (process.env.NEXT_PUBLIC_VERCEL_ENV) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV,
    tracesSampleRate: 1.0,
    // Mirrors sentry.server.config.ts's beforeSend, but the browser can't
    // hold DISCORD_ALERTS_WEBHOOK_URL (it'd ship in the public bundle),
    // so this relays through /api/internal/log-error instead, which posts to
    // Discord server-side. Fire-and-forget with keepalive so the request
    // survives a page unload right after the error; never blocks the event
    // from still reaching Sentry.
    beforeSend(event) {
      try {
        const message =
          event.exception?.values?.[0]?.value ??
          event.message ??
          "Unknown error";
        fetch("/api/internal/log-error", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            message,
            environment: event.environment ?? "unknown",
            url: event.request?.url ?? window.location.href,
          }),
        }).catch(() => {});
      } catch {
        // Never block the event over a reporting failure.
      }
      return event;
    },
  });
}

// Tags each Sentry event with the route the visitor navigated to, so an
// error report shows what page they were on.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
