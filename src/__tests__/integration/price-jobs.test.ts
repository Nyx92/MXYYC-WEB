import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import type { JustTcgVariant } from "@/lib/pricing/justtcg";
import { createCatalogCard, createListing, createUser } from "./helpers/factories";
import { req } from "./helpers/http";

const justtcg = vi.hoisted(() => ({ fetchCardVariants: vi.fn(), fetchCardVariantsBatch: vi.fn() }));
vi.mock("@/lib/pricing/justtcg", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pricing/justtcg")>()),
  ...justtcg,
}));

import { GET as backfill } from "@/app/api/cron/backfill-prices/route";
import { GET as refresh } from "@/app/api/cron/refresh-prices/route";

const cron = (handler: typeof backfill, path: string) =>
  handler(req(path, undefined, { headers: { authorization: "Bearer test-cron-secret" } }));

const daysAgo = (n: number) => Math.floor((Date.now() - n * 86_400_000) / 1000);

function v2Variants(price: number): JustTcgVariant[] {
  return [
    {
      type: "raw",
      condition: "Near Mint",
      grading: null,
      markets: [{ currency: "USD", price, price_history: [{ t: daysAgo(20), p: price - 2 }, { t: daysAgo(10), p: price - 1 }] }],
    },
    { type: "graded", condition: null, grading: { company: "PSA", grade: 10 }, markets: [{ currency: "USD", price: price * 5 }] },
  ];
}

/** (card, variant, day) groups with more than one row — must always be empty. */
const duplicateRows = () => prisma.$queryRaw<unknown[]>`
  SELECT "pokemonCardId", "riftboundCardId", variant, "capturedAt", count(*)::int AS n
  FROM "PriceHistory" GROUP BY 1, 2, 3, 4 HAVING count(*) > 1`;

async function listedCard() {
  const card = await createCatalogCard({ tcgPlayerId: `tcg-${Math.random().toString(36).slice(2)}` });
  await createListing((await createUser()).id, { pokemonCardId: card.id });
  return card;
}

beforeEach(() => {
  justtcg.fetchCardVariants.mockReset().mockResolvedValue(v2Variants(10));
  justtcg.fetchCardVariantsBatch.mockReset().mockImplementation(async (ids: string[]) =>
    new Map(ids.map((id) => [id, [{ type: "raw", condition: "Near Mint", grading: null, markets: [{ currency: "USD", price: 10 }] }]]))
  );
});

