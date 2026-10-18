import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as checkout } from "@/app/api/checkout/route";
import { POST as createAuction } from "@/app/api/auctions/route";
import { POST as createCollectionRequest } from "@/app/api/collection-requests/route";
import { createListing, createUser } from "./helpers/factories";
import { loginAs, loginQueue } from "./helpers/session";
import { req, statuses } from "./helpers/http";
import { stripe } from "./helpers/stripe";

const buyNow = (cardId: string) => checkout(req("/api/checkout", { cardId }));

describe("POST /api/checkout (Buy Now) against a real database", () => {
  it("two concurrent checkouts for the same listing: exactly one reserves it", async () => {
    const seller = await createUser();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);

    loginQueue(a.id, b.id);
    const res = await Promise.all([buyNow(listing.id), buyNow(listing.id)]);

    expect(statuses(res)).toEqual([200, 500]);
    const orders = await prisma.order.findMany({ where: { listingId: listing.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("PENDING");
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.reservedById).toBe(orders[0].buyerId);
    expect(after.reservedCheckoutSessionId).toBe(orders[0].stripeCheckoutSessionId);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a listing that is in an auction", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id, { forSale: false, inAuction: true });

    loginAs(buyer.id);
    const res = await buyNow(listing.id);

    expect(res.status).toBe(409);
    expect(await prisma.order.count()).toBe(0);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).reservedById).toBeNull();
  });

  it("refuses a listing that is earmarked for a collection request", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const request = await prisma.collectionRequest.create({ data: { requestRef: "PU-T-1", userId: seller.id } });
    const listing = await createListing(seller.id, { forSale: false, collectionRequestId: request.id });

    loginAs(buyer.id);
    expect((await buyNow(listing.id)).status).toBe(409);
    expect(await prisma.order.count()).toBe(0);
  });

  it("checkout racing an auction create on the same listing: exactly one wins", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);

    loginQueue(buyer.id, seller.id);
    await Promise.all([
      buyNow(listing.id),
      createAuction(req("/api/auctions", { cardId: listing.id, startingBid: 10, durationDays: 1 })),
    ]);

    const auctions = await prisma.auction.count({ where: { listingId: listing.id } });
    const pending = await prisma.order.count({ where: { listingId: listing.id, status: "PENDING" } });
    expect(auctions + pending).toBe(1);
  });

  it("checkout racing a collection request on the same listing: never both", async () => {
    const owner = await createUser();
    const buyer = await createUser();
    const listing = await createListing(owner.id);

    // A for-sale card is not collectable, so the owner first un-lists it;
    // the collection attach and the reservation then race on forSale.
    loginQueue(buyer.id, owner.id);
    await Promise.all([
      buyNow(listing.id),
      prisma.listing
        .update({ where: { id: listing.id }, data: { forSale: false } })
        .then(() => createCollectionRequest(req("/api/collection-requests", { listingIds: [listing.id] }))),
    ]);

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    const pending = await prisma.order.count({ where: { listingId: listing.id, status: "PENDING" } });
    expect(after.collectionRequestId !== null && pending === 1).toBe(false);
  });

  it("a Stripe failure releases the reservation and expires the order", async () => {
    const seller = await createUser();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    stripe.checkout.sessions.create.mockRejectedValueOnce(new Error("stripe down"));

    loginQueue(a.id, b.id);
    expect((await buyNow(listing.id)).status).toBe(500);

    const order = await prisma.order.findFirstOrThrow({ where: { buyerId: a.id } });
    expect(order.status).toBe("EXPIRED");
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.reservedById).toBeNull();
    expect(after.reservedUntil).toBeNull();

    // The card really is free again: the next buyer can reserve it.
    expect((await buyNow(listing.id)).status).toBe(200);
  });
});
