import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * HOW THIS FILE EXECUTES (what Vitest does before a single test runs)
 *
 * When Vitest opens this file it does NOT run it top-to-bottom immediately.
 * It first does a hoisting pass — physically moving certain calls to the top.
 * Here is the actual execution order:
 *
 * 1. vi.hoisted() blocks run first — before imports, before anything else.
 *    This creates mockStripeInstance and mockPrisma so they exist in memory.
 *
 * 2. vi.mock() factories run second — they can safely reference the variables
 *    from step 1 because those already exist. This registers the fakes so that
 *    any module that imports "stripe" or "@/lib/prisma" gets the fake instead.
 *
 * 3. import { expireOffer } runs last — by this point the fakes are already
 *    registered. So when offerExpiry.ts internally imports stripe and prisma,
 *    it receives the mocked versions, not the real ones.
 *
 * If the order were reversed (import before vi.mock), expireOffer would get
 * the real Stripe and the real Prisma and tests would hit live services.
 */

// ── STEP 1: Create the mock objects ──────────────────────────────────────────
// vi.hoisted() moves these to the very top of the file (before imports).
// We define them here so we can reference them in the vi.mock() factories
// below AND in individual tests (to set return values per test).

const mockStripeInstance = vi.hoisted(() => ({
  paymentIntents: {
    cancel: vi.fn(),
    retrieve: vi.fn(), // recoverStuckAcceptedOffer: checks whether the PI was captured
  },
  refunds: {
    create: vi.fn(),   // recoverStuckAcceptedOffer: refunds a captured PI
  },
}));

const mockPrisma = vi.hoisted(() => ({
  offer: {
    updateMany: vi.fn(),
  },
}));

// ── STEP 2: Register the fakes ────────────────────────────────────────────────
// vi.mock() is also hoisted. When any module does `import Stripe from "stripe"`
// or `import { prisma } from "@/lib/prisma"` it will receive these fakes.
// The factory functions return the shape the real module would return.

