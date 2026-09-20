// sentry.edge.config.ts
//
// Edge runtime init, loaded by instrumentation.ts's register() when
// NEXT_RUNTIME === "edge". See sentry.server.config.ts for the Node.js
// runtime's identical setup, and instrumentation-client.ts for the browser.

import * as Sentry from "@sentry/nextjs";
import { postErrorAlert } from "@/lib/discord";

// See sentry.server.config.ts — same reasoning, never active in local dev.
if (process.env.VERCEL_ENV) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.VERCEL_ENV,
    tracesSampleRate: 1.0,
    // See sentry.server.config.ts's beforeSend — same free Discord relay,
    // this runtime's errors just get tagged "edge" instead of "server".
    async beforeSend(event) {
      try {
        const message =
          event.exception?.values?.[0]?.value ??
          event.message ??
          "Unknown error";
        await postErrorAlert({
          message,
          runtime: "edge",
          environment: event.environment ?? "unknown",
          url: event.request?.url,
        });
      } catch (err) {
        console.error("[sentry] beforeSend Discord alert failed:", err);
      }
      return event;
    },
  });
}
