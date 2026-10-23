import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";
import { SITE_URL } from "@/lib/site";

// Defensive cap — this is an MVP-scale catalog today, but a sitemap should
// never grow unbounded even if listing volume takes off unexpectedly.
const MAX_LISTINGS = 5000;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = SITE_URL;

  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, changeFrequency: "daily", priority: 1 },
    { url: `${baseUrl}/marketplace`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${baseUrl}/auctions`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${baseUrl}/about-us`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/contact-us`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${baseUrl}/terms`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${baseUrl}/privacy`, changeFrequency: "yearly", priority: 0.2 },
    { url: `${baseUrl}/refund-policy`, changeFrequency: "yearly", priority: 0.2 },
  ];

  let cardEntries: MetadataRoute.Sitemap = [];
  try {
    // /cards/[id] resolves by Listing.id (see src/app/api/cards/[id]/route.ts),
    // but multiple Listings can point at the same underlying catalog card
    // (pokemonCardId / riftboundCardId) when several sellers list the same
    // card. Ordering by updatedAt desc and deduping by catalog id keeps one
    // representative (most recently updated) listing URL per distinct card,
    // which also gives us the right lastModified for that card.
    const listings = await prisma.listing.findMany({
      where: { forSale: true },
      select: {
        id: true,
        pokemonCardId: true,
        riftboundCardId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_LISTINGS,
    });

    const seenCardIds = new Set<string>();
    cardEntries = listings.reduce<MetadataRoute.Sitemap>((entries, listing) => {
      const cardKey = listing.pokemonCardId ?? listing.riftboundCardId ?? listing.id;
      if (seenCardIds.has(cardKey)) return entries;
      seenCardIds.add(cardKey);

      entries.push({
        url: `${baseUrl}/cards/${listing.id}`,
        lastModified: listing.updatedAt,
        changeFrequency: "daily",
        priority: 0.7,
      });
      return entries;
    }, []);
  } catch (error) {
    // Sitemap generation must not take down the route if the DB is briefly
    // unavailable — fall back to just the static entries.
    console.error("sitemap: failed to load listings", error);
  }

  return [...staticEntries, ...cardEntries];
}
