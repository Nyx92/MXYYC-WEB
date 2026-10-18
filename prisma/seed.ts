// prisma/seed.ts
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";
import { dollarsToCents } from "@/lib/money";
import { pickTcgPlayerIdOwners } from "@/lib/riftboundCatalog";
import { uploadImageFromUrl, riftboundImageCachePath } from "@/lib/seedImages";
import { compressCardImage, toWebpStoragePath } from "@/lib/imageProcessing";
import riftboundCardsIndex from "./riftbound_cards_index.json";

const prisma = new PrismaClient();

// Shape of each value in riftbound_cards_index.json's "index" map.
interface RiftboundIndexEntry {
  riftbound_id: string;
  name: string;
  set_id: string;
  set_label: string;
  collector_number: number;
  type: string;
  supertype: string | null;
  rarity: string;
  domain: string[];
  energy: number | null;
  might: number | null;
  power: number | null;
  artist: string | null;
  image_url: string;
  tags: string[];
  alternate_art: boolean;
  signature: boolean;
  overnumbered: boolean;
  text_plain: string | null;
  text_flavour: string | null;
  // Not present on every card (~1208/1304) — cards not yet listed on
  // TCGPlayer have no SKU. A small number of entries share one
  // tcgplayer_id — not real physical variants, but a stale duplicate row
  // for the same card (see pickTcgPlayerIdOwners).
  tcgplayer_id: string | null;
  updated_on: string;
}

// Real catalog data pulled from riftcodex.com (see the file's generated_at).
// supertype maps null -> "" since RiftboundCardCatalog.supertype is a
// required column (see src/lib/riftboundCatalog.ts's "" = "no supertype"
// convention). collector_number is numeric in the index; the column is
// String to allow future overnumbered-variant suffixes.
//
// skipDuplicates, since RiftboundCardCatalog is never cleared above — a row
// already present (a previous seed run, or one that survived a db-push-only
// reset) is left untouched rather than erroring on its riftboundId/
// tcgPlayerId unique constraints.
async function seedRiftboundCatalog() {
  const entries = Object.values(riftboundCardsIndex.index) as RiftboundIndexEntry[];

  const tcgPlayerIdOwners = pickTcgPlayerIdOwners(
    entries.map((c) => ({ tcgPlayerId: c.tcgplayer_id, updatedOn: c.updated_on }))
  );

  const { count } = await prisma.riftboundCardCatalog.createMany({
    skipDuplicates: true,
    data: entries.map((c, i) => ({
      riftboundId: c.riftbound_id,
      name: c.name,
      type: c.type,
      supertype: c.supertype ?? "",
      rarity: c.rarity,
      domain: c.domain,
      energy: c.energy,
      might: c.might,
      power: c.power,
      artist: c.artist,
      imageUrl: c.image_url,
      tags: c.tags,
      alternateArt: c.alternate_art,
      signature: c.signature,
      overnumbered: c.overnumbered,
      textPlain: c.text_plain,
      textFlavour: c.text_flavour,
      setId: c.set_id,
      setLabel: c.set_label,
      collectorNumber: String(c.collector_number),
      // Only the most recently updated row in a shared-tcgplayer_id group
      // keeps it, so a tcgPlayerId-based catalog lookup resolves to exactly
      // one row — the other row(s) still get seeded, just without the id.
      tcgPlayerId: tcgPlayerIdOwners.has(i) ? c.tcgplayer_id : null,
    })),
  });
  console.log(
    `✅ Seeded ${count} new Riftbound catalog entries from riftbound_cards_index.json ` +
      `(${entries.length - count} already present, left untouched)`
  );
}

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function uploadMockImage(filename: string): Promise<string> {
  const filePath = path.join(process.cwd(), "public/seed-images", filename);
  const fileBuffer = fs.readFileSync(filePath);
  const compressed = await compressCardImage(fileBuffer);
  const storagePath = toWebpStoragePath(`mock/${filename}`);

  const { data, error } = await supabase.storage
    .from("card-images")
    .upload(storagePath, compressed.buffer, {
      contentType: compressed.contentType,
      upsert: true,
    });

  if (error) throw new Error(`Failed to upload ${filename}: ${error.message}`);

  // Clean up a pre-compression run's original (e.g. mock/foo.png) so the
  // bucket doesn't end up carrying both copies.
  await supabase.storage.from("card-images").remove([`mock/${filename}`]);

  const { data: publicUrl } = supabase.storage
    .from("card-images")
    .getPublicUrl(data.path);

  return publicUrl.publicUrl;
}

