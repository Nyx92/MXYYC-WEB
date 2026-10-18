import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createClient } from "@supabase/supabase-js";
import { dollarsToCents } from "@/lib/money";
import {
  listingCatalogInclude,
  withListingDisplay,
} from "@/lib/listingDisplay";
import { compressCardImage } from "@/lib/imageProcessing";
import { getListingsPage } from "@/lib/listingsQuery";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Server-side cap on a single uploaded image, checked before it's buffered
// into memory. Not just a UX nicety — without this, a client can send an
// arbitrarily large "image" and force the server to buffer all of it.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// GET /api/cards — public; always for-sale listings only (see getListingsPage).
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const pageParam = searchParams.get("page");
    const pageSizeParam = searchParams.get("pageSize");
    const rawPage = pageParam ? parseInt(pageParam, 10) : null;
    const rawPageSize = pageSizeParam ? parseInt(pageSizeParam, 10) : null;
    const isPaginated =
      rawPage != null && rawPageSize != null && !Number.isNaN(rawPage) && !Number.isNaN(rawPageSize);

    const body = await getListingsPage({
      tcgPlayerId: searchParams.get("tcgPlayerId"),
      game: searchParams.get("game") as "POKEMON" | "RIFTBOUND" | null,
      setNames: searchParams.getAll("setName"),
      rarities: searchParams.getAll("rarity"),
      types: searchParams.getAll("type"),
      languages: searchParams.getAll("language"),
      conditions: searchParams.getAll("condition"),
      // getListingsPage clamps this to MAX_IDS itself — see listingsQuery.ts.
      ids: searchParams.getAll("ids"),
      page: isPaginated ? rawPage : null,
      pageSize: isPaginated ? rawPageSize : null,
    });

    return NextResponse.json(body);
  } catch (error: any) {
    console.error("❌ Error fetching cards:", error);
    return NextResponse.json(
      { error: "Failed to fetch cards" },
      { status: 500 }
    );
  }
}

