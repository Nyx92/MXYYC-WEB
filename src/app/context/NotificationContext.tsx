"use client";
/**
 * NotificationContext — provides the unread notification count to the whole app.
 *
 * Connects to GET /api/notifications/stream (SSE) once the user is logged in.
 * The stream pushes { unreadCount } every 5 seconds so the navbar bell badge
 * updates in near-real-time without the client making repeated requests.
 *
 * EventSource auto-reconnects on connection drop (e.g. Vercel timeout), so
 * the badge always reflects the latest count shortly after reconnect. A
 * non-200 response (e.g. 429 when rate limited) closes it for good instead,
 * so that case reconnects manually with backoff (30s doubling to 5min).
 *
 * refresh() forces an immediate reconnect — call it after marking notifications
 * as read so the badge clears without waiting for the next 5-second tick.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  startTransition,
} from "react";
import { useAuth } from "@/app/hooks/useAuth";

interface NotificationContextValue {
  unreadCount: number;
  refresh: () => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  unreadCount: 0,
  refresh: () => {},
});

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext);
}

const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoggedIn } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  // Incrementing this key tears down and recreates the EventSource,
  // which triggers an immediate fresh count from the server.
  const [streamKey, setStreamKey] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(RETRY_MIN_MS);

  useEffect(() => {
    // Close any existing connection first (covers login/logout transitions)
    esRef.current?.close();

    // When logged out, `unreadCount` is masked to 0 below (derived at render)
    // instead of resetting the state here — avoids a synchronous
    // setState-in-effect while keeping the same displayed value.
    if (!isLoggedIn) {
      return;
    }

    const es = new EventSource("/api/notifications/stream");
    esRef.current = es;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    es.onmessage = (e: MessageEvent) => {
      retryDelayRef.current = RETRY_MIN_MS;
      try {
        const data = JSON.parse(e.data) as { unreadCount: number };
        // Wrapped in startTransition — this provider wraps every page and
        // ticks every 5s for as long as the user is logged in, so an
        // ordinary setState here can repeatedly win the scheduler over a
        // pending route-change transition, indefinitely delaying
        // navigation. See the same fix + rationale in HomeFeatured.tsx.
        startTransition(() => setUnreadCount(data.unreadCount));
      } catch {
        // Malformed message — ignore.
      }
    };

    // onerror fires on connection drop. EventSource retries automatically
    // unless the server answered with a non-200 (readyState CLOSED) — then
    // nothing retries, so schedule a reconnect ourselves with backoff.
    es.onerror = () => {
      if (es.readyState !== EventSource.CLOSED) {
        console.warn("[notifications] SSE connection error — will auto-reconnect.");
        return;
      }
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
      console.warn(`[notifications] SSE closed — reconnecting in ${delay / 1000}s.`);
      retryTimer = setTimeout(() => setStreamKey((k) => k + 1), delay);
    };

    return () => {
      clearTimeout(retryTimer);
      es.close();
    };
  // streamKey is intentionally included so refresh() restarts the connection.
  }, [isLoggedIn, streamKey]);

  // Tears down and recreates the SSE connection so the server sends a fresh
  // count immediately rather than waiting for the next 5-second tick.
  const refresh = useCallback(() => setStreamKey((k) => k + 1), []);

  return (
    <NotificationContext.Provider
      value={{ unreadCount: isLoggedIn ? unreadCount : 0, refresh }}
    >
      {children}
    </NotificationContext.Provider>
  );
}
