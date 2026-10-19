import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createCatalogCard, createUser } from "./helpers/factories";
import { getServerSession } from "./helpers/session";
import { idParams, req } from "./helpers/http";

/**
 * Scanned-card ingestion against a real database: the identifier's POST,
 * de-duplication, the admin review edits, and publishing into listings.
 */

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: vi.fn(async () => ({ data: {}, error: null })),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/${path}` } }),
      }),
    },
  }),
}));
vi.mock("@/lib/imageProcessing", () => ({
  compressCardImage: vi.fn(async (b: Buffer) => ({ buffer: b, contentType: "image/webp" })),
}));

import { POST as ingestItem } from "@/app/api/admin/ingest/items/route";
import { PATCH as editItem } from "@/app/api/admin/ingest/items/[id]/route";
import { POST as publishBatch } from "@/app/api/admin/ingest/batches/[id]/publish/route";
import { POST as approveConfident } from "@/app/api/admin/ingest/batches/[id]/approve-confident/route";
import { GET as getBatch, PATCH as patchBatch } from "@/app/api/admin/ingest/batches/[id]/route";
import { GET as listBatches } from "@/app/api/admin/ingest/batches/route";

const TOKEN = "test-ingest-token";
let scanN = 0;

function scan(fields: Record<string, string>, opts: { token?: string; back?: boolean; key?: string } = {}) {
  const form = new FormData();
  const bytes = `scan-${++scanN}-${Math.random()}`;
  form.set("ingestKey", opts.key ?? createHash("sha256").update(bytes).digest("hex"));
  form.set("game", "POKEMON");
  form.set("batch", "SKU-G (A)");
  form.set("confidence", "high");
  form.set("sourceFile", `SKU-G (A)${String(scanN).padStart(6, "0")}.jpg`);
  form.set("front", new File([bytes], "front.jpg", { type: "image/jpeg" }));
  if (opts.back) form.set("back", new File([bytes + "b"], "back.jpg", { type: "image/jpeg" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new NextRequest("http://localhost/api/admin/ingest/items", {
    method: "POST",
    headers: { authorization: `Bearer ${opts.token ?? TOKEN}` },
    body: form,
  });
}

const asAdmin = (id: string) => getServerSession.mockResolvedValue({ user: { id, role: "admin" } });
const patch = (id: string, body: object) => editItem(req(`/api/admin/ingest/items/${id}`, body, { method: "PATCH" }), idParams(id));
const publish = (batchId: string) => publishBatch(req(`/api/admin/ingest/batches/${batchId}/publish`, {}), idParams(batchId));

async function priced(externalId: string, cents: number[]) {
  const card = await createCatalogCard({ externalId, tcgPlayerId: `tcg-${externalId}` });
  for (const [i, priceCents] of cents.entries()) {
    await prisma.priceHistory.create({
      data: { game: "POKEMON", pokemonCardId: card.id, variant: "RAW", priceCents, capturedAt: new Date(Date.UTC(2026, 9, 1 + i)) },
    });
  }
  return card;
}

beforeEach(() => {
  process.env.INGEST_API_TOKEN = TOKEN;
  delete process.env.INGEST_OWNER_EMAIL;
});

describe("POST /api/admin/ingest/items", () => {
  it("rejects a missing or wrong token", async () => {
    expect((await ingestItem(scan({}, { token: "nope" }))).status).toBe(401);
    delete process.env.INGEST_API_TOKEN;
    expect((await ingestItem(scan({}))).status).toBe(401);
  });

  it("stores a PENDING item with the match, candidates, photos and a suggested price from the latest RAW price", async () => {
    const card = await priced("me01-016", [900, 1234]); // latest is S$12.34
    const other = await createCatalogCard({ externalId: "SV4s-016" });
    const res = await ingestItem(scan({ match: "me01-016", candidates: JSON.stringify([{ id: "SV4s-016", score: 0.4 }, { id: "nope-1" }]) }, { back: true }));
    expect(res.status).toBe(201);

    const item = await prisma.ingestItem.findFirstOrThrow();
    expect(item).toMatchObject({ status: "PENDING", pokemonCardId: card.id, marketPriceCents: 1234, priceCents: 1250, condition: "Near Mint" });
    expect(item.imageUrls).toHaveLength(2);
    expect(item.candidates).toEqual([expect.objectContaining({ catalogId: other.id, score: 0.4 })]);
    expect(await prisma.listing.count()).toBe(0); // nothing goes on sale before review
  });

  it("creates nothing new when the same scan is sent again, even at the same time", async () => {
    const key = "a".repeat(64);
    await ingestItem(scan({}, { key }));
    const res = await Promise.all([ingestItem(scan({}, { key })), ingestItem(scan({}, { key }))]);
    expect(await Promise.all(res.map((r) => r.json()))).toEqual([
      expect.objectContaining({ duplicate: true }),
      expect.objectContaining({ duplicate: true }),
    ]);
    expect(await prisma.ingestItem.count()).toBe(1);
  });

  it("puts scans with the same batch name in one open batch, even when they arrive at the same time", async () => {
    // The identifier uploads several cards at once; without the server-side lock
    // 12 simultaneous first uploads created 9-12 separate batches.
    await Promise.all(Array.from({ length: 12 }, () => ingestItem(scan({}))));
    await ingestItem(scan({}));
    expect(await prisma.ingestBatch.count()).toBe(1);
    expect(await prisma.ingestItem.count()).toBe(13);
  });
});

describe("admin review and publish", () => {
  it("fixes an unidentified card by TCGPlayer id, then publishes it once as a listing owned by the ingest account", async () => {
    const owner = await createUser({ email: "admin@pokemon.com" });
    const admin = await createUser({ role: "admin" });
    asAdmin(admin.id);
    const card = await priced("sv06-013", [2001]);
    await ingestItem(scan({ match: "", confidence: "low" }, { back: true }));
    const item = await prisma.ingestItem.findFirstOrThrow();

    expect((await patch(item.id, { status: "APPROVED" })).status).toBe(400); // no card yet
    const fixed = await (await patch(item.id, { tcgPlayerId: "tcg-sv06-013", condition: "Lightly Played" })).json();
    expect(fixed.item).toMatchObject({ card: expect.objectContaining({ catalogId: card.id }), price: 20.5, condition: "Lightly Played" });
    expect((await patch(item.id, { status: "APPROVED" })).status).toBe(200);

    const [a, b] = await Promise.all([publish(item.batchId), publish(item.batchId)]);
    const published = (await a.json()).published + (await b.json()).published;
    expect(published).toBe(1);

    const listing = await prisma.listing.findFirstOrThrow();
    expect(listing).toMatchObject({ ownerId: owner.id, pokemonCardId: card.id, price: 2050, forSale: true, condition: "Lightly Played", game: "POKEMON" });
    expect(listing.imageUrls).toHaveLength(2);
    expect(await prisma.ingestItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: "PUBLISHED", listingId: listing.id });
    expect((await patch(item.id, { price: 1 })).status).toBe(409); // listed cards are edited as listings
  });

  it("does not publish an approved card without a price", async () => {
    await createUser({ email: "admin@pokemon.com" });
    const admin = await createUser({ role: "admin" });
    asAdmin(admin.id);
    await createCatalogCard({ externalId: "base1-2" }); // no price history
    await ingestItem(scan({ match: "base1-2" }));
    const item = await prisma.ingestItem.findFirstOrThrow();
    await patch(item.id, { status: "APPROVED" });

    const body = await (await publish(item.batchId)).json();
    expect(body).toMatchObject({ published: 0, skipped: [expect.objectContaining({ skipped: "needs a price" })] });
    expect(await prisma.listing.count()).toBe(0);
  });

  it("'approve all confident' approves only confident items that have a card", async () => {
    const admin = await createUser({ role: "admin" });
    asAdmin(admin.id);
    await priced("me02-007", [500]);
    await ingestItem(scan({ match: "me02-007", confidence: "perfect" }));
    await ingestItem(scan({ match: "me02-007", confidence: "medium" }));
    await ingestItem(scan({ match: "", confidence: "high" }));
    const { batchId } = await prisma.ingestItem.findFirstOrThrow();

    const body = await (await approveConfident(req(`/x`, {}), idParams(batchId))).json();
    expect(body.approved).toBe(1);
    expect(await prisma.ingestItem.count({ where: { status: "APPROVED" } })).toBe(1);
  });

  it("refuses review actions from non-admins", async () => {
    const user = await createUser();
    getServerSession.mockResolvedValue({ user: { id: user.id, role: "user" } });
    await ingestItem(scan({}));
    const item = await prisma.ingestItem.findFirstOrThrow();
    expect((await patch(item.id, { status: "REJECTED" })).status).toBe(403);
    expect((await publish(item.batchId)).status).toBe(403);
  });

  it("shows official images for the card and its candidates, and the listing's live state", async () => {
    const owner = await createUser({ email: "admin@pokemon.com" });
    const admin = await createUser({ role: "admin" });
    asAdmin(admin.id);
    const card = await priced("me01-016", [1000]);
    await prisma.pokemonCardCatalog.update({ where: { id: card.id }, data: { imageUrl: "https://assets.tcgdex.net/en/me/me01/016/high.webp" } });
    const other = await createCatalogCard({ externalId: "SV4s-016", imageUrl: "https://assets.tcgdex.net/ja/SV/SV4s/016/high.webp" });
    await ingestItem(scan({ match: "me01-016", candidates: JSON.stringify([{ id: "SV4s-016", score: 3 }]) }));
    const item = await prisma.ingestItem.findFirstOrThrow();

    const view = async () => (await (await getBatch(req("/x"), idParams(item.batchId))).json()).items[0];
    const before = await view();
    expect(before.card.imageUrl).toBe("https://assets.tcgdex.net/en/me/me01/016/high.webp");
    expect(before.candidates).toEqual([expect.objectContaining({ catalogId: other.id, imageUrl: "https://assets.tcgdex.net/ja/SV/SV4s/016/high.webp" })]);
    expect(before.listingState).toBeNull();

    await patch(item.id, { status: "APPROVED" });
    await publish(item.batchId);
    expect((await view()).listingState).toBe("For sale");

    // A buyer's purchase moves the listing to them.
    const buyer = await createUser();
    const listing = await prisma.listing.findFirstOrThrow();
    expect(listing.ownerId).toBe(owner.id);
    await prisma.listing.update({ where: { id: listing.id }, data: { ownerId: buyer.id, forSale: false } });
    expect((await view()).listingState).toBe("Sold");
  });

  it("closing a batch hides it from the list until 'show closed', and keeps its items", async () => {
    const admin = await createUser({ role: "admin" });
    asAdmin(admin.id);
    await ingestItem(scan({}));
    const { batchId } = await prisma.ingestItem.findFirstOrThrow();
    const names = async (q = "") => (await (await listBatches(req(`/api/admin/ingest/batches${q}`))).json()).batches.map((b: { id: string }) => b.id);

    expect(await names()).toEqual([batchId]);
    expect((await patchBatch(req("/x", { status: "CLOSED" }, { method: "PATCH" }), idParams(batchId))).status).toBe(200);
    expect(await names()).toEqual([]);
    expect(await names("?closed=1")).toEqual([batchId]);
    expect(await prisma.ingestItem.count()).toBe(1);

    // A new scan under the same name starts a new open batch.
    await ingestItem(scan({}));
    expect(await prisma.ingestBatch.count({ where: { status: "OPEN" } })).toBe(1);
  });
});
