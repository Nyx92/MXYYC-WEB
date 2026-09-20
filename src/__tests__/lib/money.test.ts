import { describe, it, expect } from "vitest";
import { dollarsToCents, centsToDollars, formatPrice } from "@/lib/money";

/**
 * money.test.ts — unit tests for the price conversion utilities.
 *
 * These are the simplest tests in the suite — no mocks, no fakes, no vi.hoisted.
 * dollarsToCents and centsToDollars are pure functions: number in, number out.
 * They touch no database or external service so there is nothing to mock.
 *
 * Why these matter: every price that goes into Stripe and Prisma passes through
 * dollarsToCents first. A silent bug here corrupts every transaction amount.
 */

// ── dollarsToCents ────────────────────────────────────────────────────────────
// What's being tested: does your code correctly convert a dollar amount into
// the smallest currency unit (cents) that Stripe and Prisma expect?
// All prices in the DB and in Stripe are stored as integers in cents.

describe("dollarsToCents", () => {
  it("converts whole dollars", () => {
    expect(dollarsToCents(10)).toBe(1000);
  });

  it("converts decimal dollars correctly", () => {
    expect(dollarsToCents(9.99)).toBe(999);
    expect(dollarsToCents(0.01)).toBe(1);
    expect(dollarsToCents(50.5)).toBe(5050);
  });

  // What's being tested: the Math.round() call inside dollarsToCents.
  //
  // JavaScript floating-point quirk: 1.005 * 100 = 100.50000000000001 (not 100.5).
  // Without Math.round you'd store a fractional cent in the DB — Stripe would
  // reject it and Prisma would save a corrupted value.
  // This test proves Math.round() catches that drift.

  it("rounds to avoid floating-point drift", () => {
    // 1.005 in IEEE 754 is stored as slightly LESS than 1.005, so
    // 1.005 * 100 = 100.49999... — Math.round correctly rounds down to 100
    expect(dollarsToCents(1.005)).toBe(100);
    // 0.001 * 100 = 0.1 in JS — Math.round correctly rounds down to 0
    expect(dollarsToCents(0.001)).toBe(0);
  });

  it("handles zero", () => {
    expect(dollarsToCents(0)).toBe(0);
  });
});

// ── centsToDollars ────────────────────────────────────────────────────────────
// What's being tested: does your code correctly convert cents back to dollars
// for display in the UI? The API returns prices in dollars — the DB stores them
// in cents — so this conversion runs on every offer and order response.

describe("centsToDollars", () => {
  it("converts cents to dollars", () => {
    expect(centsToDollars(1000)).toBe(10);
    expect(centsToDollars(999)).toBe(9.99);
    expect(centsToDollars(1)).toBe(0.01);
  });

  it("handles zero", () => {
    expect(centsToDollars(0)).toBe(0);
  });
});

// ── formatPrice ────────────────────────────────────────────────────────────────
// What's being tested: does your code correctly format a dollar amount for
// display as "S$X.XX", and fall back to a placeholder for null/undefined?

describe("formatPrice", () => {
  it("formats a dollar amount as a S$ string with two decimal places", () => {
    expect(formatPrice(19.99)).toBe("S$19.99");
    expect(formatPrice(5)).toBe("S$5.00");
  });

  it("returns the fallback for null/undefined", () => {
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(undefined)).toBe("—");
  });
});
