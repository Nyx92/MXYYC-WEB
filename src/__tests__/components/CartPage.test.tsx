import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { CartItemData, CartResponse } from "@/types/cart";

const refreshCount = vi.fn();
const decrementCount = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/app/context/CartContext", () => ({ useCart: () => ({ refreshCount, decrementCount }) }));
vi.mock("@/app/shared-components/cards/PlaceOfferDialog", () => ({ default: () => null }));

import CartPage from "@/app/cart/page";

const fetchMock = vi.fn();

function item(id: string): CartItemData {
  return {
    id,
    selected: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    card: {
      id: `card-${id}`, title: `Card ${id}`, price: 10, condition: "NM", imageUrls: [], language: "English",
      setName: null, rarity: null, cardNumber: null, forSale: true, tcgPlayerId: "t",
      owner: { id: "s1", username: "seller", email: "s@example.com" },
    },
  };
}
const cart: CartResponse = {
  packages: [{ sellerId: "s1", sellerName: "seller", items: [item("i1"), item("i2")] }],
  userAddress: null,
};

function deferred() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && (init?.method ?? "GET") === method);

/** Routes GET /api/cart to the fixture; everything else goes to `handler`. */
function route(handler: (url: string, init?: RequestInit) => unknown) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) =>
    url === "/api/cart" && !init?.method ? Promise.resolve(ok(cart)) : handler(url, init),
  );
}

async function renderCart() {
  render(<CartPage />);
  await screen.findByText("Shopping Cart");
}

beforeEach(() => {
  fetchMock.mockReset();
  refreshCount.mockReset();
  decrementCount.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("CartPage", () => {
  it("waits for an in-flight selection PATCH before POST /api/checkout/cart", async () => {
    const patch = deferred();
    route((url) => {
      if (url === "/api/cart/i1") return patch.promise;
      if (url === "/api/checkout/cart") return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: "Stop here" }) });
      throw new Error(`unexpected ${url}`);
    });
    await renderCart();

    fireEvent.click(screen.getAllByRole("checkbox")[1]); // deselect item 1
    expect(calls("PATCH", "/api/cart/i1")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Checkout" }));

    await act(async () => { await Promise.resolve(); });
    expect(calls("POST", "/api/checkout/cart")).toHaveLength(0);
    expect((screen.getByRole("button", { name: /Redirecting/ }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { patch.resolve(ok()); });
    await screen.findByText("Stop here");
    expect(calls("POST", "/api/checkout/cart")).toHaveLength(1);
  });

  it("does not check out if a selection PATCH failed, and shows an error", async () => {
    const patch = deferred();
    route((url) => {
      if (url === "/api/cart/i1") return patch.promise;
      return Promise.resolve(ok({ url: "https://checkout.stripe.test" }));
    });
    await renderCart();

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    fireEvent.click(screen.getByRole("button", { name: "Checkout" }));
    await act(async () => { patch.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }); });

    await screen.findByText(/Couldn't update your selection/);
    expect(calls("POST", "/api/checkout/cart")).toHaveLength(0);
  });

  it("clear cart refreshes the count only after DELETE /api/cart resolves", async () => {
    const del = deferred();
    route((url, init) => {
      if (url === "/api/cart" && init?.method === "DELETE") return del.promise;
      throw new Error(`unexpected ${url}`);
    });
    await renderCart();

    fireEvent.click(screen.getByRole("button", { name: "Clear Cart" }));
    expect(calls("DELETE", "/api/cart")).toHaveLength(1);
    await act(async () => { await Promise.resolve(); });
    expect(refreshCount).not.toHaveBeenCalled();

    await act(async () => { del.resolve(ok()); });
    await waitFor(() => expect(refreshCount).toHaveBeenCalledTimes(1));
  });

  it("puts a removed item back and shows an error when DELETE /api/cart/:id fails", async () => {
    route((url, init) => {
      if (url === "/api/cart/i1" && init?.method === "DELETE") return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      throw new Error(`unexpected ${url}`);
    });
    await renderCart();

    fireEvent.click(screen.getAllByRole("button", { name: /Remove/ })[0]);
    await screen.findByText(/Couldn't remove that item/);
    expect(calls("GET", "/api/cart")).toHaveLength(2); // reloaded from the server
    expect(await screen.findByText("Card i1")).toBeTruthy();
    expect(refreshCount).toHaveBeenCalled();
  });

  it("restores the cart and shows an error when DELETE /api/cart fails", async () => {
    route((url, init) => {
      if (url === "/api/cart" && init?.method === "DELETE") return Promise.reject(new Error("offline"));
      throw new Error(`unexpected ${url}`);
    });
    await renderCart();

    fireEvent.click(screen.getByRole("button", { name: "Clear Cart" }));
    await screen.findByText(/Couldn't clear your cart/);
    expect(await screen.findByText("Card i2")).toBeTruthy();
  });

  it("shows a reserved note on an item another buyer is checking out", async () => {
    const reservedCart: CartResponse = {
      ...cart,
      packages: [{ ...cart.packages[0], items: [{ ...item("i1"), card: { ...item("i1").card, reservedUntil: new Date(Date.now() + 600_000).toISOString() } }] }],
    };
    fetchMock.mockImplementation(() => Promise.resolve(ok(reservedCart)));
    await renderCart();
    expect(screen.getByText(/Reserved — another buyer is checking out/)).toBeTruthy();
  });

  it("closes the buyer's own open checkout when they come back, then shows the freed cart", async () => {
    const held: CartResponse = {
      ...cart,
      packages: [{ ...cart.packages[0], items: [{ ...item("i1"), card: { ...item("i1").card, reservedByViewer: true } }] }],
    };
    let cartGets = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/cart" && !init?.method) return Promise.resolve(ok(++cartGets === 1 ? held : cart));
      if (url === "/api/checkout/cancel") return Promise.resolve(ok({ released: 1, paid: false }));
      throw new Error(`unexpected ${url}`);
    });

    await renderCart();

    expect(calls("POST", "/api/checkout/cancel")).toHaveLength(1);
    expect(cartGets).toBe(2);
    expect(screen.getByText("Card i2")).toBeTruthy();
  });

  it("does not call cancel when the buyer has no open checkout", async () => {
    route((url) => { throw new Error(`unexpected ${url}`); });
    await renderCart();
    expect(calls("POST", "/api/checkout/cancel")).toHaveLength(0);
  });
});
