// src/types/cart.ts
//
// Shared types for the shopping cart feature.
// These mirror what GET /api/cart returns and are used by the cart page,
// CartContext, and any component that reads cart state.

// ── Cart data shapes ──────────────────────────────────────────────────────────
// These match the JSON returned by GET /api/cart.

export interface CartCardSnapshot {
  id: string;
  title: string;
  price: number | null;     // in dollars (converted from cents by the API)
  condition: string;
  imageUrls: string[];
  language: string;
  setName: string | null;
  rarity: string | null;
  cardNumber: string | null;
  forSale: boolean;
  tcgPlayerId: string;
  owner: { id: string; username: string | null; email: string };
  // See publicReservation in src/lib/listingDisplay.ts.
  reservedUntil?: string | null;
  reservedByViewer?: boolean;
}

export interface CartItemData {
  id: string;          // CartItem.id — used for PATCH (toggle selected) and DELETE
  selected: boolean;
  createdAt: string;
  card: CartCardSnapshot;
}

/** All items from the same seller, grouped server-side */
export interface CartPackage {
  sellerId: string;
  sellerName: string;
  items: CartItemData[];
}

/** Full response shape from GET /api/cart */
export interface CartResponse {
  packages: CartPackage[];
  userAddress: {
    name: string;
    address: string | null;
    phoneNumber: string | null;
  } | null;
}
