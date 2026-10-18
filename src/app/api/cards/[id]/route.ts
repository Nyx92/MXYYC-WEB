import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { listingLockableWhere } from "@/lib/collectionRequests";
import { createClient } from "@supabase/supabase-js";
import { getServerSession } from "next-auth";
import { authOptions, isAdminOrOwner } from "@/lib/auth";
import { dollarsToCents, centsToDollars } from "@/lib/money";
import {
  listingCatalogInclude,
  withListingDisplay,
  getCardDetailForViewer,
  updatePokemonCatalogEntry,
  updateRiftboundCatalogEntry,
} from "@/lib/listingDisplay";
import { isValidRiftboundType, isValidRiftboundSupertype } from "@/lib/riftboundCatalog";
import { compressCardImage } from "@/lib/imageProcessing";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Server-side cap on a single uploaded image, checked before it's buffered
// into memory (matches src/app/api/cards/route.ts's create path).
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// Best-effort cleanup of images uploaded by a PUT that then failed.
async function removeUploaded(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await supabase.storage.from("card-images").remove(paths);
  } catch (err) {
    console.error("❌ Failed to remove orphaned uploads:", paths, err);
  }
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const session = await getServerSession(authOptions);
    const card = await getCardDetailForViewer(prisma, params.id, session?.user?.id);

    if (!card) {
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }

    return NextResponse.json({ card });
  } catch (error) {
    console.error("❌ Error fetching card:", error);
    return NextResponse.json(
      { error: "Failed to fetch card" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Storage paths uploaded so far — removed (best-effort) if a later step fails.
  const uploadedPaths: string[] = [];
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const listing = await prisma.listing.findUnique({ where: { id: params.id } });
    if (!listing) {
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }

    const isAdmin = session.user.role === "admin";

    if (!isAdminOrOwner(session, listing.ownerId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const formData = await req.formData();

    const forSale = formData.get("forSale") === "true";
    const priceRaw = formData.get("price");
    let price: number | null = null;
    if (typeof priceRaw === "string" && priceRaw.trim() !== "") {
      const dollars = parseFloat(priceRaw);
      if (!Number.isNaN(dollars)) price = dollarsToCents(dollars);
    }

    // A card mid-auction must not be re-listed for sale through this path —
    // POST /api/auctions already set forSale: false and inAuction: true to
    // lock it. Allowing forSale: true here would let Buy Now/offers run
    // concurrently with live bids (the same double-sale class of bug fixed
    // in the offer-accept and auction-creation guards).
    if (forSale && listing.inAuction) {
      return NextResponse.json(
        { error: "Cannot list a card for sale while it is in an active auction" },
        { status: 409 }
      );
    }

    // Same reasoning as the inAuction guard above — a card earmarked for
    // in-person pickup must not become sellable again, or the shop could
    // end up packing (or unpacking) a card that was sold out from under
    // the pickup request. See POST /api/collection-requests.
    if (forSale && listing.collectionRequestId) {
      return NextResponse.json(
        { error: "Cannot list a card for sale while it is marked for in-person collection" },
        { status: 409 }
      );
    }

    if (forSale && (price == null || price <= 0)) {
      return NextResponse.json(
        { error: "Price must be greater than $0 when listing a card for sale" },
        { status: 400 }
      );
    }

    // Owner: only price + forSale. The WHERE re-checks, under the row lock:
    // ownership (the card may have been sold since the read above), no live
    // Buy Now reservation (un-listing mid-checkout would make the webhook
    // refund the buyer), and when listing, the auction/collection locks — so
    // a concurrent auction create or collection request can't both win.
    if (!isAdmin) {
      const lockable = listingLockableWhere();
      let updated;
      try {
        updated = await prisma.listing.update({
          where: {
            id: params.id,
            ownerId: listing.ownerId,
            AND: [forSale ? lockable : { OR: lockable.OR }],
          },
          data: { price, forSale },
        });
      } catch (err) {
        if ((err as { code?: string })?.code === "P2025") {
          return NextResponse.json(
            { error: "This card changed or is mid-checkout. Please refresh and try again." },
            { status: 409 }
          );
        }
        throw err;
      }
      // Reservation columns identify the buyer mid-checkout — not the
      // seller's business (same rule as withListingDisplay).
      const { reservedById: _r, reservedUntil: _u, reservedCheckoutSessionId: _s, ...card } = updated;
      return NextResponse.json({
        card: {
          ...card,
          price: card.price != null ? centsToDollars(card.price) : null,
        },
      });
    }

    // Admin: full update. Card-identity fields (title/setName/rarity/etc.)
    // always apply here — editing updates the linked catalog row directly
    // (catalog data is shared across every listing of the same card, so the
    // edit is visible to every other seller's listing of it too), rather
    // than reassigning which catalog row the listing points to. Which
    // catalog (Pokemon vs Riftbound) gets updated is driven by the
    // listing's own (immutable) game, not by anything in this form.
    const title = formData.get("title") as string;
    const condition = formData.get("condition") as string;
    const description = (formData.get("description") as string) || "";
    const ownerId = formData.get("ownerId") as string;
    const setName = (formData.get("setName") as string) || "";
    const rarity = (formData.get("rarity") as string) || "";
    const tcgPlayerId = formData.get("tcgPlayerId") as string;
    // Pokemon-only.
    const language = formData.get("language") as string;
    const cardNumber = (formData.get("cardNumber") as string) || "";
    // Riftbound-only.
    const type = formData.get("type") as string;
    const supertype = (formData.get("supertype") as string | null) ?? "";

    if (listing.game === "RIFTBOUND") {
      if (!type || !isValidRiftboundType(type)) {
        return NextResponse.json(
          { error: `Unknown Riftbound type: "${type}"` },
          { status: 400 }
        );
      }
      if (!isValidRiftboundSupertype(type, supertype)) {
        return NextResponse.json(
          { error: `Supertype "${supertype}" is not valid for type "${type}"` },
          { status: 400 }
        );
      }
    }

    // ownerId here is client-supplied (the admin "assign owner" dropdown) —
    // confirm it actually points at a real user before we hand off to
    // prisma.listing.update, or a typo'd/stale id would silently orphan the
    // listing (still "owned" by an id no User row matches).
    if (ownerId) {
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
    }

    // Existing image URLs the client wants to keep
    const keepRaw = formData.get("keepImageUrls") as string | null;
    let keepImageUrls: string[];
    try {
      keepImageUrls = keepRaw ? JSON.parse(keepRaw) : [];
    } catch {
      return NextResponse.json({ error: "Invalid keepImageUrls" }, { status: 400 });
    }

    // Upload any new images
    const newImages = formData
      .getAll("images")
      .filter((v): v is File => v instanceof File);

    // Reject oversized files up front, before any of them are buffered.
    for (const image of newImages) {
      if (image.size > MAX_IMAGE_BYTES) {
        return NextResponse.json(
          { error: "Each image must be 10MB or smaller." },
          { status: 413 }
        );
      }
    }

    const newImageUrls: string[] = [];

    for (const image of newImages) {
      const buffer = Buffer.from(await image.arrayBuffer());

      // compressCardImage decodes with sharp before re-encoding — a
      // non-image file fails to decode and throws here, so this doubles as
      // real content-type validation instead of trusting the client's
      // claimed MIME type.
      let compressed;
      try {
        compressed = await compressCardImage(buffer);
      } catch (err) {
        // Multiple images can be uploaded per request — name the one that
        // failed, since "Image decode failed" alone doesn't say which.
        console.error("❌ Image decode failed:", image.name, err);
        await removeUploaded(uploadedPaths);
        return NextResponse.json(
          { error: "One of the uploaded files is not a valid image." },
          { status: 400 }
        );
      }

      // Random key, never the client's filename — see POST /api/cards.
      const filename = `cards/${crypto.randomUUID()}.webp`;
      const { data, error } = await supabase.storage
        .from("card-images")
        .upload(filename, compressed.buffer, { contentType: compressed.contentType, upsert: false });
      if (error) {
        console.error("❌ Supabase upload error:", filename, error);
        throw error;
      }
      uploadedPaths.push(data.path);
      const { data: pub } = supabase.storage
        .from("card-images")
        .getPublicUrl(data.path);
      newImageUrls.push(pub.publicUrl);
    }

    const imageUrls = [...keepImageUrls, ...newImageUrls];
    if (imageUrls.length === 0) {
      return NextResponse.json(
        { error: "At least one image is required" },
        { status: 400 }
      );
    }

    if (listing.game === "POKEMON" && listing.pokemonCardId) {
      await updatePokemonCatalogEntry(prisma, listing.pokemonCardId, {
        title,
        setName,
        rarity,
        tcgPlayerId,
        language,
        cardNumber,
      });
    } else if (listing.game === "RIFTBOUND" && listing.riftboundCardId) {
      await updateRiftboundCatalogEntry(prisma, listing.riftboundCardId, {
        title,
        setName,
        rarity,
        tcgPlayerId,
        cardNumber,
        type,
        supertype,
      });
    }

    // Reassigning the owner or flipping forSale must not touch a card that's
    // in an auction, in a pickup request, or under a live Buy Now
    // reservation — same locks as the owner path, re-checked under the row lock.
    const locksMatter = ownerId !== listing.ownerId || forSale !== listing.forSale;
    let updated;
    try {
      updated = await prisma.listing.update({
        where: { id: params.id, ...(locksMatter ? { AND: [listingLockableWhere()] } : {}) },
        data: {
          price,
          condition,
          description,
          imageUrls,
          forSale,
          ownerId,
        },
        include: listingCatalogInclude,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2025") {
        await removeUploaded(uploadedPaths);
        return NextResponse.json(
          { error: "This card is in an auction, a pickup request, or mid-checkout. Please refresh and try again." },
          { status: 409 }
        );
      }
      throw err;
    }

    const withDisplay = withListingDisplay(updated);
    return NextResponse.json({
      card: {
        ...withDisplay,
        price: withDisplay.price != null ? centsToDollars(withDisplay.price) : null,
      },
    });
  } catch (error: any) {
    // Log the real error server-side only — never echo error.message back to
    // the client (see POST /api/cards for the same reasoning).
    console.error("❌ Error updating card:", error);
    await removeUploaded(uploadedPaths);
    return NextResponse.json(
      { error: "Failed to update listing. Please try again." },
      { status: 500 }
    );
  }
}
