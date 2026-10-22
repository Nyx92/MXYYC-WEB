import type { Metadata } from "next";
import LegalPage from "@/app/shared-components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Refund & Dispute Policy",
  alternates: { canonical: "/refund-policy" },
  description: "Refund and dispute policy for the MXYYC Online TCG Store.",
};

export default function RefundPolicyPage() {
  return (
    <LegalPage title="Refund & Dispute Policy" lastUpdated="13 September 2026">
      <p>
        MXYYC Online TCG Store is a peer-to-peer marketplace: every purchase is a
        direct transaction between a buyer and a seller, both of whom are
        independent users of the Service. MXYYC facilitates the listing and
        payment process but is not the seller of any card.
      </p>

      <h2>1. All Sales Are Final</h2>
      <p>
        Because each listing is a unique physical item described and
        photographed by its individual seller, all completed purchases —
        whether via &ldquo;Buy Now&rdquo;, an accepted offer, or a won
        auction — are final. MXYYC does not offer refunds or returns for
        buyer&rsquo;s remorse, a change of mind, or because a card&rsquo;s
        market value has changed after purchase.
      </p>

      <h2>2. Before You Buy</h2>
      <p>
        Please review a listing&rsquo;s photos, stated condition/grade, and
        description carefully before placing an offer, bid, or completing a
        purchase. Placing a bid or offer, or completing a &ldquo;Buy
        Now&rdquo; purchase, is a binding commitment to buy at that price.
      </p>

      <h2>3. Disputes Between Buyers and Sellers</h2>
      <p>
        If a card you receive is materially different from its listing (for
        example, a different card than described, or undisclosed damage),
        this is a matter to raise directly with the seller in the first
        instance. MXYYC does not mediate, arbitrate, or guarantee the
        outcome of buyer/seller disputes, and does not process refunds on a
        seller&rsquo;s behalf.
      </p>

      <h2>4. Payment Processing Issues</h2>
      <p>
        If a payment was charged in error, duplicated, or a technical fault
        in the Service caused an incorrect charge, contact us at{" "}
        <a href="mailto:mxyyc@mxyyc.community">mxyyc@mxyyc.community</a> and
        we will look into it. This is distinct from a dispute about the
        card itself, which falls under Section 3 above.
      </p>

      <h2>5. Cancelling Before Completion</h2>
      <p>
        A pending offer can be withdrawn any time before the seller accepts
        it, and its payment authorization hold is released automatically.
        A live auction bid cannot be withdrawn once placed. An accepted
        offer or a won auction is a completed sale under Section 1 above.
      </p>

      <h2>6. Contact</h2>
      <p>
        Questions about this policy can be sent to{" "}
        <a href="mailto:mxyyc@mxyyc.community">mxyyc@mxyyc.community</a>.
      </p>
    </LegalPage>
  );
}