describe("Price cron jobs against a real database", () => {
  it("backfill writes a year of history, marks the card, and a rerun adds no duplicate days", async () => {
    const card = await listedCard();

    const res = await cron(backfill, "/api/cron/backfill-prices");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ backfilled: 1, failed: 0, paused: false });

    const rows = await prisma.priceHistory.count({ where: { pokemonCardId: card.id } });
    expect(rows).toBe(4); // RAW × 3 days + PSA 10 today
    expect((await prisma.pokemonCardCatalog.findUniqueOrThrow({ where: { id: card.id } })).priceBackfilledAt).not.toBeNull();

    // Backfilled cards leave the queue: a plain rerun makes no JustTCG call.
    await cron(backfill, "/api/cron/backfill-prices");
    expect(justtcg.fetchCardVariants).toHaveBeenCalledTimes(1);

    // Forced re-pull (queue reset) updates the same days instead of duplicating them.
    await prisma.pokemonCardCatalog.update({ where: { id: card.id }, data: { priceBackfilledAt: null } });
    justtcg.fetchCardVariants.mockResolvedValue(v2Variants(12));
    await cron(backfill, "/api/cron/backfill-prices");
    expect(await prisma.priceHistory.count({ where: { pokemonCardId: card.id } })).toBe(rows);
    expect(await duplicateRows()).toEqual([]);
  });

  it("refresh writes today's price once per (card, variant, day) and marks priceRefreshedAt", async () => {
    const card = await listedCard();

    const res = await cron(refresh, "/api/cron/refresh-prices");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rawRefreshed: 1, failed: 0 });
    const first = await prisma.pokemonCardCatalog.findUniqueOrThrow({ where: { id: card.id } });
    expect(first.priceRefreshedAt).not.toBeNull();
    const rows = await prisma.priceHistory.findMany({ where: { pokemonCardId: card.id } });
    expect(rows.map((r) => r.variant)).toEqual(["RAW"]);

    // Same-day rerun after the card becomes due again: updated, not duplicated.
    await prisma.pokemonCardCatalog.update({ where: { id: card.id }, data: { priceRefreshedAt: null } });
    justtcg.fetchCardVariantsBatch.mockImplementation(async (ids: string[]) =>
      new Map(ids.map((id) => [id, [{ type: "raw", condition: "Near Mint", grading: null, markets: [{ currency: "USD", price: 20 }] }]]))
    );
    await cron(refresh, "/api/cron/refresh-prices");
    const after = await prisma.priceHistory.findMany({ where: { pokemonCardId: card.id } });
    expect(after).toHaveLength(1);
    expect(after[0].priceCents).toBeGreaterThan(rows[0].priceCents);
    expect(await duplicateRows()).toEqual([]);
  });

  it("refresh then backfill on the same day share today's row", async () => {
    const card = await listedCard();

    await cron(refresh, "/api/cron/refresh-prices");
    await cron(backfill, "/api/cron/backfill-prices");

    expect(await duplicateRows()).toEqual([]);
    expect(await prisma.priceHistory.count({ where: { pokemonCardId: card.id, variant: "RAW" } })).toBe(3);
  });

  it("backfill pauses when the saved JustTCG quota is below the 2000-call reserve", async () => {
    const card = await listedCard();
    await prisma.jobState.create({
      data: {
        job: "justtcg-quota",
        lastRunAt: new Date(),
        lastOk: true,
        lastSummary: "",
        data: { monthlyRemaining: 1999, monthlyLimit: 10000, dailyLimit: null, dailyRemaining: null, plan: null, at: new Date().toISOString() },
      },
    });

    const res = await cron(backfill, "/api/cron/backfill-prices");

    expect(await res.json()).toMatchObject({ backfilled: 0, paused: true, monthlyRemaining: 1999 });
    expect(justtcg.fetchCardVariants).not.toHaveBeenCalled();
    expect((await prisma.pokemonCardCatalog.findUniqueOrThrow({ where: { id: card.id } })).priceBackfilledAt).toBeNull();
    expect((await prisma.jobState.findUniqueOrThrow({ where: { job: "backfill-prices" } })).data).toMatchObject({ paused: true });
  });

  it("backfill runs when the saved quota is at or above the reserve", async () => {
    await listedCard();
    await prisma.jobState.create({
      data: {
        job: "justtcg-quota",
        lastRunAt: new Date(),
        lastOk: true,
        lastSummary: "",
        data: { monthlyRemaining: 2000, at: new Date().toISOString() },
      },
    });

    expect(await (await cron(backfill, "/api/cron/backfill-prices")).json()).toMatchObject({ backfilled: 1, paused: false });
  });

  // Regression: two overlapping slices (a slow run + the next trigger, or a
  // manual curl) used to both see "no row yet" and both insert. The
  // find-then-createMany step now runs under withPriceHistoryLock.
  it("two overlapping refresh slices do not duplicate today's row", async () => {
    await listedCard();
    // Hold both slices at the JustTCG call until both have picked their cards.
    const real = justtcg.fetchCardVariantsBatch.getMockImplementation()!;
    let release!: () => void;
    const bothFetching = new Promise<void>((r) => (release = r));
    justtcg.fetchCardVariantsBatch.mockImplementation(async (ids: string[]) => {
      if (justtcg.fetchCardVariantsBatch.mock.calls.length === 2) release();
      await bothFetching;
      return real(ids);
    });
    await Promise.all([cron(refresh, "/api/cron/refresh-prices"), cron(refresh, "/api/cron/refresh-prices")]);
    expect(await duplicateRows()).toEqual([]);
  });
});

describe("PriceHistory protection", () => {
  async function cardWithHistory() {
    const card = await createCatalogCard({ tcgPlayerId: `tcg-${Math.random().toString(36).slice(2)}` });
    await prisma.priceHistory.create({
      data: { game: "POKEMON", pokemonCardId: card.id, variant: "RAW", priceCents: 100, capturedAt: new Date("2026-01-01") },
    });
    return card;
  }

  it("blocks DELETE and TRUNCATE on PriceHistory", async () => {
    await cardWithHistory();
    await expect(prisma.priceHistory.deleteMany()).rejects.toThrow(/cannot be deleted/);
    await expect(prisma.$executeRawUnsafe(`TRUNCATE "PriceHistory"`)).rejects.toThrow(/cannot be deleted/);
    expect(await prisma.priceHistory.count()).toBe(1);
  });

  it("blocks deleting a catalog card that has price history", async () => {
    const card = await cardWithHistory();
    await expect(prisma.pokemonCardCatalog.delete({ where: { id: card.id } })).rejects.toThrow();
    expect(await prisma.priceHistory.count()).toBe(1);
  });

  it("allows a delete inside a transaction that turns the block off", async () => {
    await cardWithHistory();
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL mxyyc.allow_price_history_delete = 'on'`),
      prisma.priceHistory.deleteMany(),
    ]);
    expect(await prisma.priceHistory.count()).toBe(0);
  });
});
