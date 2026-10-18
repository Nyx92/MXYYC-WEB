import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";

const confirmCardPayment = vi.fn();
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  CardElement: () => <div data-testid="card-element" />,
  useStripe: () => ({ confirmCardPayment }),
  useElements: () => ({ getElement: () => ({}) }),
}));

import PlaceOfferDialog from "@/app/shared-components/cards/PlaceOfferDialog";

const fetchMock = vi.fn();

function res(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

function renderAndContinue(price = "12.34") {
  render(
    <PlaceOfferDialog open cardId="card1" cardTitle="Charizard" listingPrice={20} onClose={vi.fn()} onSuccess={vi.fn()} />,
  );
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: price } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

beforeEach(() => {
  fetchMock.mockReset();
  confirmCardPayment.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("PlaceOfferDialog", () => {
  it("creates the PI, confirms the card, then POSTs the offer exactly once — even on double click", async () => {
    const order: string[] = [];
    let resolvePi!: (v: unknown) => void;
    fetchMock.mockImplementation((url: string) => {
      order.push(url);
      if (url === "/api/offers/payment-intent") return new Promise((r) => { resolvePi = r; });
      return Promise.resolve(res({ amended: false }));
    });
    confirmCardPayment.mockImplementation(() => {
      order.push("confirm");
      return Promise.resolve({ error: undefined });
    });

    renderAndContinue("12.34");
    const submit = screen.getByRole("button", { name: "Submit Offer" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect((screen.getByRole("button", { name: /Submitting/ }) as HTMLButtonElement).disabled).toBe(true);

    resolvePi(res({ clientSecret: "cs_1", paymentIntentId: "pi_1" }));
    await screen.findByText(/Offer placed!/);

    expect(order).toEqual(["/api/offers/payment-intent", "confirm", "/api/offers"]);
    const [, piInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(piInit.body)).toEqual({ cardId: "card1", price: 1234 });
    expect(confirmCardPayment).toHaveBeenCalledWith("cs_1", { payment_method: { card: {} } });
    const [, offerInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(offerInit.body)).toEqual({ cardId: "card1", price: 12.34, message: null, paymentIntentId: "pi_1" });
  });

  it("shows the card error and does not save the offer when authorisation fails", async () => {
    fetchMock.mockResolvedValue(res({ clientSecret: "cs_1", paymentIntentId: "pi_1" }));
    confirmCardPayment.mockResolvedValue({ error: { message: "Your card was declined." } });
    renderAndContinue();
    fireEvent.click(screen.getByRole("button", { name: "Submit Offer" }));

    await screen.findByText("Your card was declined.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the server error from POST /api/offers", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/offers/payment-intent"
          ? res({ clientSecret: "cs_1", paymentIntentId: "pi_1" })
          : res({ error: "Please verify your phone number first." }, 403),
      ),
    );
    confirmCardPayment.mockResolvedValue({ error: undefined });
    renderAndContinue();
    fireEvent.click(screen.getByRole("button", { name: "Submit Offer" }));

    await screen.findByText("Please verify your phone number first.");
    expect(screen.queryByText(/Offer placed!/)).toBeNull();
    expect((screen.getByRole("button", { name: "Submit Offer" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
