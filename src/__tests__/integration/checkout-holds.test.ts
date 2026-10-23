import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as checkout } from "@/app/api/checkout/route";
import { POST as cartCheckout } from "@/app/api/checkout/cart/route";
import { POST as cancelCheckout } from "@/app/api/checkout/cancel/route";
import { GET as expireOffersCron } from "@/app/api/cron/expire-offers/route";
import { GET as getCard } from "@/app/api/cards/[id]/route";
import { GET as getCart } from "@/app/api/cart/route";
import { createListing, createUser } from "./helpers/factories";
import { loginAs } from "./helpers/session";
import { idParams, req } from "./helpers/http";
import { completeSession, sessionStatus, stripe } from "./helpers/stripe";

// Buy Now / cart holds: how they end. The buyer cancels (cancel page or the
// back button), the 15 minutes lapse (cron, or the next buyer's checkout),
// or the buyer checks out again. Plus what the public APIs reveal about a hold.

const buyNow = (buyerId: string, cardId: string) => {
  loginAs(buyerId);
  return checkout(req("/api/checkout", { cardId }));
};

const cancel = (buyerId: string, body: object = {}) => {
  loginAs(buyerId);
  return cancelCheckout(req("/api/checkout/cancel", body));
};

const runCron = () =>
  expireOffersCron(req("/api/cron/expire-offers", undefined, { headers: { authorization: "Bearer test-cron-secret" } }));

const listingRow = (id: string) => prisma.listing.findUniqueOrThrow({ where: { id } });
const sessionOf = async (id: string) => (await listingRow(id)).reservedCheckoutSessionId!;
const lapse = (...ids: string[]) =>
  prisma.listing.updateMany({ where: { id: { in: ids } }, data: { reservedUntil: new Date(Date.now() - 1000) } });

async function fillCart(userId: string, listingIds: string[]) {
  await prisma.cart.create({
    data: { userId, items: { create: listingIds.map((listingId) => ({ listingId })) } },
  });
}

const checkoutCart = (buyerId: string) => {
  loginAs(buyerId);
  return cartCheckout(req("/api/checkout/cart", {}));
};

describe("POST /api/checkout/cancel against a real database", () => {
  it("closes the buyer's Buy Now checkout at once, so another buyer can reserve", async () => {
    const seller = await createUser();
    const [buyer, next] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    expect((await buyNow(buyer.id, listing.id)).status).toBe(200);
    const session = await sessionOf(listing.id);

    const res = await cancel(buyer.id, { cardId: listing.id });

    expect(await res.json()).toEqual({ released: 1, paid: false });
    expect(sessionStatus(session)).toBe("expired");
    expect(await listingRow(listing.id)).toMatchObject({
      reservedById: null,
      reservedUntil: null,
      reservedCheckoutSessionId: null,
    });
    expect((await prisma.order.findFirstOrThrow({ where: { listingId: listing.id } })).status).toBe("EXPIRED");
    expect((await buyNow(next.id, listing.id)).status).toBe(200);
  });

  it("never touches another buyer's hold", async () => {
    const seller = await createUser();
    const [holder, other] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    expect((await buyNow(holder.id, listing.id)).status).toBe(200);
    const session = await sessionOf(listing.id);

    const res = await cancel(other.id, { cardId: listing.id });

    expect(await res.json()).toEqual({ released: 0, paid: false });
    expect(sessionStatus(session)).toBe("open");
    expect((await listingRow(listing.id)).reservedById).toBe(holder.id);
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
  });

  it("reports a payment that already went through and keeps the hold", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    expect((await buyNow(buyer.id, listing.id)).status).toBe(200);
    completeSession(await sessionOf(listing.id));

    const res = await cancel(buyer.id, { cardId: listing.id });

    expect(await res.json()).toEqual({ released: 0, paid: true });
    expect((await listingRow(listing.id)).reservedById).toBe(buyer.id);
    expect((await prisma.order.findFirstOrThrow({ where: { listingId: listing.id } })).status).toBe("PENDING");
  });

  it("without a cardId (cart), closes the whole cart session once and frees every card", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const [a, b] = await Promise.all([createListing(seller.id), createListing(seller.id)]);
    await fillCart(buyer.id, [a.id, b.id]);
    expect((await checkoutCart(buyer.id)).status).toBe(200);
    const session = await sessionOf(a.id);
    expect(await sessionOf(b.id)).toBe(session);

    const res = await cancel(buyer.id);

    expect(await res.json()).toEqual({ released: 1, paid: false });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledTimes(1);
    expect(sessionStatus(session)).toBe("expired");
    for (const id of [a.id, b.id]) expect((await listingRow(id)).reservedById).toBeNull();
    expect(await prisma.order.count({ where: { status: "EXPIRED" } })).toBe(2);
  });

  it("returns 401 when signed out", async () => {
    expect((await cancelCheckout(req("/api/checkout/cancel", {}))).status).toBe(401);
  });
});

