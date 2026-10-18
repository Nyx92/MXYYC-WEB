import type { Metadata } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { listingCatalogInclude, withListingDisplay, getCardDetailForViewer } from "@/lib/listingDisplay";
import { centsToDollars } from "@/lib/money";
import CardDetailClient from "./CardDetailClient";

// Falls back to localhost only when NEXT_PUBLIC_SITE_URL isn't set (local
// dev) — production deploys must set the real domain so OG/canonical URLs
// aren't emitted as localhost.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

// Server-side only — deliberately independent of the client page's own
// `/api/cards/[id]` fetch. This runs once per request for metadata/JSON-LD
// and must never gate or replace the client component's own data fetching,
// error states (not_found/error), or auth-aware fields.
async function getListingForMetadata(id: string) {
  const listing = await prisma.listing.findUnique({
    where: { id },
    include: listingCatalogInclude,
  });
  if (!listing) return null;
  return withListingDisplay(listing);
}

export async function generateMetadata(
  props: {
    params: Promise<{ id: string }>;
  }
): Promise<Metadata> {
  const params = await props.params;
  const listing = await getListingForMetadata(params.id);

  if (!listing) {
    return {
      title: "Card not found | Pokémon MVP",
      robots: { index: false, follow: false },
    };
  }

  const price = listing.price != null ? centsToDollars(listing.price) : null;
  const priceText = price != null ? `S$${price.toFixed(2)}` : "Not currently for sale";
  const description = `${listing.title} — ${listing.condition} condition. ${priceText}.${
    listing.setName ? ` Set: ${listing.setName}.` : ""
  }`.trim();
  const image = listing.imageUrls?.[0];
  const url = `${SITE_URL}/cards/${params.id}`;

  return {
    title: `${listing.title} | Pokémon MVP`,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: listing.title,
      description,
      url,
      type: "website",
      images: image ? [{ url: image }] : undefined,
    },
    twitter: {
      card: "summary_large_image",
      title: listing.title,
      description,
      images: image ? [image] : undefined,
    },
  };
}

export default async function CardDetailPage(
  props: {
    params: Promise<{ id: string }>;
  }
) {
  const params = await props.params;

  // Fetched once here, server-side, with the exact same shape GET
  // /api/cards/[id] returns (both call getCardDetailForViewer) — passed
  // straight to the client component so the first paint already has the
  // real card, instead of a spinner followed by a client-side fetch for
  // data the server already had. Keyed by id so a client-side navigation to
  // a sibling /cards/[id] remounts it (Next.js would otherwise reuse the
  // instance) and no per-card state — auction, offers, open dialogs — leaks
  // from the previous card.
  const session = await getServerSession(authOptions);
  const card = await getCardDetailForViewer(prisma, params.id, session?.user?.id);

  const jsonLd = card
    ? {
        "@context": "https://schema.org",
        "@type": "Product",
        name: card.title,
        image: card.imageUrls ?? [],
        description: card.description || undefined,
        sku: params.id,
        offers: {
          "@type": "Offer",
          priceCurrency: "SGD",
          price: card.price != null ? card.price.toFixed(2) : "0",
          availability: card.forSale
            ? "https://schema.org/InStock"
            : "https://schema.org/OutOfStock",
          url: `${SITE_URL}/cards/${params.id}`,
        },
      }
    : null;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          // JSON.stringify doesn't escape "<", so a "</script>" inside a
          // catalog title/description (admin- or feed-supplied) would end
          // this tag early. \u003c keeps the JSON identical but inert.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      )}
      <CardDetailClient key={params.id} initialCard={card} />
    </>
  );
}
