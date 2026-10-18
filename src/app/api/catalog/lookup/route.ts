import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/catalog/lookup?game=&tcgPlayerId=
//
// Read-only, admin-gated check for whether a catalog row already exists for
// a given (game, tcgPlayerId) pair. Used by the upload form to decide
// whether to show catalog-identity fields (creating a new row) or a
// read-only "card found" summary (reusing an existing one) — never creates
// or updates anything itself.
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    if (session.user.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const game = searchParams.get("game");
    const tcgPlayerId = searchParams.get("tcgPlayerId");

    if (game !== "POKEMON" && game !== "RIFTBOUND") {
      return NextResponse.json(
        { error: `Unknown game: "${game}"` },
        { status: 400 }
      );
    }
    if (!tcgPlayerId) {
      return NextResponse.json(
        { error: "tcgPlayerId is required" },
        { status: 400 }
      );
    }

    if (game === "POKEMON") {
      // orderBy makes the match deterministic if more than one row somehow
      // shares a tcgPlayerId (confirmed to happen on the Riftbound side —
      // see the RIFTBOUND branch below — so applied uniformly here too).
      const entry = await prisma.pokemonCardCatalog.findFirst({
        where: { tcgPlayerId },
        orderBy: { createdAt: "asc" },
      });
      if (!entry) return NextResponse.json({ found: false });
      return NextResponse.json({
        found: true,
        catalog: {
          title: entry.nameEn,
          setName: entry.setNameEn,
          rarity: entry.rarity,
          cardNumber: entry.printedNumber ?? entry.localId,
          // Returned (even though the "found" summary UI only displays a
          // subset) so the upload form can silently backfill every
          // catalog-identity field the server still requires on submit —
          // without this, submitting a "found" match sends blank
          // title/language/type/supertype and the server 400s.
          language: entry.language,
        },
      });
    }

    // A small number of real Riftbound cards (e.g. foil/non-foil variants of
    // the same promo) legitimately share one tcgPlayerId — orderBy makes
    // which row wins deterministic rather than incidental.
    const entry = await prisma.riftboundCardCatalog.findFirst({
      where: { tcgPlayerId },
      orderBy: { createdAt: "asc" },
    });
    if (!entry) return NextResponse.json({ found: false });
    return NextResponse.json({
      found: true,
      catalog: {
        title: entry.name,
        setName: entry.setLabel,
        rarity: entry.rarity,
        cardNumber: entry.printedNumber ?? entry.collectorNumber,
        // Canonical card art, so the admin can visually confirm this is the
        // right card. PokemonCardCatalog also has an imageUrl field now;
        // this route just doesn't read/return it in the POKEMON branch above.
        imageUrl: entry.imageUrl,
        type: entry.type,
        supertype: entry.supertype,
      },
    });
  } catch (error: any) {
    console.error("❌ Error looking up catalog entry:", error);
    return NextResponse.json(
      { error: "Failed to look up catalog entry" },
      { status: 500 }
    );
  }
}