vi.mock("stripe", () => ({
  // "stripe" exports a class as its default export.
  // vi.fn(() => mockStripeInstance) means: when someone calls `new Stripe(...)`,
  // return mockStripeInstance instead of a real Stripe client.
  default: vi.fn(() => mockStripeInstance),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// ── STEP 3: Import the code under test ───────────────────────────────────────
// This runs after the mocks are in place. When offerExpiry.ts is loaded it
// imports stripe and prisma — both of which are now the fakes from step 2.

import { expireOffer, recoverStuckAcceptedOffer } from "@/lib/offerExpiry";

// ─────────────────────────────────────────────────────────────────────────────

const OFFER = { id: "offer-1", paymentIntentId: "pi_123" };

describe("expireOffer", () => {
  beforeEach(() => {
    // Reset all mock call history before each test so tests don't bleed into
    // each other. Without this, call counts from one test would carry over.
    vi.clearAllMocks();
    // Default: PI cancel succeeds
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
    // Default: DB update succeeds
    mockPrisma.offer.updateMany.mockResolvedValue({
      id: "offer-1",
      status: "expired",
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  // What's being tested: the core job of expireOffer — does your code actually
  // make both required calls when everything goes right?
  //
  // Both fakes are set to succeed in beforeEach, so this is the normal
  // no-errors scenario. We run the real expireOffer function and then check
  // that it did the two things it was supposed to do:
  //   1. Told Stripe to release the hold on the buyer's card (cancel the PI)
  //   2. Told the database to mark the offer as expired
  //
  // mockStripeInstance and mockPrisma record every call made to them — the
  // expect() lines below read those records and assert they match what we expect.

  it("cancels the Stripe PI then marks the offer expired in the DB", async () => {
    // Run the real expireOffer function — this is your actual production code
    await expireOffer(OFFER);

    // Did your code call Stripe's cancel with the correct PI id?
    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith(
      "pi_123"
    );

    // Did your code call Prisma's update with the correct offer id and status?
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer-1", status: "pending" },
      data: { status: "expired" },
    });
  });

  // ── No paymentIntentId ──────────────────────────────────────────────────────
  // What's being tested: the guard `if (offer.paymentIntentId)` in your code.
  //
  // An offer with no PI means there is nothing to cancel on Stripe — calling
  // cancel with null would crash. Your code must skip the Stripe call entirely.
  // But the DB update must still run to clean up the offer record.
  //
  // The key assertion here is .not.toHaveBeenCalled() — mockStripeInstance
  // records whether cancel was ever called. Here we assert it was not.

  it("skips Stripe cancel when paymentIntentId is null, still marks DB expired", async () => {
    // Pass an offer with no PI — simulates a rare case where PI was never saved
    await expireOffer({ id: "offer-1", paymentIntentId: null });

    // Stripe must NOT be called — there is nothing to cancel
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();

    // DB must still be updated — the offer should be marked expired regardless
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer-1", status: "pending" },
      data: { status: "expired" },
    });
  });

  // ── PI already in terminal state ────────────────────────────────────────────
  // What's being tested: the catch block in expireOffer that handles
  // payment_intent_unexpected_state — Stripe's error code meaning "this PI is
  // already cancelled or already captured, nothing left to cancel."
  //
  // In this case the hold on the buyer's card is already gone, so your code
  // should swallow the error and still update the DB. This test confirms that.
  //
  // mockRejectedValue() overrides the beforeEach default — instead of cancel
  // succeeding, mockStripeInstance.paymentIntents.cancel now throws this error.
  // Object.assign builds a fake Stripe error with the exact shape (code property)
  // that your catch block looks for.

  it("swallows payment_intent_unexpected_state and still updates DB", async () => {
    // Build a fake Stripe error — real Stripe errors have a `code` property
    const terminalErr = Object.assign(new Error("already cancelled"), {
      code: "payment_intent_unexpected_state",
    });
    // Override the default: cancel now throws this error instead of succeeding
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(terminalErr);

    // expireOffer must complete without throwing — error was caught and swallowed
    await expect(expireOffer(OFFER)).resolves.not.toThrow();

    // DB update must still run — offer should be marked expired regardless
    expect(mockPrisma.offer.updateMany).toHaveBeenCalled();
  });

  it("refunds a captured PI when it is the call that expires the still-pending offer", async () => {
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(
      Object.assign(new Error("captured"), { code: "payment_intent_unexpected_state" })
    );
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded" });
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });
    await expireOffer(OFFER);
    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: OFFER.paymentIntentId });
  });

  it("does not refund when a concurrent accept already moved the offer out of pending", async () => {
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(
      Object.assign(new Error("captured"), { code: "payment_intent_unexpected_state" })
    );
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded" });
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 0 });
    await expireOffer(OFFER);
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
  });

  // ── Unexpected Stripe error ─────────────────────────────────────────────────
  // What's being tested: the opposite of test 3. This is an error your code
  // does NOT know how to handle safely — network failure, Stripe outage, etc.
  // The PI might still be active and the hold on the buyer's card might still
  // be there, so it is NOT safe to mark the offer expired in the DB.
  //
  // Your code re-throws the error so the offer stays "pending". The cron picks
  // it up on the next run and tries again. This test confirms two things:
  //   1. expireOffer throws (the error is not swallowed)
  //   2. mockPrisma.offer.update is never called (DB not touched)
  //
  // Together, tests 3 and 4 prove your catch block correctly tells the two
  // error types apart — payment_intent_unexpected_state is safe to swallow,
  // everything else must be re-thrown.

  it("re-throws unexpected Stripe errors and skips the DB update", async () => {
    // A different error code — not a terminal state, an actual unexpected failure
    const networkErr = Object.assign(new Error("Network error"), {
      code: "api_connection_error",
    });
    // Override the default: cancel now throws this unexpected error
    mockStripeInstance.paymentIntents.cancel.mockRejectedValue(networkErr);

    // expireOffer must throw — error must NOT be swallowed
    await expect(expireOffer(OFFER)).rejects.toThrow("Network error");

    // DB must NOT be updated — offer stays "pending" so the cron can retry
    expect(mockPrisma.offer.updateMany).not.toHaveBeenCalled();
  });
});

// ── recoverStuckAcceptedOffer ────────────────────────────────────────────────
// An accept that died between its claim and its capture/revert leaves the
// offer "accepted" forever. The cron releases the hold (uncaptured) or refunds
// (captured), then closes the offer — conditionally on still being "accepted".
describe("recoverStuckAcceptedOffer", () => {
  const STUCK = { id: "offer-9", paymentIntentId: "pi_9" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.offer.updateMany.mockResolvedValue({ count: 1 });
    mockStripeInstance.paymentIntents.cancel.mockResolvedValue({});
    mockStripeInstance.refunds.create.mockResolvedValue({});
  });

  it("cancels a requires_capture PI and marks the offer expired", async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: "requires_capture" });

    await recoverStuckAcceptedOffer(STUCK);

    expect(mockStripeInstance.paymentIntents.cancel).toHaveBeenCalledWith("pi_9");
    expect(mockStripeInstance.refunds.create).not.toHaveBeenCalled();
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer-9", status: "accepted" },
      data: { status: "expired" },
    });
  });

  it("refunds a succeeded (captured) PI and marks the offer expired", async () => {
    mockStripeInstance.paymentIntents.retrieve.mockResolvedValue({ status: "succeeded" });

    await recoverStuckAcceptedOffer(STUCK);

    expect(mockStripeInstance.refunds.create).toHaveBeenCalledWith({ payment_intent: "pi_9" });
    expect(mockStripeInstance.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer-9", status: "accepted" },
      data: { status: "expired" },
    });
  });
});
