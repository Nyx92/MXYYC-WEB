import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { AuctionItem } from "@/types/auction";

const confirmCardPayment = vi.fn();
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  CardElement: () => <div data-testid="card-element" />,
  useStripe: () => ({ confirmCardPayment }),
  useElements: () => ({ getElement: () => ({}) }),
}));

import PlaceBidDialog from "@/app/cards/[id]/components/PlaceBidDialog";

const fetchMock = vi.fn();

function auction(overrides: Partial<AuctionItem> = {}): AuctionItem {
  return {
    id: "auc1",
    cardId: "card1",
    sellerId: "seller1",
    startingBid: 0.05,
    reservePrice: null,
    buyOutPrice: 1,
    currentBid: 0.14,
    status: "active",
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    sellerDecisionDeadline: null,
    version: 1,
    bidCount: 1,
    card: {
      id: "card1", title: "Pikachu", imageUrls: [], condition: "NM", setName: null,
      language: "English", cardNumber: null, rarity: null, tcgPlayerId: "t1",
      inAuction: true, owner: { id: "seller1", username: "s" },
    },
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

function renderDialog(a = auction()) {
  const onSuccess = vi.fn();
  render(<PlaceBidDialog open auction={a} onClose={vi.fn()} onSuccess={onSuccess} />);
  return { onSuccess };
}

function enterAmount(value: string) {
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

beforeEach(() => {
  fetchMock.mockReset();
  confirmCardPayment.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("PlaceBidDialog", () => {
  it("computes the minimum bid in integer cents: 0.14 current → 0.14 rejected, 0.15 accepted", () => {
    renderDialog();
    enterAmount("0.14");
    expect(screen.getByText("Bid must be at least S$0.15.")).toBeTruthy();
    expect(screen.queryByTestId("card-element")).toBeNull();

    enterAmount("0.15");
    expect(screen.queryByText(/Bid must be at least/)).toBeNull();
    expect(screen.getByTestId("card-element")).toBeTruthy();
  });

  it("uses the starting bid as the minimum when there are no bids yet", () => {
    renderDialog(auction({ currentBid: null, startingBid: 0.3, bidCount: 0 }));
    enterAmount("0.29");
    expect(screen.getByText("Bid must be at least S$0.30.")).toBeTruthy();
    enterAmount("0.30");
    expect(screen.getByTestId("card-element")).toBeTruthy();
  });

  it("disables Place Bid while submitting so a double click places one bid", async () => {
    let resolveIntent!: (v: unknown) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/bid/intent")) return new Promise((r) => { resolveIntent = r; });
      return json({ settled: false });
    });
    confirmCardPayment.mockResolvedValue({ error: undefined });

    renderDialog();
    enterAmount("0.50");
    const submit = screen.getByRole("button", { name: "Place Bid" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    const loadingBtn = screen.getByRole("button", { name: /Placing bid/ }) as HTMLButtonElement;
    expect(loadingBtn.disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveIntent({ ok: true, status: 200, json: () => Promise.resolve({ clientSecret: "cs", paymentIntentId: "pi_1" }) });
    await screen.findByText(/Bid placed!/);

    const bidCalls = fetchMock.mock.calls.filter(([u]) => u === "/api/auctions/auc1/bid");
    expect(bidCalls).toHaveLength(1);
    expect(JSON.parse(bidCalls[0][1].body)).toEqual({ paymentIntentId: "pi_1", amount: 0.5 });
    expect(confirmCardPayment).toHaveBeenCalledTimes(1);
  });

  it("blocks a bid above the buy-out price before any payment step", async () => {
    // auction() has buyOutPrice: 1 — a buy-out bid wins outright, so more
    // would only overcharge the buyer. The server rejects it too.
    renderDialog();
    enterAmount("5"); // stopped at the Continue step

    await screen.findByText("Bid cannot exceed the buy-out price of S$1.00.");
    expect(screen.queryByTestId("card-element")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmCardPayment).not.toHaveBeenCalled();
  });

  it("shows a 409 concurrent-bid error from the bid endpoint", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith("/bid/intent")
        ? json({ clientSecret: "cs", paymentIntentId: "pi_1" })
        : json({ error: "Someone else just bid. Please try again." }, 409),
    );
    confirmCardPayment.mockResolvedValue({ error: undefined });
    const { onSuccess } = renderDialog();
    enterAmount("0.20");
    fireEvent.click(screen.getByRole("button", { name: "Place Bid" }));

    await screen.findByText("Someone else just bid. Please try again.");
    await waitFor(() => expect(onSuccess).not.toHaveBeenCalled());
  });
});
