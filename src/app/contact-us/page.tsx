import type { Metadata } from "next";
import LegalPage from "@/app/shared-components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Contact Us",
  alternates: { canonical: "/contact-us" },
  description:
    "Contact MXYYC about Pokémon and Riftbound card orders, listings, and collection in Singapore. Email, phone, and address.",
};

// Same details as the site footer (src/app/shared-components/footer/Footer.tsx).
export default function ContactPage() {
  return (
    <LegalPage title="Contact Us">
      <p>
        Have a question about a card, an order, an auction, or selling with
        us? Reach out and we&rsquo;ll get back to you as soon as we can.
      </p>

      <h2>Email</h2>
      <p>
        <a href="mailto:mxyychua@mxyyc.community">mxyychua@mxyyc.community</a>
      </p>

      <h2>Phone</h2>
      <p>
        <a href="tel:+6592954911">+65 9295 4911</a>
      </p>

      <h2>Address</h2>
      <p>22, #08-087 Midview City, Singapore 573969</p>

      <h2>Orders and refunds</h2>
      <p>
        For a problem with an order, please include your order details when
        you contact us, and see our{" "}
        <a href="/refund-policy">Refund &amp; Dispute Policy</a>.
      </p>
    </LegalPage>
  );
}
