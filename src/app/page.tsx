import HomePage from "./HomePage";
import { getHomeFeatured } from "@/lib/homeFeatured";
import type { FeaturedData } from "./home/HomeFeatured";
import type { Metadata } from "next";
import { SITE_NAME, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

// Tells search engines the brand name and logo (the "site name" shown above
// the result title comes from the WebSite entry).
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "MXYYC",
      url: SITE_URL,
      logo: `${SITE_URL}/icons/icon-512.png`,
      email: "mxyychua@mxyyc.community",
      telephone: "+6592954911",
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      alternateName: "MXYYC",
      url: SITE_URL,
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
  ],
};

// Server-rendered so the feed's card images are in the first HTML and start
// loading at once, instead of after the JavaScript loads and fetches the
// feed. getHomeFeatured is cached for 60s, so this does not query the
// database on every visit.
export const dynamic = "force-dynamic";

export default async function Home() {
  const initialFeatured = await getHomeFeatured().catch((err) => {
    // HomeFeatured fetches it in the browser instead.
    console.error("❌ Home page: could not load the featured feed:", err);
    return null;
  });
  // unstable_cache returns the JSON form (dates as strings) — the same shape
  // GET /api/home/featured sends, which is what FeaturedData describes.
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <HomePage initialFeatured={initialFeatured as unknown as FeaturedData | null} />
    </>
  );
}