describe("POST /api/checkout/cart holds against a real database", () => {
  it("a buyer checking out their cart again replaces their earlier cart checkout", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const [a, b] = await Promise.all([createListing(seller.id), createListing(seller.id)]);
    await fillCart(buyer.id, [a.id, b.id]);
    expect((await checkoutCart(buyer.id)).status).toBe(200);
    const first = await sessionOf(a.id);

    expect((await checkoutCart(buyer.id)).status).toBe(200);

    expect(sessionStatus(first)).toBe("expired");
    const second = await sessionOf(a.id);
    expect(second).not.toBe(first);
    expect(await sessionOf(b.id)).toBe(second);
    expect(await prisma.order.count({ where: { status: "EXPIRED" } })).toBe(2);
    expect(await prisma.order.count({ where: { status: "PENDING" } })).toBe(2);
  });

  it("closes another buyer's lapsed hold on a cart card and reserves it", async () => {
    const seller = await createUser();
    const [early, buyer] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    expect((await buyNow(early.id, listing.id)).status).toBe(200);
    const old = await sessionOf(listing.id);
    await lapse(listing.id);
    await fillCart(buyer.id, [listing.id]);

    expect((await checkoutCart(buyer.id)).status).toBe(200);

    expect(sessionStatus(old)).toBe("expired");
    expect((await listingRow(listing.id)).reservedById).toBe(buyer.id);
  });

  it("refuses a cart card whose lapsed session was in fact paid, and reserves nothing", async () => {
    const seller = await createUser();
    const [early, buyer] = await Promise.all([createUser(), createUser()]);
    const [paid, free] = await Promise.all([createListing(seller.id), createListing(seller.id)]);
    expect((await buyNow(early.id, paid.id)).status).toBe(200);
    completeSession(await sessionOf(paid.id));
    await lapse(paid.id);
    await fillCart(buyer.id, [paid.id, free.id]);

    const res = await checkoutCart(buyer.id);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/was just sold/);
    expect((await listingRow(free.id)).reservedById).toBeNull();
    expect(await prisma.order.count({ where: { buyerId: buyer.id } })).toBe(0);
  });

  it("an active hold by another buyer returns a 409 and rolls back the whole cart", async () => {
    const seller = await createUser();
    const [holder, buyer] = await Promise.all([createUser(), createUser()]);
    const [held, free] = await Promise.all([createListing(seller.id), createListing(seller.id)]);
    expect((await buyNow(holder.id, held.id)).status).toBe(200);
    await fillCart(buyer.id, [free.id, held.id]);

    const res = await checkoutCart(buyer.id);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Another buyer is checking out/);
    expect((await listingRow(free.id)).reservedById).toBeNull();
    expect((await listingRow(held.id)).reservedById).toBe(holder.id);
  });
});

