// lib/money.ts

/**
 * Converts a dollar amount (e.g. 19.99) into cents (e.g. 1999).
 *
 * WHY:
 * - All monetary values in the database are stored as integers (cents).
 * - This avoids floating point precision issues (e.g. 0.1 + 0.2 problems).
 * - Stripe and most payment systems also require amounts in cents.
 *
 * WHEN TO USE:
 * - Before saving user input into the database.
 * - Before sending amounts to Stripe as `unit_amount`.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/**
 * Converts a cents amount (e.g. 1999) back into dollars (e.g. 19.99).
 *
 * WHY:
 * - The database stores prices in cents for accuracy.
 * - The UI needs prices in dollars for display.
 *
 * IMPORTANT:
 * - This returns a number (not a formatted string).
 * - Formatting (e.g. `.toFixed(2)` or Intl.NumberFormat)
 *   should be done at the UI layer.
 *
 * WHEN TO USE:
 * - When returning data from the API for frontend display.
 */
export function centsToDollars(cents: number): number {
  return cents / 100;
}

/**
 * Formats a dollar amount for display as "S$X.XX". This is the UI-layer
 * formatting `centsToDollars`'s docblock always said belonged here, but
 * never actually provided — every call site had been hand-rolling
 * `S$${dollars.toFixed(2)}` independently, with inconsistent null handling
 * ("—" vs "S$ -" vs no guard at all).
 *
 * Takes DOLLARS, not cents — by the time a value reaches a component, it has
 * already been through `centsToDollars` at the API response boundary.
 *
 * WHEN TO USE:
 * - Any time a dollar amount is rendered directly in JSX as a price string.
 */
/**
 * Converts a USD dollar amount to SGD cents, using the app's configured
 * static FX rate.
 *
 * WHEN TO USE:
 * - Persisting a vendor market price (JustTCG returns USD) as PriceHistory,
 *   which stores everything in SGD cents like the rest of the app's money.
 */
export function usdToSgdCents(usdDollars: number): number {
  const rate = Number(process.env.NEXT_PUBLIC_USD_TO_SGD_RATE ?? "1.29");
  return dollarsToCents(usdDollars * rate);
}

export function formatPrice(dollars: number | null | undefined): string {
  if (dollars == null) return "—";
  return `S$${dollars.toFixed(2)}`;
}