async function main() {
  console.log("🚀 Starting database seed...");

  // The admin account's password is a publicly-known literal ("admin") in
  // this file, which is fine for a disposable local/dev DB but would be a
  // real vulnerability if this script were ever run against production (the
  // password is sitting in source control). In production, require an
  // explicit SEED_ADMIN_PASSWORD env var instead of silently falling back to
  // the weak default; dev/test behavior is unchanged (still "admin" unless
  // overridden). Checked before the cleanup below so a refused run never
  // wipes anything first.
  if (process.env.NODE_ENV === "production" && !process.env.SEED_ADMIN_PASSWORD) {
    throw new Error(
      "SEED_ADMIN_PASSWORD must be set to seed the admin account in production " +
        "(refusing to create admin@pokemon.com with the publicly-known default password)."
    );
  }

  // ── Pokémon catalog cards the mock listings below are attached to ──
  // Real rows created by the card catalog import (tcg-index-sync +
  // `pnpm import:catalog-delta`; see README "Card catalog"). The seed never
  // creates catalog rows itself: invented rows would collide with the real
  // cards' unique tcgPlayerIds, and their prices would be wrong. Looked up
  // before the cleanup below, so a missing catalog stops the seed before it
  // deletes anything.
  const POKEMON_SEED_CARDS = {
    charizardVmax: "swsh3-20", // Charizard VMAX — Darkness Ablaze
    venusaurV: "swsh3.5-1", // Venusaur V — Champion's Path
    blastoiseHoloRare: "base1-2", // Blastoise — Base Set
    starmieGxEn: "sm115-14", // Starmie GX — Hidden Fates
    starmieGxJp: "S9a-075", // スターミーV — Battle Region (Japanese)
    psyduck: "pl1-87", // Psyduck — Platinum
    gyaradosVmax: "swsh7-29", // Gyarados VMAX — Evolving Skies
    shuckle: "neo3-51", // Shuckle — Neo Revelation
    psyduckV: "SV2a-054", // コダック — Pokémon Card 151 (Japanese)
    psyduckBaseSet: "base3-53", // Psyduck — Fossil
    gyaradosVmaxVividVoltage: "swsh7-207", // Gyarados VMAX (alt art) — Evolving Skies
  } as const;
  const seedCards = await prisma.pokemonCardCatalog.findMany({
    where: { externalId: { in: Object.values(POKEMON_SEED_CARDS) } },
  });
  const seedCardByExternalId = new Map(seedCards.map((c) => [c.externalId, c]));
  const missingSeedCards = Object.values(POKEMON_SEED_CARDS).filter((id) => !seedCardByExternalId.has(id));
  if (missingSeedCards.length > 0) {
    throw new Error(
      `The Pokémon card catalog must be imported before seeding (missing: ${missingSeedCards.join(", ")}). ` +
        `See README "Card catalog".`
    );
  }
  const pokemonCatalog = Object.fromEntries(
    Object.entries(POKEMON_SEED_CARDS).map(([key, externalId]) => [key, seedCardByExternalId.get(externalId)!])
  ) as Record<keyof typeof POKEMON_SEED_CARDS, (typeof seedCards)[number]>;

  // ✅ Clean up (child tables first)
  // Bid references Auction
  await prisma.bid.deleteMany();
  // CardTransaction references Order/Listing/User
  await prisma.cardTransaction.deleteMany();
  // Offer references Listing/User
  await prisma.offer.deleteMany();
  // Order references Listing/User
  await prisma.order.deleteMany();
  // Auction references Listing/User
  await prisma.auction.deleteMany();
  // Listing references User/catalog tables
  await prisma.listing.deleteMany();
  // CollectionRequest references User with onDelete: Restrict (pickup history
  // is never removed as a side effect), so clear it before users.
  await prisma.collectionRequest.deleteMany();
  // PokemonCardCatalog and RiftboundCardCatalog are deliberately NEVER
  // cleared here — unlike everything else in this function, they can hold
  // real imported data (card images, JustTCG price-backfill progress) that
  // takes real time/API budget to rebuild. upsertPokemonCard() and
  // seedRiftboundCatalog() below upsert/skip-duplicate instead of
  // create()/createMany(), so re-running this script is still safe with
  // those tables left untouched. script/reset-db.sh protects the same two
  // tables (plus PriceHistory) the same way — see prisma/schema.prisma's
  // db-push step there, which never drops a table that isn't changing.
  // User references Account/Session (if you have these tables populated in dev)
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.user.deleteMany();
  // BestSeller is standalone
  await prisma.bestSeller.deleteMany();
  // VerificationToken (NextAuth email/passwordless flow) is the one table
  // with no relation to User/Listing at all, so nothing above cascades
  // into it — clear it explicitly or stale tokens accumulate forever.
  await prisma.verificationToken.deleteMany();
  // Hash passwords
  const adminPassword = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || "admin", 10);
  const ashPassword = await bcrypt.hash("123", 10);
  const mistyPassword = await bcrypt.hash("123", 10);

  // Users
  const admin = await prisma.user.create({
    data: {
      firstName: "admin",
      lastName: "admin",
      email: "admin@pokemon.com",
      username: "admin",
      password: adminPassword,
      role: "admin",
      verified: true,
      country: "admin",
      sex: "Male",
      dob: new Date("1990-05-22"),
      address: "admin",
      phoneNumber: "123456789",
    },
  });

  const ash = await prisma.user.create({
    data: {
      firstName: "Ash",
      lastName: "Ketchum",
      email: "ash@pokemon.com",
      username: "ashketchum",
      password: ashPassword,
      role: "user",
      verified: true,
      country: "Japan",
      sex: "Male",
      dob: new Date("1990-05-22"),
      address: "Pallet Town",
      phoneNumber: "123456789",
    },
  });

  const misty = await prisma.user.create({
    data: {
      firstName: "Misty",
      lastName: "Waterflower",
      email: "misty@pokemon.com",
      username: "misty",
      password: mistyPassword,
      role: "user",
      verified: true,
      country: "Japan",
      sex: "Female",
      dob: new Date("1991-08-10"),
      address: "Cerulean City",
      phoneNumber: "987654321",
    },
  });

  console.log(
    "✅ Users created:",
    admin.username,
    ash.username,
    misty.username
  );

  // Upload mock image
  const mockImageUrlOne = await uploadMockImage("charizard_vmax.png");
  const mockImageUrlTwo = await uploadMockImage("venusaur_v.png");
  const mockImageUrlThree = await uploadMockImage("blastoise.png");
  const mockImageUrlFour = await uploadMockImage("starmie_gx.png");
  const mockImageUrlFive = await uploadMockImage("psyduck.png");
  const mockImageUrlSix   = await uploadMockImage("gyarados_vmax.png");
  const mockImageUrlShuckle = await uploadMockImage("shuckle_psa10.png");

  console.log("✅ Uploaded all mock images");

  console.log("✅ Using", Object.keys(pokemonCatalog).length, "real Pokémon catalog cards for mock listings");

  // Ash’s Cards
  // Create listings (use create() so we can capture ids easily)
  const charizard = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.charizardVmax.id,
      price: dollarsToCents(120),
      condition: "Mint",
      description: "A stunning Charizard VMAX with fiery holo effect.",
      imageUrls: [mockImageUrlOne],
      forSale: true,
      ownerId: ash.id,
    },
  });

  await prisma.listing.createMany({
    data: [
      // ── Venusaur V — raw grades ─────────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(120),
        condition: "Near Mint",
        description: "A Grass-type classic with nostalgic artwork.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(90),
        condition: "Lightly Played",
        description: "A Grass-type classic with nostalgic artwork.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(65),
        condition: "Moderately Played",
        description: "A Grass-type classic with nostalgic artwork.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(40),
        condition: "Heavily Played",
        description: "A Grass-type classic with nostalgic artwork.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: null,
        condition: "Damaged",
        description: "A Grass-type classic with nostalgic artwork.",
        imageUrls: [mockImageUrlTwo],
        forSale: false,
        ownerId: ash.id,
      },
      // ── Venusaur V — graded ─────────────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(380),
        condition: "PSA 10",
        description: "PSA 10 Gem Mint — flawless Grass-type classic.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(220),
        condition: "PSA 9",
        description: "PSA 9 Mint — near-perfect Grass-type classic.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.venusaurV.id,
        price: dollarsToCents(290),
        condition: "Beckett 9.5 Gem Mint",
        description: "BGS 9.5 Gem Mint — stunning sub-grade Grass-type classic.",
        imageUrls: [mockImageUrlTwo],
        forSale: true,
        ownerId: ash.id,
      },
      // ── Blastoise Holo Rare — raw grades ────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
        price: dollarsToCents(120),
        condition: "Mint",
        description: "Classic Blastoise with vintage holo from Base Set.",
        imageUrls: [mockImageUrlThree],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
        price: dollarsToCents(100),
        condition: "Near Mint",
        description: "Classic Blastoise with vintage holo from Base Set.",
        imageUrls: [mockImageUrlThree],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
        price: dollarsToCents(50),
        condition: "Heavily Played",
        description: "Classic Blastoise with vintage holo from Base Set.",
        imageUrls: [mockImageUrlThree],
        forSale: true,
        ownerId: ash.id,
      },
      // ── Blastoise Holo Rare — graded ────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
        price: dollarsToCents(480),
        condition: "PSA 8",
        description: "PSA 8 NM-MT — classic Blastoise holo in excellent shape.",
        imageUrls: [mockImageUrlThree],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
        price: dollarsToCents(350),
        condition: "CGC 9 Mint",
        description: "CGC 9 Mint — classic Blastoise holo certified by CGC.",
        imageUrls: [mockImageUrlThree],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
        price: null,
        condition: "SGC 9 Mint",
        description: "SGC 9 Mint — classic Blastoise holo certified by SGC.",
        imageUrls: [mockImageUrlThree],
        forSale: false,
        ownerId: ash.id,
      },
    ],
  });

  // Misty’s Cards 💧
  await prisma.listing.createMany({
    data: [
      // ── Starmie GX — raw grades ─────────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.starmieGxEn.id,
        price: dollarsToCents(60),
        condition: "Mint",
        description: "Misty’s loyal Water-type partner with a dazzling spin attack.",
        imageUrls: [mockImageUrlFour],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.starmieGxEn.id,
        price: dollarsToCents(45),
        condition: "Near Mint",
        description: "Misty’s loyal Water-type partner with a dazzling spin attack.",
        imageUrls: [mockImageUrlFour],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.starmieGxEn.id,
        price: dollarsToCents(28),
        condition: "Lightly Played",
        description: "Misty’s loyal Water-type partner with a dazzling spin attack.",
        imageUrls: [mockImageUrlFour],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.starmieGxEn.id,
        price: null,
        condition: "Damaged",
        description: "Misty’s loyal Water-type partner with a dazzling spin attack.",
        imageUrls: [mockImageUrlFour],
        forSale: false,
        ownerId: misty.id,
      },
      // ── Starmie GX — graded ─────────────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.starmieGxEn.id,
        price: dollarsToCents(180),
        condition: "PSA 9",
        description: "PSA 9 Mint — Misty’s Starmie GX in near-perfect shape.",
        imageUrls: [mockImageUrlFour],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.starmieGxEn.id,
        price: dollarsToCents(140),
        condition: "Beckett 9.5 Gem Mint",
        description: "BGS 9.5 Gem Mint — beautifully graded Starmie GX.",
        imageUrls: [mockImageUrlFour],
        forSale: true,
        ownerId: misty.id,
      },
      // ── Psyduck ─────────────────────────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.psyduck.id,
        price: null,
        condition: "Lightly Played",
        description: "A confused Psyduck that Misty adores.",
        imageUrls: [mockImageUrlFive],
        forSale: false,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.psyduck.id,
        price: dollarsToCents(8),
        condition: "Near Mint",
        description: "A confused Psyduck that Misty adores.",
        imageUrls: [mockImageUrlFive],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.psyduck.id,
        price: dollarsToCents(120),
        condition: "PSA 10",
        description: "PSA 10 Gem Mint — a surprisingly valuable Psyduck.",
        imageUrls: [mockImageUrlFive],
        forSale: true,
        ownerId: misty.id,
      },
      // ── Gyarados VMAX — raw grades ──────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.gyaradosVmax.id,
        price: dollarsToCents(95),
        condition: "Near Mint",
        description: "A mighty Gyarados that dominates Misty’s team.",
        imageUrls: [mockImageUrlSix],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.gyaradosVmax.id,
        price: dollarsToCents(70),
        condition: "Lightly Played",
        description: "A mighty Gyarados that dominates Misty’s team.",
        imageUrls: [mockImageUrlSix],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.gyaradosVmax.id,
        price: dollarsToCents(35),
        condition: "Heavily Played",
        description: "A mighty Gyarados that dominates Misty’s team.",
        imageUrls: [mockImageUrlSix],
        forSale: true,
        ownerId: misty.id,
      },
      // ── Gyarados VMAX — graded ──────────────────────────────────────────────
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.gyaradosVmax.id,
        price: dollarsToCents(320),
        condition: "PSA 10",
        description: "PSA 10 Gem Mint — the apex predator, perfectly graded.",
        imageUrls: [mockImageUrlSix],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.gyaradosVmax.id,
        price: dollarsToCents(210),
        condition: "CGC 9.5 Gem Mint",
        description: "CGC 9.5 Gem Mint — top-tier Gyarados VMAX.",
        imageUrls: [mockImageUrlSix],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.gyaradosVmax.id,
        price: dollarsToCents(175),
        condition: "SGC 9 Mint",
        description: "SGC 9 Mint — certified Gyarados VMAX.",
        imageUrls: [mockImageUrlSix],
        forSale: true,
        ownerId: misty.id,
      },
    ],
  });

  console.log("✅ Listings created for Ash and Misty");

  // ── Extra best-seller listings ─────────────────────────────────────────────
  // Two more listings to fill positions 6 and 7 in the Best Sellers row.
  await prisma.listing.createMany({
    data: [
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.shuckle.id,
        price: dollarsToCents(220),
        condition: "PSA 10",
        description: "PSA 10 Gem Mint — the rarest Shuckle you'll ever see.",
        imageUrls: [mockImageUrlShuckle],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.shuckle.id,
        price: dollarsToCents(90),
        condition: "Near Mint",
        description: "Shuckle from Neo Revelation in great shape.",
        imageUrls: [mockImageUrlShuckle],
        forSale: true,
        ownerId: ash.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.psyduckV.id,
        price: dollarsToCents(55),
        condition: "Mint",
        description: "Psyduck V — a modern staple with confusing energy.",
        imageUrls: [mockImageUrlFive],
        forSale: true,
        ownerId: misty.id,
      },
      {
        game: "POKEMON",
        pokemonCardId: pokemonCatalog.psyduckV.id,
        price: dollarsToCents(40),
        condition: "Near Mint",
        description: "Psyduck V in near-mint condition.",
        imageUrls: [mockImageUrlFive],
        forSale: true,
        ownerId: misty.id,
      },
    ],
  });

  console.log("✅ Extra best-seller listings created");

  // ── Auction cards — 6 cards in live auctions ──────────────────────────────
  // 3 ending soon (within 6h → appear in homepage "Ending Soon" row),
  // 3 ending later (only visible on /auctions page).
  const nowMs = Date.now();
  const mins  = (m: number) => new Date(nowMs + m * 60 * 1000);
  const hours = (h: number) => new Date(nowMs + h * 60 * 60 * 1000);
  const days  = (d: number) => new Date(nowMs + d * 24 * 60 * 60 * 1000);

  const auctionCard1 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.charizardVmax.id,
      price: null,
      condition: "Near Mint",
      description: "Auction-only Charizard VMAX — rare chance to own this fire holo.",
      imageUrls: [mockImageUrlOne],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  const auctionCard2 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
      price: null,
      condition: "Lightly Played",
      description: "Vintage Base Set Blastoise in auction — light play only.",
      imageUrls: [mockImageUrlThree],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  const auctionCard3 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.gyaradosVmax.id,
      price: null,
      condition: "Mint",
      description: "Mint-condition Gyarados VMAX in auction — closing soon.",
      imageUrls: [mockImageUrlSix],
      forSale: false,
      inAuction: true,
      ownerId: misty.id,
    },
  });

  const auctionCard4 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.venusaurV.id,
      price: null,
      condition: "Near Mint",
      description: "Venusaur V — Grass-type powerhouse in a multi-day auction.",
      imageUrls: [mockImageUrlTwo],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  const auctionCard5 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.starmieGxJp.id,
      price: null,
      condition: "Mint",
      description: "Starmie GX in a 2-day auction — get your bids in early.",
      imageUrls: [mockImageUrlFour],
      forSale: false,
      inAuction: true,
      ownerId: misty.id,
    },
  });

  const auctionCard6 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.shuckle.id,
      price: null,
      condition: "PSA 10",
      description: "PSA 10 Shuckle in a 3-day auction — a true collector's gem.",
      imageUrls: [mockImageUrlShuckle],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  // ── Quick-expiry test auctions (5 / 6 / 7 / 10 min) ─────────────────────
  // All owned by Ash. Log in as Misty to place bids and test the different paths.
  //
  //  Listing 7  (10 min) — has RP $80, BO $150 → bid below RP → pending_seller_decision
  //  Listing 8  ( 5 min) — no RP, no BO        → let expire untouched → expiredNoBids
  //  Listing 9  ( 6 min) — has RP $50, BO $120 → bid above $50 RP → cron auto-settles
  //  Listing 10 ( 7 min) — has RP $80, no BO   → bid below $80 RP → pending_seller_decision
  const auctionCard7 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.blastoiseHoloRare.id,
      price: null,
      condition: "Mint",
      description: "TEST (10 min) — bid below S$80 RP to trigger pending_seller_decision, or S$150 BO for instant win.",
      imageUrls: [mockImageUrlThree],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  const auctionCard8 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.psyduckBaseSet.id,
      price: null,
      condition: "Near Mint",
      description: "TEST (5 min) — no RP, no BO. Leave it with zero bids and fire the cron to test the expiredNoBids path.",
      imageUrls: [mockImageUrlFive],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  const auctionCard9 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.gyaradosVmaxVividVoltage.id,
      price: null,
      condition: "Near Mint",
      description: "TEST (6 min) — has RP $50, BO $120. Bid above S$50 RP (e.g. S$60) and let it expire — cron should auto-settle without seller action.",
      imageUrls: [mockImageUrlSix],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  const auctionCard10 = await prisma.listing.create({
    data: {
      game: "POKEMON",
      pokemonCardId: pokemonCatalog.starmieGxEn.id,
      price: null,
      condition: "Mint",
      description: "TEST (7 min) — has RP $80, no BO. Bid below S$80 RP (e.g. S$40) and let it expire — cron should move to pending_seller_decision.",
      imageUrls: [mockImageUrlFour],
      forSale: false,
      inAuction: true,
      ownerId: ash.id,
    },
  });

  await prisma.auction.createMany({
    data: [
      // ── Ending soon (≤6 h) — appear in homepage row ───────────────────────
      {
        listingId:    auctionCard1.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(80),
        reservePrice: dollarsToCents(150),
        buyOutPrice:  dollarsToCents(300),
        status:       "active",
        endsAt:       hours(2),
      },
      {
        listingId:    auctionCard2.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(60),
        buyOutPrice:  dollarsToCents(200),
        status:       "active",
        endsAt:       hours(4),
      },
      {
        listingId:    auctionCard3.id,
        sellerId:     misty.id,
        startingBid:  dollarsToCents(50),
        reservePrice: dollarsToCents(100),
        status:       "active",
        endsAt:       hours(5),
      },
      // ── Ending later — only on /auctions page ─────────────────────────────
      {
        listingId:    auctionCard4.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(40),
        reservePrice: dollarsToCents(80),
        buyOutPrice:  dollarsToCents(150),
        status:       "active",
        endsAt:       days(1),
      },
      {
        listingId:    auctionCard5.id,
        sellerId:     misty.id,
        startingBid:  dollarsToCents(30),
        buyOutPrice:  dollarsToCents(120),
        status:       "active",
        endsAt:       days(2),
      },
      {
        listingId:    auctionCard6.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(80),
        reservePrice: dollarsToCents(160),
        status:       "active",
        endsAt:       days(3),
      },
      // ── Quick-expiry test auctions (5–10 min) — all owned by Ash ────────────
      // Card 7 (10 min): bid below S$80 RP → pending_seller_decision, or S$150 BO → instant win
      {
        listingId:    auctionCard7.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(20),
        reservePrice: dollarsToCents(80),
        buyOutPrice:  dollarsToCents(150),
        status:       "active",
        endsAt:       mins(10),
      },
      // Card 8 (5 min): no RP, no BO — leave with zero bids → expiredNoBids
      {
        listingId:    auctionCard8.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(10),
        reservePrice: null,
        buyOutPrice:  null,
        status:       "active",
        endsAt:       mins(5),
      },
      // Card 9 (6 min): bid above S$50 RP (e.g. S$60) → cron auto-settles at endsAt
      {
        listingId:    auctionCard9.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(20),
        reservePrice: dollarsToCents(50),
        buyOutPrice:  dollarsToCents(120),
        status:       "active",
        endsAt:       mins(6),
      },
      // Card 10 (7 min): bid below S$80 RP (e.g. S$40) → pending_seller_decision
      {
        listingId:    auctionCard10.id,
        sellerId:     ash.id,
        startingBid:  dollarsToCents(30),
        reservePrice: dollarsToCents(80),
        buyOutPrice:  null,
        status:       "active",
        endsAt:       mins(7),
      },
    ],
  });

  console.log("✅ Seeded 10 auction cards (including 5/6/7/10-min quick-expiry test auctions)");

  // Offer — Misty (buyer) offers on Ash's Charizard (seller)
  const offer = await prisma.offer.create({
    data: {
      price: dollarsToCents(100),
      message: null,
      status: "pending",
      listingId: charizard.id,
      buyerId: misty.id,
      sellerId: ash.id,
    },
  });

  console.log(
    "✅ Offer created from Misty on:",
    pokemonCatalog.charizardVmax.nameEn,
    "Offer:",
    offer.id
  );

  // (Optional) Seed a fake completed purchase flow: Order + Transaction
  // Useful to test your "purchases" UI
  const order = await prisma.order.create({
    data: {
      listingId: charizard.id,
      sellerId: ash.id,
      buyerId: misty.id,
      amount: charizard.price ?? dollarsToCents(120),
      currency: "sgd",
      status: "PAID",
      stripeCheckoutSessionId: "cs_test_seed_123",
      stripePaymentIntentId: "pi_test_seed_123",
    },
  });

  await prisma.cardTransaction.create({
    data: {
      orderId: order.id,
      listingId: charizard.id,
      sellerId: ash.id,
      buyerId: misty.id,
      amount: order.amount,
      currency: order.currency,
      stripeEventId: "evt_test_seed_123",
      tcgPlayerId: "232496",
    },
  });

  await prisma.$transaction([
    prisma.listing.update({
      where: { id: charizard.id },
      data: {
        ownerId: misty.id,
        forSale: false,
        reservedById: null,
        reservedUntil: null,
        reservedCheckoutSessionId: null,
      },
    }),
    // Mark the specific offer as paid and archive it
    prisma.offer.update({
      where: { id: offer.id },
      data: { archivedAt: new Date(), status: "paid", orderId: order.id },
    }),
  ]);

  console.log("✅ Seeded sample Order + CardTransaction");

  // ── Additional transactions so Highest Transacted has data ──────────────────
  // Look up one listing per catalog card to use as the sold-listing reference.
  // tcgPlayerId now lives on the catalog row, so the filter reaches it through
  // the pokemonCard relation instead of a flat column on Listing.
  const venusaurListing = await prisma.listing.findFirst({
    where: { pokemonCard: { tcgPlayerId: "222990" }, ownerId: ash.id },
  });
  const blastoiseListing = await prisma.listing.findFirst({
    where: { pokemonCard: { tcgPlayerId: "42360" }, ownerId: ash.id },
  });
  const starmieListing = await prisma.listing.findFirst({
    where: { pokemonCard: { tcgPlayerId: "197658" }, ownerId: misty.id },
  });
  const gyaradosListing = await prisma.listing.findFirst({
    where: { pokemonCard: { tcgPlayerId: "246724" }, ownerId: misty.id },
  });

  const extraTransactions = [
    // Venusaur V — 4 transactions (most transacted)
    { listing: venusaurListing, tcgPlayerId: "222990", seller: ash, buyer: misty, events: ["evt_seed_ven_1", "evt_seed_ven_2", "evt_seed_ven_3", "evt_seed_ven_4"] },
    // Blastoise — 3 transactions
    { listing: blastoiseListing, tcgPlayerId: "42360", seller: ash, buyer: misty, events: ["evt_seed_bla_1", "evt_seed_bla_2", "evt_seed_bla_3"] },
    // Starmie GX — 2 transactions
    { listing: starmieListing, tcgPlayerId: "197658", seller: misty, buyer: ash, events: ["evt_seed_sta_1", "evt_seed_sta_2"] },
    // Gyarados VMAX — 2 transactions
    { listing: gyaradosListing, tcgPlayerId: "246724", seller: misty, buyer: ash, events: ["evt_seed_gya_1", "evt_seed_gya_2"] },
  ];

  for (const { listing, tcgPlayerId, seller, buyer, events } of extraTransactions) {
    if (!listing) continue;
    for (const stripeEventId of events) {
      const extraOrder = await prisma.order.create({
        data: {
          listingId: listing.id,
          sellerId: seller.id,
          buyerId: buyer.id,
          amount: listing.price ?? dollarsToCents(50),
          currency: "sgd",
          status: "PAID",
        },
      });
      await prisma.cardTransaction.create({
        data: {
          orderId: extraOrder.id,
          listingId: listing.id,
          sellerId: seller.id,
          buyerId: buyer.id,
          amount: extraOrder.amount,
          currency: extraOrder.currency,
          stripeEventId,
          tcgPlayerId,
        },
      });
    }
  }

  console.log("✅ Seeded extra transactions for Highest Transacted");

  await seedRiftboundCatalog();

  // ── Riftbound catalog + listing ──────────────────────────────────────────
  // "Vi - Peacekeeper" (unl-176-219, tcgPlayerId already set by the bulk
  // catalog import above) already exists — reuse that row instead of
  // creating a duplicate, which would violate the riftboundId unique
  // constraint.
  const riftboundVi = await prisma.riftboundCardCatalog.findUniqueOrThrow({
    where: { riftboundId: "unl-176-219" },
  });

  // riftboundVi.imageUrl is the raw riftcodex CDN URL — next.config.mjs's
  // remotePatterns only allowlists the Supabase storage host, so using it
  // directly as-is would break next/image on /cards/[id]. Re-host it first.
  const viImageUrl = await uploadImageFromUrl(
    supabase,
    riftboundVi.imageUrl,
    `mock/riftbound/${riftboundVi.riftboundId}.png`,
    riftboundImageCachePath(riftboundVi.riftboundId)
  );

  await prisma.listing.create({
    data: {
      game: "RIFTBOUND",
      riftboundCardId: riftboundVi.id,
      price: dollarsToCents(15),
      condition: "Near Mint",
      description: "Vi - Peacekeeper from the Unleashed set.",
      imageUrls: [viImageUrl],
      forSale: true,
      ownerId: ash.id,
    },
  });

  console.log("✅ Riftbound catalog + listing created");

  // ── Best Sellers (admin-curated) ─────────────────────────────────────────────
  await prisma.bestSeller.createMany({
    data: [
      { tcgPlayerId: "232496", position: 1 }, // Charizard VMAX
      { tcgPlayerId: "42360",  position: 2 }, // Blastoise Holo Rare
      { tcgPlayerId: "222990", position: 3 }, // Venusaur V
      { tcgPlayerId: "197658", position: 4 }, // Starmie GX
      { tcgPlayerId: "246724", position: 5 }, // Gyarados VMAX
      { tcgPlayerId: "14936",  position: 6 }, // Shuckle PSA 10
      { tcgPlayerId: "441629", position: 7 }, // Psyduck V (Japanese)
    ],
  });

  console.log("✅ Seeded Best Sellers");

  console.log("🌱 Seeding complete!");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Seeding failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