describe("lapsed holds are closed by the every-minute cron", () => {
  it("closes lapsed sessions, leaves active and paid ones alone", async () => {
    const seller = await createUser();
    const [x, y, z] = await Promise.all([createUser(), createUser(), createUser()]);
    const [lapsed, active, paid] = await Promise.all([
      createListing(seller.id),
      createListing(seller.id),
      createListing(seller.id),
    ]);
    expect((await buyNow(x.id, lapsed.id)).status).toBe(200);
    expect((await buyNow(y.id, active.id)).status).toBe(200);
    expect((await buyNow(z.id, paid.id)).status).toBe(200);
    const [lapsedSession, activeSession, paidSession] = await Promise.all([
      sessionOf(lapsed.id),
      sessionOf(active.id),
      sessionOf(paid.id),
    ]);
    completeSession(paidSession);
    await lapse(lapsed.id, paid.id);

    expect((await runCron()).status).toBe(200);

    expect(sessionStatus(lapsedSession)).toBe("expired");
    expect((await listingRow(lapsed.id)).reservedById).toBeNull();
    expect(sessionStatus(activeSession)).toBe("open");
    expect((await listingRow(active.id)).reservedById).toBe(y.id);
    // Paid: the completed webhook finishes the sale — the cron must not free it.
    expect((await listingRow(paid.id)).reservedById).toBe(z.id);
  });

  it("frees a hold whose session the current Stripe key doesn't know (other mode)", async () => {
    const seller = await createUser();
    const holder = await createUser();
    const listing = await createListing(seller.id, {
      reservedById: holder.id,
      reservedUntil: new Date(Date.now() - 1000),
      reservedCheckoutSessionId: "cs_live_made_with_the_other_key",
    });

    expect((await runCron()).status).toBe(200);

    expect(await listingRow(listing.id)).toMatchObject({ reservedById: null, reservedCheckoutSessionId: null });
  });
});

describe("what the public APIs reveal about a hold", () => {
  const cardFor = async (viewerId: string | null, id: string) => {
    if (viewerId) loginAs(viewerId);
    return (await (await getCard(req(`/api/cards/${id}`), idParams(id))).json()).card;
  };

  it("card detail: other viewers see when the hold ends, the holder sees it's theirs, nobody sees who", async () => {
    const seller = await createUser();
    const [holder, other] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    expect((await buyNow(holder.id, listing.id)).status).toBe(200);
    const { reservedUntil } = await listingRow(listing.id);

    const asOther = await cardFor(other.id, listing.id);
    const asHolder = await cardFor(holder.id, listing.id);
    const anonymous = await cardFor(null, listing.id);

    expect(asOther).toMatchObject({ reservedUntil: reservedUntil!.toISOString(), reservedByViewer: false });
    expect(anonymous).toMatchObject({ reservedUntil: reservedUntil!.toISOString(), reservedByViewer: false });
    expect(asHolder).toMatchObject({ reservedUntil: null, reservedByViewer: true });
    for (const card of [asOther, asHolder, anonymous]) {
      expect(card).not.toHaveProperty("reservedById");
      expect(card).not.toHaveProperty("reservedCheckoutSessionId");
    }
  });

  it("card detail: a lapsed hold reads as available", async () => {
    const seller = await createUser();
    const [holder, other] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    expect((await buyNow(holder.id, listing.id)).status).toBe(200);
    await lapse(listing.id);

    expect(await cardFor(other.id, listing.id)).toMatchObject({ reservedUntil: null, reservedByViewer: false });
  });

  it("cart: the same reservation fields on each item", async () => {
    const seller = await createUser();
    const [holder, other] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    await fillCart(holder.id, [listing.id]);
    await fillCart(other.id, [listing.id]);
    expect((await checkoutCart(holder.id)).status).toBe(200);

    const itemFor = async (userId: string) => {
      loginAs(userId);
      return (await (await getCart()).json()).packages[0].items[0].card;
    };
    const asHolder = await itemFor(holder.id);
    const asOther = await itemFor(other.id);

    expect(asHolder).toMatchObject({ reservedUntil: null, reservedByViewer: true });
    expect(asOther.reservedUntil).toEqual(expect.any(String));
    expect(asOther.reservedByViewer).toBe(false);
    for (const card of [asHolder, asOther]) {
      expect(card).not.toHaveProperty("reservedById");
      expect(card).not.toHaveProperty("reservedCheckoutSessionId");
    }
  });
});
