import type { Metadata } from "next";
import LegalPage from "@/app/shared-components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy",
  alternates: { canonical: "/privacy" },
  description: "Privacy Policy for the MXYYC Online TCG Store.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="13 September 2026">
      <p>
        This Privacy Policy explains how MXYYC (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;) collects, uses, and protects your information when
        you use MXYYC Online TCG Store (the &ldquo;Service&rdquo;).
      </p>

      <h2>1. Information We Collect</h2>
      <p>We collect the following information:</p>
      <ul>
        <li>
          <strong>Account information:</strong> email address, username,
          and a hashed (never plaintext) password.
        </li>
        <li>
          <strong>Listing content:</strong> card photos and descriptions
          you upload when creating a listing.
        </li>
        <li>
          <strong>Transaction data:</strong> purchases, offers, bids, and
          order history associated with your account.
        </li>
        <li>
          <strong>Payment data:</strong> handled directly by Stripe — we do
          not receive or store your full card number or bank details.
        </li>
        <li>
          <strong>Usage data:</strong> basic technical information (such as
          your IP address) used for security purposes like rate-limiting
          against abuse.
        </li>
      </ul>

      <h2>2. How We Use Your Information</h2>
      <p>We use your information to:</p>
      <ul>
        <li>Operate your account and the marketplace itself;</li>
        <li>Process payments and transfers of card ownership;</li>
        <li>Send transactional notifications (offers, bids, sales, etc.);</li>
        <li>Detect and prevent fraud, abuse, and security incidents.</li>
      </ul>
      <p>We do not sell your personal information to third parties.</p>

      <h2>3. Who We Share Information With</h2>
      <p>
        We share information only with the service providers needed to run
        the Service: <strong>Stripe</strong> (payment processing),{" "}
        <strong>Supabase</strong> (database and image storage), and{" "}
        <strong>Resend</strong> (transactional email delivery). Each of
        these providers only receives the information necessary to perform
        their function.
      </p>

      <h2>4. Cookies &amp; Sessions</h2>
      <p>
        We use a session cookie to keep you signed in. We do not use
        third-party advertising or tracking cookies.
      </p>

      <h2>5. Data Retention</h2>
      <p>
        We retain your account and transaction information for as long as
        your account is active, or as needed to comply with legal
        obligations (e.g. financial record-keeping) and resolve disputes.
      </p>

      <h2>6. Your Rights</h2>
      <p>
        You may request access to, correction of, or deletion of your
        personal information by contacting us at{" "}
        <a href="mailto:mxyyc@mxyyc.community">mxyyc@mxyyc.community</a>.
        Note that we may need to retain certain transaction records even
        after an account deletion request, where required for legal or
        accounting purposes.
      </p>

      <h2>7. Security</h2>
      <p>
        We take reasonable technical measures to protect your information,
        including password hashing, encrypted connections (HTTPS), and
        access controls on our database. No system is completely secure,
        and we cannot guarantee absolute security.
      </p>

      <h2>8. Children&rsquo;s Privacy</h2>
      <p>
        The Service is not directed at children under 18. We do not
        knowingly collect personal information from children under 18.
      </p>

      <h2>9. Changes to This Policy</h2>
      <p>
        We may update this Privacy Policy from time to time. Continued use
        of the Service after an update constitutes acceptance of the
        revised policy.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions about this Privacy Policy can be sent to{" "}
        <a href="mailto:mxyyc@mxyyc.community">mxyyc@mxyyc.community</a>.
      </p>
    </LegalPage>
  );
}
