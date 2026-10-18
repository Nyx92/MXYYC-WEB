// In-memory fake of the Stripe SDK surface the routes use. PaymentIntents are
// registered per test with registerPI() and move through real-ish states, so
// capture/cancel/retrieve answer the way Stripe would after earlier calls.
import { vi } from "vitest";

type FakePI = { id: string; status: string; amount: number; metadata: Record<string, string> };

const pis = new Map<string, FakePI>();
let seq = 0;

function stateError() {
  return Object.assign(new Error("PaymentIntent is in an unexpected state"), {
    code: "payment_intent_unexpected_state",
  });
}

export function registerPI(pi: { id: string; amount: number; metadata: Record<string, string>; status?: string }) {
  pis.set(pi.id, { status: "requires_capture", ...pi });
  return pi.id;
}

export function piStatus(id: string) {
  return pis.get(id)?.status;
}

export const stripe = {
  checkout: { sessions: { create: vi.fn() } },
  paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
  refunds: { create: vi.fn() },
  // Signature checking is Stripe's job; the test body IS the event.
  webhooks: { constructEvent: vi.fn() },
};

export function resetStripe() {
  pis.clear();
  stripe.checkout.sessions.create.mockReset().mockImplementation(async () => {
    const id = `cs_test_${++seq}`;
    return { id, url: `https://checkout.stripe.test/${id}` };
  });
  stripe.paymentIntents.retrieve.mockReset().mockImplementation(async (id: string) => {
    const pi = pis.get(id);
    if (!pi) throw Object.assign(new Error(`No such payment_intent: ${id}`), { code: "resource_missing" });
    return { ...pi };
  });
  stripe.paymentIntents.capture.mockReset().mockImplementation(async (id: string) => {
    const pi = pis.get(id);
    if (!pi || pi.status !== "requires_capture") throw stateError();
    pi.status = "succeeded";
    return { ...pi };
  });
  stripe.paymentIntents.cancel.mockReset().mockImplementation(async (id: string) => {
    const pi = pis.get(id);
    if (!pi || pi.status === "succeeded" || pi.status === "canceled") throw stateError();
    pi.status = "canceled";
    return { ...pi };
  });
  stripe.refunds.create.mockReset().mockImplementation(async (args: { payment_intent: string }) => ({
    id: `re_test_${++seq}`,
    ...args,
  }));
  stripe.webhooks.constructEvent.mockReset().mockImplementation((body: string) => JSON.parse(body));
}

export const refundedPIs = () => stripe.refunds.create.mock.calls.map((c) => c[0].payment_intent as string);
export const cancelledPIs = () => stripe.paymentIntents.cancel.mock.calls.map((c) => c[0] as string);
