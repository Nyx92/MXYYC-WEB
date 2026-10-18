// prisma/seedRiftboundListings.ts
//
// Bulk-creates a mock "for sale" Listing for every RiftboundCardCatalog row
// that doesn't have one yet, to simulate a populated marketplace. This is
// deliberately a SEPARATE script from prisma/seed.ts:
//
//   - seed.ts wipes and reseeds most tables on every run (though never
//     PokemonCardCatalog/RiftboundCardCatalog/PriceHistory — see the
//     comment above its cleanup block) — folding ~1300 external image
//     downloads + Supabase uploads into that would make the fast, frequent
//     local dev-reset loop slow and hit both the source CDN and Supabase
//     storage on every single `pnpm run seed`.
//   - This script only ADDS Listings for catalog rows that don't already
//     have one, so re-running it after a partial failure (or after new
//     cards are added to the catalog) picks up only what's missing.
//
// Run with: pnpm seed:riftbound-listings
// Assumes prisma.riftboundCardCatalog is already populated (run
// `pnpm update-catalog`) and that ash/misty already exist as users (run the
// normal seed first).

import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { dollarsToCents } from "@/lib/money";
import { mapWithConcurrency } from "@/lib/concurrency";
import { uploadImageFromUrl, riftboundImageCachePath } from "@/lib/seedImages";
import { cycleOwnerId, randomDollarsInRange, randomFrom } from "@/lib/seedListingFakers";
import { RAW_GRADES } from "@/constants/grades";

const prisma = new PrismaClient();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const CONCURRENCY = 8;
const PROGRESS_EVERY = 50;
const PRICE_RANGE_DOLLARS = [2, 40] as const;
const OWNER_USERNAMES = ["ashketchum", "misty"];

async function main() {
  const owners = await prisma.user.findMany({
    where: { username: { in: OWNER_USERNAMES } },
    select: { id: true, username: true },
  });
  if (owners.length === 0) {
    throw new Error(
      `No seed users found (looked for ${OWNER_USERNAMES.join(", ")}) — run the normal seed first.`
    );
  }
  const ownerIds = owners.map((u) => u.id);

  const catalog = await prisma.riftboundCardCatalog.findMany();
  if (catalog.length === 0) {
    throw new Error("RiftboundCardCatalog is empty — run the normal seed first.");
  }

  const alreadyListed = await prisma.listing.findMany({
    where: { game: "RIFTBOUND", riftboundCardId: { not: null } },
    select: { riftboundCardId: true },
  });
  const coveredCatalogIds = new Set(alreadyListed.map((l) => l.riftboundCardId));

  const remaining = catalog.filter((c) => !coveredCatalogIds.has(c.id));

  console.log(
    `🌱 ${catalog.length} catalog cards total, ${coveredCatalogIds.size} already listed, seeding ${remaining.length} more...`
  );

  let completed = 0;
  const results = await mapWithConcurrency(remaining, CONCURRENCY, async (card, i) => {
    const imageUrl = await uploadImageFromUrl(
      supabase,
      card.imageUrl,
      `mock/riftbound/${card.riftboundId}.png`,
      riftboundImageCachePath(card.riftboundId)
    );

    await prisma.listing.create({
      data: {
        game: "RIFTBOUND",
        riftboundCardId: card.id,
        price: dollarsToCents(randomDollarsInRange(...PRICE_RANGE_DOLLARS)),
        condition: randomFrom(RAW_GRADES),
        description: `${card.name} from the ${card.setLabel} set.`,
        imageUrls: [imageUrl],
        forSale: true,
        ownerId: cycleOwnerId(i, ownerIds),
      },
    });

    completed++;
    if (completed % PROGRESS_EVERY === 0 || completed === remaining.length) {
      console.log(`  ...${completed}/${remaining.length}`);
    }
  });

  const failures = results.filter((r) => r.status === "rejected");
  console.log(
    `✅ Seeded ${results.length - failures.length}/${remaining.length} Riftbound listings.`
  );
  if (failures.length > 0) {
    console.error(`❌ ${failures.length} card(s) failed — re-run this script to retry them:`);
    for (const f of failures) {
      console.error(`   ${(f.item as { riftboundId: string }).riftboundId}: ${(f.reason as Error)?.message ?? f.reason}`);
    }
    process.exitCode = 1;
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Seeding Riftbound listings failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
