import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next/image", () => ({ default: () => null }));

import CheckoutCancelled from "@/app/checkout/cancel/CheckoutCancelled";

const fetchMock = vi.fn();
const res = (body: unknown, status = 200) => ({ ok: status < 300, status, json: () => Promise.resolve(body) });
const cancelCalls = () => fetchMock.mock.calls.filter(([u]) => u === "/api/checkout/cancel");

function route(cancel: () => unknown) {
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/checkout/cancel") return cancel();
    if (url === "/api/cards/card1") {
      return Promise.resolve(res({ card: { id: "card1", title: "Venusaur V", price: 40, setName: "Champion's Path", imageUrls: [] } }));
    }
    throw new Error(`unexpected ${url}`);
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("CheckoutCancelled (/checkout/cancel)", () => {
  it("Buy Now: closes that card's checkout, shows the card and links back to it", async () => {
    route(() => Promise.resolve(res({ released: 1, paid: false })));
    render(<CheckoutCancelled cardId="card1" fromCart={false} />);

    expect(screen.getByText("Cancelling your checkout…")).toBeTruthy();
    expect(await screen.findByText("Checkout cancelled")).toBeTruthy();
    expect(screen.getByText(/You haven't been charged\. This card is available again/)).toBeTruthy();
    expect(JSON.parse(cancelCalls()[0][1].body)).toEqual({ cardId: "card1" });
    expect(await screen.findByText("Venusaur V")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to card" }).getAttribute("href")).toBe("/cards/card1");
  });

  it("cart: closes every open checkout and links back to the cart", async () => {
    route(() => Promise.resolve(res({ released: 1, paid: false })));
    render(<CheckoutCancelled cardId={null} fromCart />);

    expect(await screen.findByText(/Your cart items are available again/)).toBeTruthy();
    expect(JSON.parse(cancelCalls()[0][1].body)).toEqual({});
    expect(screen.getByRole("link", { name: "Back to cart" }).getAttribute("href")).toBe("/cart");
  });

  it("tells the buyer when their payment already went through", async () => {
    route(() => Promise.resolve(res({ released: 0, paid: true })));
    render(<CheckoutCancelled cardId="card1" fromCart={false} />);

    expect(await screen.findByText("Your payment already went through")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View purchases" }).getAttribute("href")).toBe("/purchases");
  });

  it("falls back to the 15-minute hold message when the cancel can't run", async () => {
    route(() => Promise.resolve(res({ error: "Not authenticated" }, 401)));
    render(<CheckoutCancelled cardId="card1" fromCart={false} />);

    await waitFor(() => expect(screen.getByText(/held for up to 15 minutes/)).toBeTruthy());
  });
});
