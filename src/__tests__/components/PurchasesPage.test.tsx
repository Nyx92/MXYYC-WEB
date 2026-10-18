import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import type { ReactNode } from "react";

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => search,
}));
vi.mock("@/app/hooks/useAuth", () => ({ useAuth: () => ({ isLoggedIn: true, status: "authenticated" }) }));
vi.mock("@/app/shared-components/AccountLayout", () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/app/shared-components/AccountLoadingGate", () => ({ default: () => null }));

import PurchasesPage from "@/app/purchases/page";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  // Session orders never reach a terminal state, so the page keeps polling.
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [{ id: "o1", status: "PENDING" }] }) }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pollCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("sessionId="));

describe("PurchasesPage checkout polling", () => {
  it("URL-encodes session_id and stops polling after unmount", async () => {
    search = new URLSearchParams({ success: "1", session_id: "cs_test&x=1 /?" });
    const { unmount } = render(<PurchasesPage />);

    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(pollCalls()).toHaveLength(1);
    expect(pollCalls()[0][0]).toBe(`/api/orders?sessionId=${encodeURIComponent("cs_test&x=1 /?")}`);

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(pollCalls()).toHaveLength(2);

    unmount();
    const total = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock.mock.calls.length).toBe(total);
  });

  it("stops polling after the in-flight request resolves post-unmount", async () => {
    search = new URLSearchParams({ success: "1", session_id: "cs_1" });
    let resolvePoll!: (v: unknown) => void;
    fetchMock.mockImplementation((url: string) =>
      url.includes("sessionId=")
        ? new Promise((r) => { resolvePoll = r; })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ orders: [] }) }),
    );
    const { unmount } = render(<PurchasesPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(pollCalls()).toHaveLength(1);

    unmount();
    resolvePoll({ ok: true, json: () => Promise.resolve({ orders: [{ id: "o1", status: "PENDING" }] }) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollCalls()).toHaveLength(1);
  });
});
