import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReceivedOfferRow } from "@/app/shared-components/transaction-cards";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));

import { ReceivedOfferCard } from "@/app/shared-components/transaction-cards";

const fetchMock = vi.fn();

const offer: ReceivedOfferRow = {
  id: "off1",
  price: 9.5,
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  card: { id: "card1", title: "Mew", imageUrls: [], condition: "NM" },
};

function res(body: unknown, status: number) {
  return Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
}

function renderCard() {
  const onRespond = vi.fn();
  const onStale = vi.fn();
  render(<ReceivedOfferCard offer={offer} onRespond={onRespond} onStale={onStale} />);
  return { onRespond, onStale };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ReceivedOfferCard", () => {
  it("Accept: PATCHes once and calls onRespond on success", async () => {
    fetchMock.mockReturnValue(res({}, 200));
    const { onRespond, onStale } = renderCard();
    const accept = screen.getByRole("button", { name: "Accept" });
    fireEvent.click(accept);
    fireEvent.click(accept);

    await waitFor(() => expect(onRespond).toHaveBeenCalledWith("off1", "accept"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/offers/off1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "accept" }) }));
    expect(onStale).not.toHaveBeenCalled();
  });

  it("Accept 409: shows the server error and calls onStale", async () => {
    fetchMock.mockReturnValue(res({ error: "This offer has expired." }, 409));
    const { onRespond, onStale } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    await screen.findByText("This offer has expired.");
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it("Decline 500: shows the server error without calling onStale", async () => {
    fetchMock.mockReturnValue(res({ error: "Stripe cancel failed" }, 500));
    const { onRespond, onStale } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));

    await screen.findByText("Stripe cancel failed");
    expect(onStale).not.toHaveBeenCalled();
    expect(onRespond).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Decline" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
