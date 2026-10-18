import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { POST as createRequest } from "@/app/api/collection-requests/route";
import { POST as confirmPickup } from "@/app/api/collection-requests/[id]/otp/confirm/route";
import { POST as createAuction } from "@/app/api/auctions/route";
import { hashVerificationCode } from "@/lib/verificationCode";
import { createListing, createUser } from "./helpers/factories";
import { loginAs } from "./helpers/session";
import { idParams, req } from "./helpers/http";

const requestPickup = (listingIds: string[]) => createRequest(req("/api/collection-requests", { listingIds }));

describe("Collection requests against a real database", () => {
  it("refuses to attach a card that is for sale", async () => {
    const owner = await createUser();
    const listing = await createListing(owner.id, { forSale: true });

    loginAs(owner.id);
    expect((await requestPickup([listing.id])).status).toBe(409);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).collectionRequestId).toBeNull();
  });

  it("refuses to attach a card that is in an auction", async () => {
    const owner = await createUser();
    const listing = await createListing(owner.id, { forSale: false, inAuction: true });

    loginAs(owner.id);
    expect((await requestPickup([listing.id])).status).toBe(409);
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } })).collectionRequestId).toBeNull();
  });

  it("attaches nothing when one card in the batch is ineligible (all-or-nothing)", async () => {
    const owner = await createUser();
    const ok = await createListing(owner.id, { forSale: false });
    const forSale = await createListing(owner.id, { forSale: true });

    loginAs(owner.id);
    expect((await requestPickup([ok.id, forSale.id])).status).toBe(409);
    expect(await prisma.listing.count({ where: { collectionRequestId: { not: null } } })).toBe(0);
  });

  it("a collection request racing an auction create on the same card: exactly one wins", async () => {
    const owner = await createUser();
    const listing = await createListing(owner.id, { forSale: false });

    loginAs(owner.id);
    await Promise.all([
      requestPickup([listing.id]),
      createAuction(req("/api/auctions", { cardId: listing.id, startingBid: 10, durationDays: 1 })),
    ]);

    const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
    const auctions = await prisma.auction.count({ where: { listingId: listing.id } });
    expect(Number(after.collectionRequestId !== null) + auctions).toBe(1);
    expect(after.inAuction).toBe(auctions === 1);
  });

  it("OTP confirm marks only cards the requester still owns as collected", async () => {
    const owner = await createUser();
    const buyer = await createUser();
    const request = await prisma.collectionRequest.create({
      data: {
        requestRef: "PU-T-OTP",
        userId: owner.id,
        status: "PACKED",
        pickupCodeHash: hashVerificationCode("123456"),
        pickupCodeExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const kept = await createListing(owner.id, { forSale: false, collectionRequestId: request.id });
    const sold = await createListing(owner.id, { forSale: false, collectionRequestId: request.id });
    await prisma.listing.update({ where: { id: sold.id }, data: { ownerId: buyer.id } });

    loginAs(owner.id);
    const res = await confirmPickup(req(`/api/collection-requests/${request.id}/otp/confirm`, { code: "123456" }), idParams(request.id));

    expect(res.status).toBe(200);
    expect(await prisma.collectionRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({
      status: "COLLECTED",
      pickupCodeHash: null,
    });
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: kept.id } })).collectedAt).not.toBeNull();
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: sold.id } })).collectedAt).toBeNull();
  });

  it("OTP confirm racing a top-up: the top-up wins or the pickup completes, never a half state", async () => {
    const owner = await createUser();
    const request = await prisma.collectionRequest.create({
      data: {
        requestRef: "PU-T-RACE",
        userId: owner.id,
        status: "PACKED",
        pickupCodeHash: hashVerificationCode("654321"),
        pickupCodeExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const packed = await createListing(owner.id, { forSale: false, collectionRequestId: request.id });
    const extra = await createListing(owner.id, { forSale: false });

    loginAs(owner.id);
    await Promise.all([
      confirmPickup(req(`/api/collection-requests/${request.id}/otp/confirm`, { code: "654321" }), idParams(request.id)),
      requestPickup([extra.id]),
    ]);

    const final = await prisma.collectionRequest.findUniqueOrThrow({ where: { id: request.id } });
    const packedAfter = await prisma.listing.findUniqueOrThrow({ where: { id: packed.id } });
    const extraAfter = await prisma.listing.findUniqueOrThrow({ where: { id: extra.id } });
    if (final.status === "COLLECTED") {
      expect(packedAfter.collectedAt).not.toBeNull();
      // The top-up must not have joined a collected request.
      expect(extraAfter.collectionRequestId).not.toBe(request.id);
    } else {
      expect(final.status).toBe("REQUESTED");
      expect(packedAfter.collectedAt).toBeNull();
      expect(extraAfter.collectionRequestId).toBe(request.id);
    }
  });
});
