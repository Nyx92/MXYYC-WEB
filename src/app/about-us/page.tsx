import type { Metadata } from "next";
import LegalPage from "@/app/shared-components/legal/LegalPage";

export const metadata: Metadata = {
  title: "About Us",
  alternates: { canonical: "/about-us" },
  description:
    "MXYYC is a Singapore trading card store and marketplace for Pokémon and Riftbound cards — Japanese and English singles, live auctions, and secure checkout.",
};

export default function AboutPage() {
  return (
    <LegalPage title="About MXYYC">
      <p>
        MXYYC is a Singapore-based trading card store and community
        marketplace for Pokémon and Riftbound cards. The MXYYC Online TCG
        Store gives players and collectors one trusted place to buy, sell,
        and bid on cards.
      </p>

      <h2>What you can do here</h2>
      <ul>
        <li>
          <a href="/marketplace">Shop the marketplace</a> for Japanese and
          English singles.
        </li>
        <li>
          <a href="/auctions">Bid in live auctions</a> — your card is only
          charged if your bid wins.
        </li>
        <li>
          List cards from your own collection and sell them to other
          collectors.
        </li>
      </ul>

      <h2>Why buy with us</h2>
      <ul>
        <li>
          <strong>Verified buyers:</strong> every buyer confirms their email
          and phone number before they can purchase, make offers, or bid.
        </li>
        <li>
          <strong>Secure payments:</strong> checkout runs on Stripe — we
          never see or store your card details.
        </li>
        <li>
          <strong>Clear policies:</strong> read our{" "}
          <a href="/refund-policy">Refund &amp; Dispute Policy</a>,{" "}
          <a href="/terms">Terms of Service</a>, and{" "}
          <a href="/privacy">Privacy Policy</a>.
        </li>
      </ul>

      <h2>Get in touch</h2>
      <p>
        Questions about a card, an order, or selling with us?{" "}
        <a href="/contact-us">Contact us</a> — we&rsquo;re happy to help.
      </p>

      {/* Site credit — same wording and placement as the other WaveSEO-built sites. */}
      <div style={{ borderTop: "1px solid #e5e7eb", marginTop: 40 }}>
        <h2>About this website</h2>
        <p>
          Our website was designed and built by{" "}
          <a href="https://waveseo.co" target="_blank" rel="noopener">
            WaveSEO
          </a>
          , a team that builds websites and grows businesses online. They
          helped us bring our card marketplace, live auctions, and secure
          checkout together in one place.
        </p>
      </div>
    </LegalPage>
  );
}
