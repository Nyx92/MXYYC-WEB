import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

let n = 0;
const uid = () => `${Date.now().toString(36)}${(++n).toString(36)}`;

export function createUser(data: Partial<Prisma.UserUncheckedCreateInput> = {}) {
  const id = uid();
  return prisma.user.create({
    data: {
      email: `user-${id}@test.local`,
      username: `user_${id}`,
      emailVerified: new Date(),
      phoneVerified: true,
      ...data,
    },
  });
}

export function createCatalogCard(data: Partial<Prisma.PokemonCardCatalogUncheckedCreateInput> = {}) {
  const id = uid();
  return prisma.pokemonCardCatalog.create({
    data: {
      externalId: `test-${id}`,
      nameEn: `Test Card ${id}`,
      language: "English",
      setId: "test-set",
      setNameEn: "Test Set",
      rarity: "Rare",
      ...data,
    },
  });
}

export async function createListing(ownerId: string, data: Partial<Prisma.ListingUncheckedCreateInput> = {}) {
  const pokemonCardId = data.pokemonCardId ?? (await createCatalogCard()).id;
  return prisma.listing.create({
    data: { game: "POKEMON", condition: "Near Mint", forSale: true, price: 5000, ownerId, pokemonCardId, ...data },
  });
}

export function createOffer(
  listing: { id: string; ownerId: string },
  buyerId: string,
  data: Partial<Prisma.OfferUncheckedCreateInput> = {}
) {
  return prisma.offer.create({
    data: {
      listingId: listing.id,
      sellerId: listing.ownerId,
      buyerId,
      price: 4000,
      status: "pending",
      paymentIntentId: `pi_offer_${uid()}`,
      expiresAt: new Date(Date.now() + 24 * 3600_000),
      ...data,
    },
  });
}

export async function createAuction(
  listing: { id: string; ownerId: string },
  data: Partial<Prisma.AuctionUncheckedCreateInput> = {}
) {
  await prisma.listing.update({ where: { id: listing.id }, data: { inAuction: true, forSale: false } });
  return prisma.auction.create({
    data: {
      listingId: listing.id,
      sellerId: listing.ownerId,
      startingBid: 1000,
      endsAt: new Date(Date.now() + 24 * 3600_000),
      status: "active",
      ...data,
    },
  });
}
