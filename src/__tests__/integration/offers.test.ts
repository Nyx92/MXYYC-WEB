import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as placeOffer } from "@/app/api/offers/route";
import { PATCH as actOnOffer } from "@/app/api/offers/[id]/route";
import { createListing, createOffer, createUser } from "./helpers/factories";
import { loginAs } from "./helpers/session";
import { idParams, req, statuses } from "./helpers/http";
import { piStatus, refundedPIs, registerPI, stripe } from "./helpers/stripe";

const offerBody = (cardId: string, paymentIntentId: string) => ({ cardId, price: 40, paymentIntentId });

describe("Offers against a real database", () => {
  it("POST rejects a PaymentIntent authorised for another buyer, without cancelling it", async () => {
    const seller = await createUser();
    const [buyer, victim] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    const pi = registerPI({ id: "pi_victim", amount: 4000, metadata: { buyerId: victim.id, cardId: listing.id } });

    loginAs(buyer.id);
    const res = await placeOffer(req("/api/offers", offerBody(listing.id, pi)));

    expect(res.status).toBe(403);
    expect(await prisma.offer.count()).toBe(0);
    expect(piStatus(pi)).toBe("requires_capture");
  });

  it("POST rejects a PaymentIntent authorised for a different card", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const [listing, otherListing] = await Promise.all([createListing(seller.id), createListing(seller.id)]);
    const pi = registerPI({ id: "pi_other_card", amount: 4000, metadata: { buyerId: buyer.id, cardId: otherListing.id } });

    loginAs(buyer.id);
    expect((await placeOffer(req("/api/offers", offerBody(listing.id, pi)))).status).toBe(403);
    expect(await prisma.offer.count()).toBe(0);
    expect(stripe.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("the unique index on Offer.paymentIntentId rejects a second offer with the same PI", async () => {
    const seller = await createUser();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    await createOffer(listing, a.id, { paymentIntentId: "pi_shared" });

    await expect(createOffer(listing, b.id, { paymentIntentId: "pi_shared" })).rejects.toMatchObject({ code: "P2002" });
  });

  it("re-submitting a PI already used on a closed offer is refused (409)", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const pi = registerPI({ id: "pi_used", amount: 4000, metadata: { buyerId: buyer.id, cardId: listing.id } });
    await createOffer(listing, buyer.id, { paymentIntentId: pi, status: "rejected" });

    loginAs(buyer.id);
    expect((await placeOffer(req("/api/offers", offerBody(listing.id, pi)))).status).toBe(409);
    expect(await prisma.offer.count()).toBe(1);
  });

  it("two simultaneous submissions of the same PI never create two offers", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const pi = registerPI({ id: "pi_double_click", amount: 4000, metadata: { buyerId: buyer.id, cardId: listing.id } });

    loginAs(buyer.id);
    const res = await Promise.all([
      placeOffer(req("/api/offers", offerBody(listing.id, pi))),
      placeOffer(req("/api/offers", offerBody(listing.id, pi))),
    ]);

    expect(res.some((r) => r.status === 201)).toBe(true);
    expect(await prisma.offer.count({ where: { paymentIntentId: pi } })).toBe(1);
  });

  it("a double-submitted amend keeps the new hold live and releases only the old one", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const offer = await createOffer(listing, buyer.id);
    registerPI({ id: offer.paymentIntentId!, amount: 4000, metadata: { buyerId: buyer.id, cardId: listing.id } });
    const pi = registerPI({ id: "pi_amend_twice", amount: 4000, metadata: { buyerId: buyer.id, cardId: listing.id } });

    loginAs(buyer.id);
    await Promise.all([
      placeOffer(req("/api/offers", offerBody(listing.id, pi))),
      placeOffer(req("/api/offers", offerBody(listing.id, pi))),
    ]);
    // A plain retry after both finished must also be a no-op.
    await placeOffer(req("/api/offers", offerBody(listing.id, pi)));

    const after = await prisma.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(after.paymentIntentId).toBe(pi);
    expect(piStatus(pi)).not.toBe("canceled");
    expect(piStatus(offer.paymentIntentId!)).toBe("canceled");
  });

  it("two concurrent accepts of different offers on one card: one buyer gets it, the other is made whole", async () => {
    const seller = await createUser();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id);
    const offerA = await createOffer(listing, a.id);
    const offerB = await createOffer(listing, b.id);
    for (const o of [offerA, offerB]) {
      registerPI({ id: o.paymentIntentId!, amount: 4000, metadata: { buyerId: o.buyerId, cardId: listing.id } });
    }

    loginAs(seller.id);
    const res = await Promise.all(
      [offerA, offerB].map((o) => actOnOffer(req(`/api/offers/${o.id}`, { action: "accept" }, { method: "PATCH" }), idParams(o.id)))
    );

    expect(statuses(res)).toEqual([200, 409]);
    const winner = res[0].status === 200 ? offerA : offerB;
    const loser = winner === offerA ? offerB : offerA;
    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(after.ownerId).toBe(winner.buyerId);
    expect(await prisma.order.count({ where: { status: "PAID" } })).toBe(1);
    expect(await prisma.cardTransaction.count()).toBe(1);
    expect((await prisma.offer.findUniqueOrThrow({ where: { id: winner.id } })).status).toBe("paid");
    // The loser is either refused before capture or captured-then-refunded —
    // never left charged, and the winner is never refunded.
    expect(refundedPIs()).not.toContain(winner.paymentIntentId);
    if (piStatus(loser.paymentIntentId!) === "succeeded") {
      expect(refundedPIs()).toEqual([loser.paymentIntentId]);
    } else {
      expect(stripe.refunds.create).not.toHaveBeenCalled();
    }
  });

  it("a double-clicked accept of the same offer captures once", async () => {
    const seller = await createUser();
    const buyer = await createUser();
    const listing = await createListing(seller.id);
    const offer = await createOffer(listing, buyer.id);
    registerPI({ id: offer.paymentIntentId!, amount: 4000, metadata: { buyerId: buyer.id, cardId: listing.id } });

    loginAs(seller.id);
    const accept = () => actOnOffer(req(`/api/offers/${offer.id}`, { action: "accept" }, { method: "PATCH" }), idParams(offer.id));
    const res = await Promise.all([accept(), accept()]);

    expect(statuses(res)).toEqual([200, 409]);
    expect(stripe.paymentIntents.capture).toHaveBeenCalledTimes(1);
    expect(await prisma.order.count()).toBe(1);
    expect(stripe.refunds.create).not.toHaveBeenCalled();
  });
});
