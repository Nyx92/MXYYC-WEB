import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as createAuctionRoute } from "@/app/api/auctions/route";
import { POST as bidRoute } from "@/app/api/auctions/[id]/bid/route";
import { expireAuction, settleAuction } from "@/lib/auctionSettlement";
import { createAuction, createListing, createUser } from "./helpers/factories";
import { loginAs, loginQueue } from "./helpers/session";
import { idParams, req, statuses } from "./helpers/http";
import { cancelledPIs, piStatus, refundedPIs, registerPI } from "./helpers/stripe";

const bid = (auctionId: string, paymentIntentId: string, amount: number) =>
  bidRoute(req(`/api/auctions/${auctionId}/bid`, { paymentIntentId, amount }), idParams(auctionId));

/** An auction with one active (winning) bid whose PI is authorised. */
async function auctionWithWinningBid(status: "active" | "pending_seller_decision" = "active") {
  const seller = await createUser();
  const winner = await createUser();
  const listing = await createListing(seller.id, { forSale: false });
  const auction = await createAuction(listing, { status, currentBid: 5000, highestBidderId: winner.id });
  const pi = registerPI({ id: `pi_bid_${auction.id}`, amount: 5000, metadata: { bidderId: winner.id, auctionId: auction.id } });
  await prisma.bid.create({ data: { auctionId: auction.id, bidderId: winner.id, amount: 5000, paymentIntentId: pi } });
  return { seller, winner, listing, auction, pi };
}

