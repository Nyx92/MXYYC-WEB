import type { Metadata } from "next";
import LegalPage from "@/app/shared-components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Terms of Service",
  alternates: { canonical: "/terms" },
  description: "Terms of Service for the MXYYC Online TCG Store.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="13 September 2026">
      <p>
        Welcome to MXYYC Online TCG Store (the &ldquo;Service&rdquo;), a marketplace for
        buying, selling, and auctioning physical Pokémon and Riftbound
        trading cards, operated by MXYYC (&ldquo;MXYYC&rdquo;,
        &ldquo;we&rdquo;, &ldquo;us&rdquo;, or &ldquo;our&rdquo;). By creating
        an account or otherwise using the Service, you agree to these Terms
        of Service (&ldquo;Terms&rdquo;). If you do not agree, please do not
        use the Service.
      </p>

      <h2>1. The Service</h2>
      <p>
        MXYYC Online TCG Store is a platform that lets users list physical trading
        cards for sale, make and accept offers, run and bid in auctions, and
        complete purchases via Stripe. MXYYC does not own, inspect, grade,
        authenticate, or take possession of any card listed on the Service —
        every listing is created and fulfilled by the individual user who
        owns the physical card. MXYYC is not a party to the sale contract
        between a buyer and a seller; we provide the platform that connects
        them and processes payment.
      </p>

      <h2>2. Accounts</h2>
      <p>
        You must provide accurate information when creating an account and
        are responsible for keeping your login credentials secure and for
        all activity under your account. You must be legally capable of
        entering into binding contracts in your jurisdiction to use the
        Service.
      </p>

      <h2>3. Listings, Offers, and Auctions</h2>
      <p>
        Sellers are solely responsible for the accuracy of their listings,
        including the card&rsquo;s identity, condition/grade, and photos.
        Placing a bid in an auction, submitting an offer, or completing a
        &ldquo;Buy Now&rdquo; purchase is a binding commitment to buy at that
        price if accepted or if the auction closes in your favor. Sellers
        who accept an offer or whose auction closes with a winning bid are
        committing to sell and ship the listed card to that buyer.
      </p>

      <h2>4. Payments</h2>
      <p>
        All payments are processed by Stripe. MXYYC does not store your
        full card/payment details. Prices on the Service are shown in
        Singapore dollars (SGD) unless stated otherwise.
      </p>

      <h2>5. Refunds and Disputes</h2>
      <p>
        Please see our{" "}
        <a href="/refund-policy">Refund &amp; Dispute Policy</a> for how
        refunds and buyer/seller disputes are handled.
      </p>

      <h2>6. Prohibited Conduct</h2>
      <p>You agree not to:</p>
      <ul>
        <li>List counterfeit, stolen, or misrepresented cards;</li>
        <li>
          Manipulate bidding (e.g. shill bidding, colluding with other
          users to inflate or suppress prices);
        </li>
        <li>
          Use the Service for money laundering or any unlawful purpose;
        </li>
        <li>
          Attempt to circumvent, disable, or otherwise interfere with the
          security or proper functioning of the Service;
        </li>
        <li>
          Harass, defraud, or otherwise harm another user of the Service.
        </li>
      </ul>

      <h2>7. Intellectual Property</h2>
      <p>
        &ldquo;Pokémon&rdquo; and all associated names, characters, and card
        artwork are trademarks and copyrighted works of their respective
        owners (including The Pokémon Company and Nintendo). &ldquo;Riftbound&rdquo;
        and its associated names, characters, and card artwork are
        trademarks and copyrighted works of their respective owner (Riot
        Games). MXYYC is not affiliated with, endorsed by, or sponsored by
        any of these rights holders. Card images displayed on the Service
        are used solely to identify and describe the physical items being
        listed for sale.
      </p>

      <h2>8. Disclaimers and Limitation of Liability</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; without warranties of
        any kind. To the fullest extent permitted by law, MXYYC is not
        liable for disputes between buyers and sellers, the condition,
        authenticity, or timely delivery of any card, or any indirect,
        incidental, or consequential damages arising from your use of the
        Service.
      </p>

      <h2>9. Account Suspension &amp; Termination</h2>
      <p>
        We may suspend or terminate an account that violates these Terms,
        engages in fraudulent activity, or poses a risk to other users or
        the Service.
      </p>

      <h2>10. Changes to These Terms</h2>
      <p>
        We may update these Terms from time to time. Continued use of the
        Service after an update constitutes acceptance of the revised
        Terms.
      </p>

      <h2>11. Governing Law</h2>
      <p>
        These Terms are governed by the laws of Singapore, without regard
        to conflict-of-law principles.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions about these Terms can be sent to{" "}
        <a href="mailto:mxyyc@mxyyc.community">mxyyc@mxyyc.community</a>.
      </p>
    </LegalPage>
  );
}