// POST /api/cards
export async function POST(req: Request) {
  // Storage paths uploaded so far — removed (best-effort) if a later step fails.
  const uploadedPaths: string[] = [];
  try {
    // This endpoint lets the caller assign the new card to ANY user (see
    // ownerId below) — it's an admin tool for listing cards on behalf of
    // sellers, not a self-service upload. The `isAdmin` gate on the /upload
    // page only hides the UI; without a server-side check here, anyone
    // could call this route directly and create a card owned by anyone.
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (session.user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const formData = await req.formData();

    const game = formData.get("game") as string | null;
    if (game !== "POKEMON" && game !== "RIFTBOUND") {
      return NextResponse.json(
        { error: `Unknown game: "${game}"` },
        { status: 400 }
      );
    }

    const condition = formData.get("condition") as string | null;
    const description = (formData.get("description") as string | null) || "";
    const ownerId = formData.get("ownerId") as string | null;
    const forSale = formData.get("forSale") === "true";
    const tcgPlayerId = (formData.get("tcgPlayerId") as string | null)?.trim() || null;

    // Price logic (may be omitted when NOT for sale)
    const priceRaw = formData.get("price");
    let price: number | null = null;

    if (typeof priceRaw === "string" && priceRaw.trim() !== "") {
      const dollars = parseFloat(priceRaw);
      if (!Number.isNaN(dollars)) price = dollarsToCents(dollars);
    }

    const priceRequiredButMissing =
      forSale && (price === null || Number.isNaN(price));

    // Same rule as PUT /api/cards/[id]: a for-sale card needs a positive price.
    if (forSale && price !== null && price <= 0) {
      return NextResponse.json(
        { error: "Price must be greater than $0 when listing a card for sale" },
        { status: 400 }
      );
    }

    const images = formData
      .getAll("images")
      .filter((v): v is File => v instanceof File);

    if (
      !condition ||
      !ownerId ||
      !tcgPlayerId ||
      images.length === 0 ||
      priceRequiredButMissing
    ) {
      console.error("❌ Missing required fields", {
        condition,
        ownerId,
        forSale,
        price,
        imagesCount: images.length,
        formKeys: Array.from(formData.keys()),
      });

      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // ownerId here is client-supplied (the admin "select owner" dropdown) —
    // confirm it actually points at a real user before creating a Listing
    // for it (matches the same guard on PUT /api/cards/[id]).
    const ownerExists = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { id: true },
    });
    if (!ownerExists) {
      return NextResponse.json(
        { error: "The selected owner does not exist." },
        { status: 400 }
      );
    }

    // The catalog is filled only by `pnpm update-catalog` (tcg-index-sync),
    // so a listing must point at a card that is already there. Checked
    // before any image is uploaded.
    const catalogCard =
      game === "POKEMON"
        ? await prisma.pokemonCardCatalog.findUnique({ where: { tcgPlayerId }, select: { id: true } })
        : await prisma.riftboundCardCatalog.findUnique({ where: { tcgPlayerId }, select: { id: true } });
    if (!catalogCard) {
      return NextResponse.json(
        { error: "This TCG Player ID is not in the catalog. Run pnpm update-catalog to import new cards." },
        { status: 400 }
      );
    }

    // Reject oversized files up front, before any of them are buffered.
    for (const image of images) {
      if (image.size > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: "Each image must be 10MB or smaller." },
          { status: 413 }
        );
      }
    }

    const imageUrls: string[] = [];

    for (const image of images) {
      const arrayBuffer = await image.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // compressCardImage decodes the buffer with sharp before re-encoding
      // it — a non-image file (regardless of what content-type the client
      // claimed) fails to decode and throws here, so this doubles as real
      // content-type validation instead of trusting the client-supplied
      // MIME type string alone.
      let compressed;
      try {
        compressed = await compressCardImage(buffer);
      } catch (err) {
        // Multiple images can be uploaded per request — name the one that
        // failed, since "Image decode failed" alone doesn't say which.
        console.error("❌ Image decode failed:", image.name, err);
        return NextResponse.json(
          { error: "One of the uploaded files is not a valid image." },
          { status: 400 }
        );
      }

      // Random key, never derived from the client's filename — no path
      // tricks, and upsert: false means one upload can't overwrite another.
      const filename = `cards/${crypto.randomUUID()}.webp`;

      const { data, error } = await supabase.storage
        .from("card-images")
        .upload(filename, compressed.buffer, {
          contentType: compressed.contentType,
          upsert: false,
        });

      if (error) {
        console.error("❌ Supabase upload error:", filename, error);
        throw error;
      }
      uploadedPaths.push(data.path);

      const { data: publicUrlData } = supabase.storage
        .from("card-images")
        .getPublicUrl(data.path);

      imageUrls.push(publicUrlData.publicUrl);
    }

    const listingData =
      game === "POKEMON"
        ? { game: "POKEMON" as const, pokemonCardId: catalogCard.id }
        : { game: "RIFTBOUND" as const, riftboundCardId: catalogCard.id };

    const listing = await prisma.listing.create({
      data: {
        ...listingData,
        price,
        condition,
        description,
        imageUrls,
        forSale,
        ownerId,
      },
      include: listingCatalogInclude,
    });

    return NextResponse.json({ card: withListingDisplay(listing) });
  } catch (error: any) {
    // Log the real error server-side only — never echo error.message back to
    // the client, it can leak internal details (DB/Prisma errors, Supabase
    // errors, etc.) that aren't meant for an API consumer to see.
    console.error("❌ Error creating card:", error);
    if (uploadedPaths.length > 0) {
      try {
        await supabase.storage.from("card-images").remove(uploadedPaths);
      } catch (cleanupErr) {
        console.error("❌ Failed to remove orphaned uploads:", uploadedPaths, cleanupErr);
      }
    }
    return NextResponse.json(
      { error: "Failed to create listing. Please try again." },
      { status: 500 }
    );
  }
}
