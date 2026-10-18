import type { Metadata } from "next";
import { redirect } from "next/navigation";

// Private post-checkout page — robots.ts already disallows /checkout, this
// is defense in depth in case a search engine ever crawls it directly.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function CheckoutSuccessPage(
  props: {
    searchParams: Promise<{ session_id?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const sessionId = searchParams.session_id;
  // No session id — redirect to transactions page with success banner
  if (!sessionId) redirect("/purchases?success=1");

  // Redirect to the Purchases tab of Transaction History with:
  //   - success=1 → shows the success banner
  //   - session_id → available for future use (e.g. highlighting the specific order)
  // No Stripe lookup here: this page needs no login, so a retrieve on any
  // supplied id was an unauthenticated, unthrottled Stripe API call. The
  // id is only echoed back, and /api/orders?sessionId is scoped to the buyer.
  redirect(`/purchases?success=1&session_id=${encodeURIComponent(sessionId)}`);
}
