import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { CardItem } from "@/types/card";
import type { AuctionItem } from "@/types/auction";

const push = vi.fn();
let authUserId = "buyer1";
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "card1" }),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/app/hooks/useAuth", () => ({ useAuth: () => ({ userId: authUserId, isAdmin: false }) }));
vi.mock("@/app/context/WatchlistAnimationContext", () => ({
  useWatchlistAnimation: () => ({ triggerFly: vi.fn(), adjustCount: vi.fn() }),
}));
vi.mock("@/app/context/CartContext", () => ({ useCart: () => ({ addToCart: vi.fn() }) }));
// Heavy / out-of-scope children — the price chart is being changed in parallel.
vi.mock("@/app/shared-components/cards/CardMarketChart", () => ({ default: () => null }));
vi.mock("@/app/shared-components/cards/AllListings", () => ({ default: () => null }));
vi.mock("@/app/shared-components/cards/EditPriceDialog", () => ({ default: () => null }));
vi.mock("@/app/shared-components/cards/PlaceOfferDialog", () => ({ default: () => null }));
vi.mock("@/app/shared-components/cards/SellerOffersDialog", () => ({ default: () => null }));
vi.mock("@/app/cards/[id]/components/AuctionDialog", () => ({ default: () => null }));
vi.mock("@/app/cards/[id]/components/PlaceBidDialog", () => ({ default: () => null }));

import CardDetailClient from "@/app/cards/[id]/CardDetailClient";
import BuyBox from "@/app/shared-components/cards/BuyBox";

const fetchMock = vi.fn();

const card: CardItem = {
  id: "card1", title: "Blastoise", price: 25, condition: "NM", status: "available", forSale: true,
  imageUrls: [], tcgPlayerId: "t1", game: "POKEMON", setName: null, rarity: null, description: null,
  language: "English", cardNumber: null, createdAt: "", updatedAt: "",
  owner: { id: "seller1", username: "seller" },
};

const auction: AuctionItem = {
  id: "auc1", cardId: "card1", sellerId: "seller1", startingBid: 1, reservePrice: null, buyOutPrice: null,
  currentBid: 5, status: "pending_seller_decision",
  endsAt: new Date(Date.now() - 60_000).toISOString(),
  sellerDecisionDeadline: new Date(Date.now() + 3_600_000).toISOString(),
  version: 2, bidCount: 1,
  card: {
    id: "card1", title: "Blastoise", imageUrls: [], condition: "NM", setName: null, language: "English",
    cardNumber: null, rarity: null, tcgPlayerId: "t1", inAuction: true, owner: { id: "seller1", username: "seller" },
  },
};

const res = (body: unknown, status = 200) => ({ ok: status < 300, status, json: () => Promise.resolve(body) });
const calls = (url: string) => fetchMock.mock.calls.filter(([u]) => u === url);