describe("Auctions against a real database", () => {
  it("two concurrent creates on the same listing produce exactly one auction", async () => {
    const seller = await createUser();
    const listing = await createListing(seller.id);

    loginAs(seller.id);
    const create = () => createAuctionRoute(req("/api/auctions", { cardId: listing.id, startingBid: 10, durationDays: 1 }));
    const res = await Promise.all([create(), create()]);

    expect(statuses(res)).toEqual([201, 409]);
    expect(await prisma.auction.count({ where: { listingId: listing.id } })).toBe(1);
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ inAuction: true, forSale: false });
  });

  it("two concurrent bids: one is accepted; only the loser's PaymentIntent is cancelled", async () => {
    const seller = await createUser();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id, { forSale: false });
    const auction = await createAuction(listing);
    const piA = registerPI({ id: "pi_bid_a", amount: 6000, metadata: { bidderId: a.id, auctionId: auction.id } });
    const piB = registerPI({ id: "pi_bid_b", amount: 6000, metadata: { bidderId: b.id, auctionId: auction.id } });

    loginQueue(a.id, b.id);
    const res = await Promise.all([bid(auction.id, piA, 60), bid(auction.id, piB, 60)]);

    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    const [winnerPI, loserPI] = res[0].status === 200 ? [piA, piB] : [piB, piA];
    const bids = await prisma.bid.findMany({ where: { auctionId: auction.id } });
    expect(bids).toHaveLength(1);
    expect(bids[0]).toMatchObject({ paymentIntentId: winnerPI, status: "active" });
    expect(await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({
      currentBid: 6000,
      highestBidderId: bids[0].bidderId,
      version: 1,
    });
    expect(cancelledPIs()).toEqual([loserPI]);
    expect(piStatus(winnerPI)).toBe("requires_capture");
  });

  it("an outbid bidder's hold is released and the new top bid stays live", async () => {
    const seller = await createUser();
    const [a, b] = await Promise.all([createUser(), createUser()]);
    const listing = await createListing(seller.id, { forSale: false });
    const auction = await createAuction(listing);
    const piA = registerPI({ id: "pi_first", amount: 2000, metadata: { bidderId: a.id, auctionId: auction.id } });
    const piB = registerPI({ id: "pi_second", amount: 3000, metadata: { bidderId: b.id, auctionId: auction.id } });

    loginQueue(a.id, b.id);
    expect((await bid(auction.id, piA, 20)).status).toBe(200);
    expect((await bid(auction.id, piB, 30)).status).toBe(200);

    await new Promise((r) => setTimeout(r, 10)); // cancelBidPI is fire-and-forget
    expect(piStatus(piA)).toBe("canceled");
    expect(piStatus(piB)).toBe("requires_capture");
    expect(await prisma.bid.findMany({ where: { auctionId: auction.id }, orderBy: { amount: "asc" }, select: { status: true } }))
      .toEqual([{ status: "cancelled" }, { status: "active" }]);
  });

  it("rejects a bid PI authorised for another auction without cancelling it", async () => {
    const seller = await createUser();
    const bidder = await createUser();
    const [l1, l2] = await Promise.all([createListing(seller.id, { forSale: false }), createListing(seller.id, { forSale: false })]);
    const [target, other] = [await createAuction(l1), await createAuction(l2)];
    const pi = registerPI({ id: "pi_wrong_auction", amount: 6000, metadata: { bidderId: bidder.id, auctionId: other.id } });

    loginAs(bidder.id);
    expect((await bid(target.id, pi, 60)).status).toBe(403);
    expect(await prisma.bid.count()).toBe(0);
    expect(piStatus(pi)).toBe("requires_capture");
  });

  it("settleAuction transfers ownership exactly once", async () => {
    const { seller, winner, listing, auction, pi } = await auctionWithWinningBid();

    await settleAuction(auction.id);
    await settleAuction(auction.id); // already sold → no-op

    expect(await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ ownerId: winner.id, inAuction: false });
    expect(await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } })).toMatchObject({ status: "sold" });
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ sellerId: seller.id, buyerId: winner.id, status: "PAID", amount: 5000 });
    expect(await prisma.cardTransaction.count({ where: { stripeEventId: pi } })).toBe(1);
    expect(await prisma.bid.findFirstOrThrow({ where: { paymentIntentId: pi } })).toMatchObject({ status: "won" });
    expect(refundedPIs()).toEqual([]);
  });

  // Regression: the second of two overlapping settles fails capture (already
  // captured), sees the PI as "succeeded", loses the claim, and used to
  // refund the WINNING PI. settleAuction now skips the refund when a PAID
  // order already holds that PI.
  it("two overlapping settleAuction calls do not refund the winner", async () => {
    const { winner, listing, auction } = await auctionWithWinningBid();

    await Promise.allSettled([settleAuction(auction.id), settleAuction(auction.id)]);

    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).ownerId).toBe(winner.id);
    expect(await prisma.order.count()).toBe(1);
    expect(refundedPIs()).toEqual([]);
  });

  it("settleAuction refunds the winner when the seller no longer owns the card", async () => {
    const { listing, auction, pi } = await auctionWithWinningBid();
    const newOwner = await createUser();
    await prisma.listing.update({ where: { id: listing.id }, data: { ownerId: newOwner.id } });

    await expect(settleAuction(auction.id)).rejects.toThrow(/no longer owned by the seller/);

    expect(refundedPIs()).toEqual([pi]);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).ownerId).toBe(newOwner.id);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.cardTransaction.count()).toBe(0);
  });

  it("expireAuction racing settleAuction ends in exactly one terminal state", async () => {
    const { seller, winner, listing, auction, pi } = await auctionWithWinningBid("pending_seller_decision");

    const [settled, expired] = await Promise.allSettled([
      settleAuction(auction.id),
      expireAuction(auction.id, listing.id, "pending_seller_decision"),
    ]);

    const final = await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } });
    const owner = (await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).ownerId;
    if (final.status === "sold") {
      expect(settled.status).toBe("fulfilled");
      expect(expired).toMatchObject({ status: "fulfilled", value: false });
      expect(owner).toBe(winner.id);
      expect(await prisma.order.count()).toBe(1);
      expect(refundedPIs()).toEqual([]);
    } else {
      expect(final.status).toBe("expired");
      expect(expired).toMatchObject({ status: "fulfilled", value: true });
      expect(owner).toBe(seller.id);
      expect(await prisma.order.count()).toBe(0);
      // Captured before losing the claim → must have been refunded.
      if (piStatus(pi) === "succeeded") expect(refundedPIs()).toEqual([pi]);
    }
  });

  it("expireAuction first, then settleAuction: stays expired and the hold is never kept", async () => {
    const { seller, listing, auction, pi } = await auctionWithWinningBid("pending_seller_decision");

    expect(await expireAuction(auction.id, listing.id, "pending_seller_decision")).toBe(true);
    await new Promise((r) => setTimeout(r, 10)); // cancelBidPI is fire-and-forget
    await expect(settleAuction(auction.id)).rejects.toThrow(/No active bid/);

    expect((await prisma.auction.findUniqueOrThrow({ where: { id: auction.id } })).status).toBe("expired");
    expect(await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ ownerId: seller.id, inAuction: false });
    expect(piStatus(pi)).toBe("canceled");
  });
});
