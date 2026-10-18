import { NextRequest, NextResponse } from "next/server";
import { postErrorAlert } from "@/lib/discord";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

/**
 * POST /api/internal/log-error
 *
 * Relays a browser-captured Sentry error to Discord. The browser can't hold
 * DISCORD_ALERTS_WEBHOOK_URL directly (it would ship in the public JS
 * bundle), so instrumentation-client.ts's Sentry `beforeSend` posts here
 * instead, and this route — running server-side — forwards to Discord.
 *
 * Unauthenticated (any visitor's browser calls it) and posts to an external
 * webhook, so it's rate limited per IP and globally, and postErrorAlert
 * escapes the text, to stop it being used to spam (or phish) the Discord
 * channel or hammer the webhook.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  // Per IP, then a global budget across all callers: the alerts webhook is
  // shared with real server errors and cron results, and Discord rate limits
  // a webhook to ~30 posts/min. The per-IP cap is a fraction of the global
  // one, so no single caller can use the whole browser budget.
  if (
    !checkRateLimit(`log-error:ip:${ip}`, { limit: 3, windowMs: 60 * 1000 }).allowed ||
    !checkRateLimit("log-error:global", { limit: 15, windowMs: 60 * 1000 }).allowed
  ) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await req.json();
    const message = typeof body?.message === "string" ? body.message.slice(0, 4000) : null;
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }
    const environment = typeof body?.environment === "string" ? body.environment : "unknown";
    const url = typeof body?.url === "string" ? body.url : undefined;

    await postErrorAlert({ message, runtime: "browser", environment, url });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/internal/log-error] failed:", err);
    // Reporting failures should never surface as a loud error to the client
    // that's already handling an error — degrade quietly.
    return NextResponse.json({ ok: false });
  }
}
