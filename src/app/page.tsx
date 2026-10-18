import HomePage from "./HomePage";
import { getHomeFeatured } from "@/lib/homeFeatured";
import type { FeaturedData } from "./home/HomeFeatured";

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
  return <HomePage initialFeatured={initialFeatured as unknown as FeaturedData | null} />;
}
