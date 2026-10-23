import type { Metadata } from "next";
import CheckoutCancelled from "./CheckoutCancelled";

// Stripe Checkout's cancel_url — the buyer clicked back on the Stripe page.
// Same noindex as /checkout/success.
export const metadata: Metadata = {
  title: "Checkout cancelled",
  robots: { index: false, follow: false },
};

export default async function CheckoutCancelPage(props: {
  searchParams: Promise<{ cardId?: string; from?: string }>;
}) {
  const { cardId, from } = await props.searchParams;
  return <CheckoutCancelled cardId={cardId ?? null} fromCart={from === "cart"} />;
}
