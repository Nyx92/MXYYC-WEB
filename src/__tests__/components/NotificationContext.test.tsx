import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@/app/hooks/useAuth", () => ({ useAuth: () => ({ isLoggedIn: true }) }));

import { NotificationProvider, useNotifications } from "@/app/context/NotificationContext";

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = MockEventSource.OPEN;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = MockEventSource.CLOSED; });
  constructor(public url: string) { MockEventSource.instances.push(this); }
}

function Badge() {
  return <span data-testid="count">{useNotifications().unreadCount}</span>;
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", MockEventSource);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("NotificationProvider", () => {
  it("reconnects with backoff after the stream closes on error", () => {
    render(<NotificationProvider><Badge /></NotificationProvider>);
    expect(MockEventSource.instances).toHaveLength(1);
    const first = MockEventSource.instances[0];
    expect(first.url).toBe("/api/notifications/stream");

    // Server answered non-200 → browser marks it CLOSED and won't retry itself.
    first.readyState = MockEventSource.CLOSED;
    act(() => first.onerror!());
    act(() => vi.advanceTimersByTime(29_999));
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(2);

    // Second failure doubles the delay to 60s.
    const second = MockEventSource.instances[1];
    second.readyState = MockEventSource.CLOSED;
    act(() => second.onerror!());
    act(() => vi.advanceTimersByTime(59_999));
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(3);
  });

  it("does not schedule a reconnect for a transient error (browser auto-retries)", () => {
    render(<NotificationProvider><Badge /></NotificationProvider>);
    const es = MockEventSource.instances[0];
    es.readyState = MockEventSource.CONNECTING;
    act(() => es.onerror!());
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("updates the unread count from stream messages", () => {
    render(<NotificationProvider><Badge /></NotificationProvider>);
    act(() => MockEventSource.instances[0].onmessage!({ data: JSON.stringify({ unreadCount: 4 }) } as MessageEvent));
    expect(screen.getByTestId("count").textContent).toBe("4");
  });
});
