/**
 * GET /api/notifications/stream
 *
 * Server-Sent Events (SSE) endpoint. The client connects once on page load
 * and receives a stream of unread-count updates without polling.
 *
 * ── How it works ─────────────────────────────────────────────────────────────
 * 1. On connect: immediately send the current unread count.
 * 2. Every 5 seconds: query the DB and push the latest count.
 * 3. On disconnect (req.signal "abort"): clear the interval and close the stream.
 *
 * ── Vercel / serverless note ─────────────────────────────────────────────────
 * Serverless functions have a response timeout (10–60 s depending on plan).
 * When the connection is cut by the platform, the browser's EventSource
 * automatically reconnects — on reconnect it gets a fresh count immediately.
 * This gives near-real-time updates with no WebSocket complexity.
 *
 * Heartbeat comments (":\n\n") are sent every 15 s to keep proxies and load
 * balancers from closing idle connections before the data tick fires.
 */

import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const POLL_INTERVAL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = session.user.id;

  // 🔒 Each open stream runs a DB count every 5 s against a small pooled
  // connection budget, so cap how often one account can open streams.
  // Generous enough for several tabs reconnecting after the platform's
  // response timeout. In-memory stopgap (see src/lib/rateLimit.ts).
  if (!checkRateLimit(`notification-stream:${userId}`, { limit: 60, windowMs: 60 * 1000 }).allowed) {
    return new Response("Too many requests", { status: 429 });
  }

  const encoder = new TextEncoder();

  // ── Stream ────────────────────────────────────────────────────────────────
  const stream = new ReadableStream({
    start(controller) {
      // Sends the current unread count as an SSE data event.
      const sendCount = async () => {
        try {
          const count = await prisma.notification.count({
            where: { userId, read: false },
          });
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ unreadCount: count })}\n\n`)
          );
        } catch (err) {
          // DB hiccup — skip this tick, the next one will retry. Still log:
          // a persistently failing DB means the badge silently never
          // updates for this user, and without this nobody would know why.
          console.error("[notifications/stream] Failed to fetch unread count for", userId, err);
        }
      };

      // Send immediately so the badge updates the moment the page loads.
      sendCount();

      const pollInterval = setInterval(sendCount, POLL_INTERVAL_MS);

      // Heartbeat keeps the connection alive through proxies that close idle
      // streams. SSE comment lines (": ...\n\n") are ignored by EventSource.
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // Stream may already be closed — ignore.
        }
      }, HEARTBEAT_INTERVAL_MS);

      // Clean up when the client disconnects or the serverless function times out.
      req.signal.addEventListener("abort", () => {
        clearInterval(pollInterval);
        clearInterval(heartbeatInterval);
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection":    "keep-alive",
      // Disables Nginx/proxy response buffering so events reach the client
      // immediately rather than being held until the buffer fills.
      "X-Accel-Buffering": "no",
    },
  });
}
