import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as checkout } from "@/app/api/checkout/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { createListing, createOffer, createUser } from "./helpers/factories";
import { loginAs } from "./helpers/session";
import { req } from "./helpers/http";
import { refundedPIs, stripe } from "./helpers/stripe";

/** Runs a real Buy Now checkout and returns the completed-session event Stripe would send. */
async function paidCheckout(buyerId: string, listingId: string, eventId = `evt_${buyerId}`) {
  loginAs(buyerId);
  const res = await checkout(req("/api/checkout", { cardId: listingId }));
  expect(res.status).toBe(200);
  const calls = stripe.checkout.sessions.create.mock.calls;
  const created = await stripe.checkout.sessions.create.mock.results[calls.length - 1].value;
  const { metadata } = calls[calls.length - 1][0];
  return {
    id: eventId,
    type: "checkout.session.completed",
    data: { object: { id: created.id, payment_status: "paid", payment_intent: `pi_${eventId}`, metadata } },
  };
}

const deliver = (event: object) =>
  webhook(req("/api/stripe/webhook", event, { headers: { "stripe-signature": "t=1,v1=fake" } }));

describe("POST /api/stripe/webhook against a real database", () => {
  it("checkout.session.completed transfers ownership, records the sale and archives offers", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const bidder = await createUser();
    const listing = await createListing(seller.id);
    const offer = await createOffer(listing, bidder.id);
    const event = await paidCheckout(buyer.id, listing.id);

    expect((await deliver(event)).status).toBe(200);

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after).toMatchObject({ ownerId: buyer.id, forSale: false, price: null, reservedById: null, reservedCheckoutSessionId: null });
    const order = await prisma.order.findFirstOrThrow({ where: { listingId: listing.id } });
    expect(order).toMatchObject({ status: "PAID", stripePaymentIntentId: event.data.object.payment_intent });
    expect(await prisma.cardTransaction.count({ where: { orderId: order.id, stripeEventId: event.id } })).toBe(1);
    const archived = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("a duplicate delivery (sequential) neither re-transfers nor refunds", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const event = await paidCheckout(buyer.id, listing.id);

    expect((await deliver(event)).status).toBe(200);
    expect((await deliver(event)).status).toBe(200);

    expect(await prisma.cardTransaction.count()).toBe(1);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).ownerId).toBe(buyer.id);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("two simultaneous deliveries of the same event: one sale, no refund", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const event = await paidCheckout(buyer.id, listing.id);

    const res = await Promise.all([deliver(event), deliver(event)]);

    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.cardTransaction.count()).toBe(1);
    expect(await prisma.order.count({ where: { status: "PAID" } })).toBe(1);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).ownerId).toBe(buyer.id);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });

  it("refunds the buyer when their reservation lapsed and another buyer took the card", async () => {
    const seller = await createUser();
    const late = await createUser();
    const other = await createUser();
    const listing = await createListing(seller.id);
    const lateEvent = await paidCheckout(late.id, listing.id);
    // The 15-minute hold lapses and a second buyer reserves the card (which
    // expires the late buyer's session). If a payment still lands — the
    // safety net — it must be refunded.
    await prisma.listing.update({ where: { id: listing.id }, data: { reservedUntil: new Date(Date.now() - 1000) } });
    await paidCheckout(other.id, listing.id);

    expect((await deliver(lateEvent)).status).toBe(200);

    expect(refundedPIs()).toEqual([lateEvent.data.object.payment_intent]);
    const lateOrder = await prisma.order.findUniqueOrThrow({ where: { id: lateEvent.data.object.metadata.orderId } });
    expect(lateOrder.status).toBe("REFUNDED");
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.ownerId).toBe(seller.id);
    expect(after.reservedById).toBe(other.id);
    expect(await prisma.cardTransaction.count()).toBe(0);

    // Stripe retrying the same event must not refund twice.
    expect((await deliver(lateEvent)).status).toBe(200);
    expect(stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  it("refunds when the listing was released (session expired) before payment completed", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const event = await paidCheckout(buyer.id, listing.id);
    await prisma.listing.update({
      where: { id: listing.id },
      data: { reservedById: null, reservedUntil: null, reservedCheckoutSessionId: null },
    });

    expect((await deliver(event)).status).toBe(200);

    expect(refundedPIs()).toEqual([event.data.object.payment_intent]);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).ownerId).toBe(seller.id);
    expect(await prisma.order.count({ where: { status: "PAID" } })).toBe(0);
  });
});