/** Background GETs (listings, offers, auctions) get harmless defaults. */
function route(handler: (url: string) => unknown) {
  fetchMock.mockImplementation((url: string) => {
    const r = handler(url);
    if (r !== undefined) return r;
    if (url.startsWith("/api/auctions?cardId=")) return Promise.resolve(res({ auction }));
    return Promise.resolve(res({}));
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  push.mockReset();
  authUserId = "buyer1";
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CardDetailClient — Buy Now", () => {
  it("double click creates one checkout session; failure shows the error snackbar", async () => {
    let resolveCheckout!: (v: unknown) => void;
    route((url) => (url === "/api/checkout" ? new Promise((r) => { resolveCheckout = r; }) : undefined));
    render(<CardDetailClient initialCard={card} />);

    const buy = screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement;
    fireEvent.click(buy);
    fireEvent.click(buy);
    expect(calls("/api/checkout")).toHaveLength(1);
    expect(buy.disabled).toBe(true);
    expect(JSON.parse(calls("/api/checkout")[0][1].body)).toMatchObject({ cardId: "card1", price: 25, buyerId: "buyer1" });

    await act(async () => { resolveCheckout(res({ error: "Verify your phone number to purchase." }, 403)); });
    await screen.findByText("Verify your phone number to purchase.");
    expect(screen.getByRole("button", { name: "Verify account" })).toBeTruthy();
  });

  // Regression: a rejected checkout (e.g. the 403 verification gate) used to
  // leave Buy Now disabled until reload.
  it("re-enables Buy Now after a non-OK checkout response", async () => {
    route((url) => (url === "/api/checkout" ? Promise.resolve(res({ error: "Nope" }, 403)) : undefined));
    render(<CardDetailClient initialCard={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await screen.findByText("Nope");
    expect((screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a generic error when the checkout request throws", async () => {
    route((url) => (url === "/api/checkout" ? Promise.reject(new Error("offline")) : undefined));
    render(<CardDetailClient initialCard={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await screen.findByText("Failed to start checkout. Please try again.");
    expect(screen.queryByRole("button", { name: "Verify account" })).toBeNull();
    expect((screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("CardDetailClient — reserved by another buyer", () => {
  const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

  it("shows a disabled Reserved button with a tooltip instead of Buy Now", async () => {
    route(() => undefined);
    render(<CardDetailClient initialCard={{ ...card, reservedUntil: inMinutes(10) }} />);

    const reserved = screen.getByRole("button", { name: "Reserved" }) as HTMLButtonElement;
    expect(reserved.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Buy Now" })).toBeNull();
    fireEvent.mouseOver(reserved.parentElement!);
    expect(await screen.findByText(/Another buyer is checking out this card/)).toBeTruthy();
  });

  it("flips back to Buy Now when the hold ends", async () => {
    vi.useFakeTimers();
    try {
      route(() => undefined);
      render(<CardDetailClient initialCard={{ ...card, reservedUntil: inMinutes(5) }} />);
      expect(screen.getByRole("button", { name: "Reserved" })).toBeTruthy();

      await act(async () => { vi.advanceTimersByTime(5 * 60_000 + 10); });

      expect((screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 409 from checkout reloads the card so the button shows Reserved", async () => {
    route((url) => {
      if (url === "/api/checkout") return Promise.resolve(res({ error: "Another buyer is checking out this card right now." }, 409));
      if (url === "/api/cards/card1") return Promise.resolve(res({ card: { ...card, reservedUntil: inMinutes(14) } }));
      return undefined;
    });
    render(<CardDetailClient initialCard={card} />);

    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));

    await screen.findByText("Another buyer is checking out this card right now.");
    expect(await screen.findByRole("button", { name: "Reserved" })).toBeTruthy();
  });
});

describe("CardDetailClient — releasing the viewer's own checkout", () => {
  const cancelCalls = () => calls("/api/checkout/cancel");

  it("closes the viewer's open checkout when they land on the card (back from Stripe, reload)", async () => {
    route(() => undefined);
    render(<CardDetailClient initialCard={{ ...card, reservedByViewer: true }} />);

    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(JSON.parse(cancelCalls()[0][1].body)).toEqual({ cardId: "card1" });
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it("does nothing for a card the viewer isn't checking out", async () => {
    route(() => undefined);
    render(<CardDetailClient initialCard={card} />);
    await act(async () => { await Promise.resolve(); });
    expect(cancelCalls()).toHaveLength(0);
  });

  it("closes the checkout when the back button restores the page from the browser cache", async () => {
    route((url) => (url === "/api/checkout" ? Promise.resolve(res({ url: "https://checkout.stripe.test/cs_1" })) : undefined));
    render(<CardDetailClient initialCard={card} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await waitFor(() => expect(calls("/api/checkout")).toHaveLength(1));
    // Still disabled: the page is "navigating away" to Stripe.
    await waitFor(() => expect((screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement).disabled).toBe(true));

    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });

    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement).disabled).toBe(false)
    );
  });

  it("ignores a cached-page restore when no checkout was started", async () => {
    route(() => undefined);
    render(<CardDetailClient initialCard={card} />);
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect(cancelCalls()).toHaveLength(0);
  });
});

describe("CardDetailClient — auction accept/decline", () => {
  beforeEach(() => { authUserId = "seller1"; });
  const auctionCard = { ...card, inAuction: true };

  it("Accept shows the server error on a non-OK response and does not navigate", async () => {
    route((url) => (url === "/api/auctions/auc1/decide" ? Promise.resolve(res({ error: "Decision window has closed." }, 409)) : undefined));
    render(<CardDetailClient initialCard={auctionCard} />);

    fireEvent.click(await screen.findByRole("button", { name: /^Accept/ }));
    await screen.findByText("Decision window has closed.");
    expect(JSON.parse(calls("/api/auctions/auc1/decide")[0][1].body)).toEqual({ action: "accept" });
    expect(push).not.toHaveBeenCalledWith("/sold");
  });

  it("Decline shows a fallback error when the response has no body", async () => {
    route((url) =>
      url === "/api/auctions/auc1/decide"
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.reject(new SyntaxError("bad json")) })
        : undefined,
    );
    render(<CardDetailClient initialCard={auctionCard} />);

    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await screen.findByText("Failed to decline the bid. Please try again.");
    // Refetches the auction so the BuyBox reflects its real state.
    await waitFor(() => expect(calls("/api/auctions?cardId=card1").length).toBeGreaterThanOrEqual(2));
  });
});

describe("BuyBox", () => {
  it("disables Buy Now while a checkout is pending", () => {
    const onBuyNow = vi.fn();
    fetchMock.mockResolvedValue(res({}));
    render(
      <BuyBox
        tcgPlayerId="t1" currentCardId="card1" currentCondition="NM" currentPrice={25}
        isForSale priceText="S$25.00" primaryBlue="#0053ff"
        onPlaceOffer={vi.fn()} onBuyNow={onBuyNow} buyNowPending
      />,
    );
    const buy = screen.getByRole("button", { name: "Buy Now" }) as HTMLButtonElement;
    expect(buy.disabled).toBe(true);
    fireEvent.click(buy);
    expect(onBuyNow).not.toHaveBeenCalled();
  });
});
