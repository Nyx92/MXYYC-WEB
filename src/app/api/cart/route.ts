// src/app/api/cart/route.ts
//
// Three operations on the user's cart:
//
//   GET  /api/cart          → return the full cart grouped into packages by seller
//   POST /api/cart          → add a listing (idempotent — adding the same listing twice is safe)
//   DELETE /api/cart        → clear all items (or only selected items with ?selected=true)

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { centsToDollars } from "@/lib/money";
import { listingCatalogInclude, publicReservation, withListingDisplay } from "@/lib/listingDisplay";

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    // Cart (upserted so the very first GET silently creates an empty cart for
    // new users) and the user's profile (for the shipping-address panel) are
    // independent reads — neither depends on the other's result — so they run
    // in parallel instead of as two sequential round trips.
    const [cart, user] = await Promise.all([
      prisma.cart.upsert({
        where: { userId },
        create: { userId },
        update: {},
        include: {
          items: {
            include: {
              listing: {
                include: {
                  // Adding to cart requires no relationship with the seller yet —
                  // email deliberately excluded, same rationale as cards/route.ts.
                  owner: { select: { id: true, username: true } },
                  ...listingCatalogInclude,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          firstName: true,
          lastName: true,
          username: true,
          address: true,
          phoneNumber: true,
        },
      }),
    ]);

    // Group items by seller — each group becomes a "package" in the UI
    const sellerMap = new Map<
      string,
      { sellerName: string; items: (typeof cart.items)[number][] }
    >();

    for (const item of cart.items) {
      const sellerId = item.listing.owner.id;
      const sellerName = item.listing.owner.username ?? "Seller";
      if (!sellerMap.has(sellerId)) {
        sellerMap.set(sellerId, { sellerName, items: [] });
      }
      sellerMap.get(sellerId)!.items.push(item);
    }

    const packages = Array.from(sellerMap.entries()).map(
      ([sellerId, { sellerName, items }]) => ({
        sellerId,
        sellerName,
        items: items.map((item) => {
          const display = withListingDisplay(item.listing);
          return {
            id: item.id,
            selected: item.selected,
            createdAt: item.createdAt.toISOString(),
            card: {
              id: display.id,
              title: display.title,
              price: display.price != null ? centsToDollars(display.price) : null,
              condition: display.condition,
              imageUrls: display.imageUrls,
              language: display.language,
              setName: display.setName,
              rarity: display.rarity,
              cardNumber: display.cardNumber,
              forSale: display.forSale,
              tcgPlayerId: display.tcgPlayerId,
              owner: display.owner,
              ...publicReservation(item.listing, userId),
            },
          };
        }),
      })
    );

    // Build the display name for the shipping address panel
    const name =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
      user?.username ||
      "User";

    return NextResponse.json({
      packages,
      userAddress: user
        ? { name, address: user.address ?? null, phoneNumber: user.phoneNumber ?? null }
        : null,
    });
  } catch (err) {
    console.error("[cart GET] error:", userId, err);
    return NextResponse.json({ error: "Failed to fetch cart" }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  // Wire contract unchanged — the request body still uses `cardId`, even
  // though it now maps to a Listing row.
  const listingId = typeof body?.cardId === "string" ? body.cardId : null;
  if (!listingId) {
    return NextResponse.json({ error: "cardId is required" }, { status: 400 });
  }

  const userId = session.user.id;

  try {
    // Validate the listing exists, is for sale, and doesn't belong to the buyer
    const listing = await prisma.listing.findUnique({ where: { id: listingId } });
    if (!listing) {
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }
    if (!listing.forSale) {
      return NextResponse.json({ error: "Card is not for sale" }, { status: 400 });
    }
    if (listing.ownerId === userId) {
      return NextResponse.json(
        { error: "You cannot add your own card to your cart" },
        { status: 400 }
      );
    }

    // Get or create the user's cart
    const cart = await prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    // Check if already in cart before creating (so we can tell the caller)
    const existing = await prisma.cartItem.findUnique({
      where: { cartId_listingId: { cartId: cart.id, listingId } },
    });

    if (existing) {
      const count = await prisma.cartItem.count({ where: { cartId: cart.id } });
      return NextResponse.json({
        success: true,
        alreadyInCart: true,
        cartItemId: existing.id,
        count,
      });
    }

    const item = await prisma.cartItem.create({
      data: { cartId: cart.id, listingId, selected: true },
    });

    const count = await prisma.cartItem.count({ where: { cartId: cart.id } });

    return NextResponse.json({
      success: true,
      alreadyInCart: false,
      cartItemId: item.id,
      count,
    });
  } catch (err) {
    console.error("[cart POST] error:", listingId, userId, err);
    return NextResponse.json({ error: "Failed to add card to cart" }, { status: 500 });
  }
}

// ── DELETE ────────────────────────────────────────────────────────────────────

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const url = new URL(req.url);
  // ?selected=true → only remove checked items; otherwise remove everything
  const selectedOnly = url.searchParams.get("selected") === "true";

  try {
    const cart = await prisma.cart.findUnique({ where: { userId } });
    if (!cart) {
      return NextResponse.json({ success: true, deleted: 0 });
    }

    const result = await prisma.cartItem.deleteMany({
      where: {
        cartId: cart.id,
        ...(selectedOnly ? { selected: true } : {}),
      },
    });

    return NextResponse.json({ success: true, deleted: result.count });
  } catch (err) {
    console.error("[cart DELETE] error:", userId, err);
    return NextResponse.json({ error: "Failed to clear cart" }, { status: 500 });
  }
}
