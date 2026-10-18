import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { usdToSgdCents } from "@/lib/money";
import {
  fetchCardVariants,
  fetchCardVariantsBatch,
  pickPricedVariants,
  usdMarket,
  chunk,
  runWithConcurrency,
} from "@/lib/pricing/justtcg";
import { toPriceVariantLabel } from "@/app/utils/mapCondition";
import { postCronResult } from "@/lib/discord";
import { recordJobRun, saveJustTcgQuota } from "@/lib/jobState";

/**
 * GET /api/cron/refresh-prices ← schedule: every 30 minutes (cron-job.org)
 * POST /api/cron/refresh-prices ← kept for local curl testing
 *
 * Writes *today's* price (never history — see backfill-prices for that).
 * Runs in short slices because cron-job.org closes requests after 30 s and
 * JustTCG's Starter plan allows 10,000 calls a month: each call does at most
 * ~15 s of work, picks up where the last one stopped, and costs 0 JustTCG
 * calls when nothing is due (≤ ~15 s of new work per slice). Priority:
 *
 *   1. Listed cards not refreshed today → a daily price for every card
 *      someone is actually selling (few calls).
 *   2. Every other catalog card not refreshed in the last 7 days → a weekly
 *      price for the whole catalog (~330 calls a week at ~32k cards).
 *
 * Raw prices use JustTCG's v1 batch endpoint (100 cards per call); graded
 * prices need v2, one call per *listed* card with a graded listing.
 * `priceRefreshedAt` on the catalog row records each attempt, including
 * cards JustTCG has no price for, so those don't get retried every slice.
 *
 * Status is recorded in JobState; Discord hears only about status changes
 * (see src/lib/jobState.ts) and the daily /api/cron/report-prices digest.
 *
 * For local testing:
 *   curl http://localhost:3000/api/cron/refresh-prices \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

type CardRef = {
  catalogIdField: "pokemonCardId" | "riftboundCardId";
  catalogId: string;
  game: "POKEMON" | "RIFTBOUND";
  tcgPlayerId: string;
  language?: string;
};

type PriceWrite = {
  catalogIdField: "pokemonCardId" | "riftboundCardId";
  catalogId: string;
  game: "POKEMON" | "RIFTBOUND";
  variant: string;
  priceCents: number;
};

// JustTCG calls (and this file's own DB writes) for different cards don't
// depend on each other, so several run at once instead of strictly one after
// another. Bounded to the Supabase pooler's connection_limit=5
// (src/lib/prisma.ts) since the graded path's per-card fetch also triggers
// database reads/writes.
const FETCH_CONCURRENCY = 5;

// Stop starting new work after this long, so a slice always finishes inside
// cron-job.org's 30 s request timeout.
const TIME_BUDGET_MS = 15_000;
// At most this many raw batch calls (100 cards each) per slice.
const MAX_BATCHES_PER_SLICE = 12;
const CATALOG_REFRESH_DAYS = 7;

/**
 * Writes a whole set of today's prices in a small, fixed number of queries
 * instead of one round trip per row. PriceHistory has no single column that's
 * always non-null across both games, so Postgres can't enforce a real unique
 * constraint across (pokemonCardId, riftboundCardId, variant, capturedAt) —
 * a unique index treats any row with a null column as distinct from every
 * other row, so it silently allows duplicates instead of rejecting them, on
 * both games (one of the two ID columns is null on every row). That rules
 * out a native `upsert`, so this instead mirrors backfillVariant's read-many
 * -then-write-many shape: one findMany per game covering every card being
 * written this call, one createMany for the rows that don't exist yet, and
 * an update only for the rare same-day rerun that actually collides.
 */
async function writePricesInBulk(writes: PriceWrite[], capturedAt: Date) {
  async function writeGroup(catalogIdField: "pokemonCardId" | "riftboundCardId", group: PriceWrite[]) {
    if (group.length === 0) return;
    const catalogIds = [...new Set(group.map((w) => w.catalogId))];
    const existingRows = await prisma.priceHistory.findMany({
      where: { [catalogIdField]: { in: catalogIds }, capturedAt },
      select: { id: true, [catalogIdField]: true, variant: true },
    });
    const existingIdByKey = new Map(
      existingRows.map((r) => [`${(r as Record<string, unknown>)[catalogIdField]}|${r.variant}`, r.id])
    );

    const toCreate: { game: string; [key: string]: unknown }[] = [];
    const toUpdate: { id: string; priceCents: number }[] = [];
    for (const w of group) {
      const existingId = existingIdByKey.get(`${w.catalogId}|${w.variant}`);
      if (existingId) {
        toUpdate.push({ id: existingId, priceCents: w.priceCents });
      } else {
        toCreate.push({
          game: w.game,
          [catalogIdField]: w.catalogId,
          variant: w.variant,
          priceCents: w.priceCents,
          capturedAt,
        });
      }
    }
    if (toCreate.length > 0) await prisma.priceHistory.createMany({ data: toCreate as never[] });
    // Rare (only a same-day rerun collides here), but if it does happen it can
    // be every row in the batch — run these concurrently, capped like every
    // other DB-writing loop in this file, instead of one round trip at a time.
    await runWithConcurrency(toUpdate, FETCH_CONCURRENCY, (u) =>
      prisma.priceHistory.update({ where: { id: u.id }, data: { priceCents: u.priceCents } })
    );
  }

  await writeGroup(
    "pokemonCardId",
    writes.filter((w) => w.catalogIdField === "pokemonCardId")
  );
  await writeGroup(
    "riftboundCardId",
    writes.filter((w) => w.catalogIdField === "riftboundCardId")
  );
}

async function runRefresh(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.CRON_SECRET;

  if (!expectedToken) {
    console.error("[cron/refresh-prices] CRON_SECRET env var is not set");
    await postCronResult({
      job: "refresh-prices",
      ok: false,
      summary: "Server misconfiguration: CRON_SECRET env var is not set.",
    });
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }
  // Not alerted on Discord: a wrong/missing token is what any unauthenticated
  // caller (a scanner, a stale cron-job.org config) gets, not a signal about
  // whether the job itself is healthy — alerting here would just be noise.
  if (authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return await refreshPrices();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/refresh-prices] Crashed:", msg);
    await recordJobRun("refresh-prices", { ok: false, summary: `Crashed: ${msg}` });
    return NextResponse.json({ error: "refresh-prices crashed", message: msg }, { status: 500 });
  }
}

async function refreshPrices(): Promise<NextResponse> {
  const startedAt = Date.now();
  const now = new Date();
  const capturedAt = new Date(now.toISOString().slice(0, 10));
  const startOfToday = capturedAt; // UTC midnight — same day boundary as capturedAt
  const weekAgo = new Date(now.getTime() - CATALOG_REFRESH_DAYS * 24 * 60 * 60 * 1000);
  const cap = MAX_BATCHES_PER_SLICE * 100;

  const listedDue = { tcgPlayerId: { not: null }, listings: { some: {} }, OR: [{ priceRefreshedAt: null }, { priceRefreshedAt: { lt: startOfToday } }] };
  const catalogDue = { tcgPlayerId: { not: null }, OR: [{ priceRefreshedAt: null }, { priceRefreshedAt: { lt: weekAgo } }] };
  const oldestFirst = [{ priceRefreshedAt: { sort: "asc" as const, nulls: "first" as const } }, { id: "asc" as const }];

  // 1. Listed cards due today (both games), then 2. catalog cards due this week.
  const [listedPokemon, listedRiftbound] = await Promise.all([
    prisma.pokemonCardCatalog.findMany({ where: listedDue, select: { id: true, tcgPlayerId: true, language: true }, take: cap }),
    prisma.riftboundCardCatalog.findMany({ where: listedDue, select: { id: true, tcgPlayerId: true }, take: cap }),
  ]);
  const toRef = (game: "POKEMON" | "RIFTBOUND") => (c: { id: string; tcgPlayerId: string | null; language?: string }): CardRef => ({
    catalogIdField: game === "POKEMON" ? "pokemonCardId" : "riftboundCardId",
    catalogId: c.id,
    game,
    tcgPlayerId: c.tcgPlayerId as string,
    language: c.language,
  });
  const listedCards = [...listedPokemon.map(toRef("POKEMON")), ...listedRiftbound.map(toRef("RIFTBOUND"))].slice(0, cap);

  let catalogCards: CardRef[] = [];
  if (listedCards.length < cap) {
    const seen = new Set(listedCards.map((c) => c.catalogId));
    const room = cap - listedCards.length;
    const riftbound = await prisma.riftboundCardCatalog.findMany({ where: catalogDue, select: { id: true, tcgPlayerId: true }, orderBy: oldestFirst, take: room });
    const pokemon = riftbound.length < room
      ? await prisma.pokemonCardCatalog.findMany({ where: catalogDue, select: { id: true, tcgPlayerId: true, language: true }, orderBy: oldestFirst, take: room - riftbound.length })
      : [];
    catalogCards = [...riftbound.map(toRef("RIFTBOUND")), ...pokemon.map(toRef("POKEMON"))].filter((c) => !seen.has(c.catalogId));
  }

  const results = { rawRefreshed: 0, gradedRefreshed: 0, failed: 0, errors: [] as string[], stoppedForTime: false };
  const markRefreshed = async (cards: CardRef[]) => {
    const pokemonIds = cards.filter((c) => c.game === "POKEMON").map((c) => c.catalogId);
    const riftboundIds = cards.filter((c) => c.game === "RIFTBOUND").map((c) => c.catalogId);
    if (pokemonIds.length) await prisma.pokemonCardCatalog.updateMany({ where: { id: { in: pokemonIds } }, data: { priceRefreshedAt: now } });
    if (riftboundIds.length) await prisma.riftboundCardCatalog.updateMany({ where: { id: { in: riftboundIds } }, data: { priceRefreshedAt: now } });
  };

  // ── Raw prices: batched, 100 cards per call ────────────────────────────
  const refreshedRaw: CardRef[] = [];
  for (const batch of chunk([...listedCards, ...catalogCards], 100)) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      results.stoppedForTime = true;
      break;
    }
    try {
      const byTcgId = await fetchCardVariantsBatch(batch.map((c) => c.tcgPlayerId));
      const writes: PriceWrite[] = [];
      for (const card of batch) {
        const variants = byTcgId.get(card.tcgPlayerId) ?? [];
        for (const { label, variant } of pickPricedVariants(variants)) {
          const market = usdMarket(variant);
          if (!market) continue;
          writes.push({
            catalogIdField: card.catalogIdField,
            catalogId: card.catalogId,
            game: card.game,
            variant: label,
            priceCents: usdToSgdCents(market.price),
          });
        }
      }
      await writePricesInBulk(writes, capturedAt);
      await markRefreshed(batch);
      // Counted only once the write landed — a failed write lands in `failed`.
      results.rawRefreshed += batch.length;
      refreshedRaw.push(...batch);
    } catch (err) {
      results.failed += batch.length;
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Batch of ${batch.length} starting at ${batch[0]?.tcgPlayerId}: ${msg}`);
      console.error("[cron/refresh-prices] Batch failed:", msg);
    }
  }

  // ── Graded prices: one v2 call per refreshed *listed* card with a graded listing ─
  const listedIds = new Set(listedCards.map((c) => c.catalogId));
  const refreshedListed = refreshedRaw.filter((c) => listedIds.has(c.catalogId));
  const [pokemonListings, riftboundListings] = refreshedListed.length
    ? await Promise.all([
        prisma.listing.findMany({ where: { pokemonCardId: { in: refreshedListed.map((c) => c.catalogId) } }, select: { condition: true, pokemonCardId: true } }),
        prisma.listing.findMany({ where: { riftboundCardId: { in: refreshedListed.map((c) => c.catalogId) } }, select: { condition: true, riftboundCardId: true } }),
      ])
    : [[], []];
  const gradedIds = new Set([
    ...pokemonListings.filter((l) => toPriceVariantLabel(l.condition) !== "RAW").map((l) => l.pokemonCardId),
    ...riftboundListings.filter((l) => toPriceVariantLabel(l.condition) !== "RAW").map((l) => l.riftboundCardId),
  ]);
  const gradedCards = refreshedListed.filter((c) => gradedIds.has(c.catalogId));

  const gradedWrites: PriceWrite[] = [];
  await runWithConcurrency(gradedCards, FETCH_CONCURRENCY, async (card) => {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      results.stoppedForTime = true;
      return; // its raw price is in; the graded price waits for tomorrow
    }
    try {
      const variants = await fetchCardVariants({
        tcgPlayerId: card.tcgPlayerId,
        game: card.game,
        language: card.language,
      });
      const gradedPicks = pickPricedVariants(variants).filter((p) => p.label !== "RAW");
      for (const { label, variant } of gradedPicks) {
        const market = usdMarket(variant);
        if (!market) continue;
        gradedWrites.push({
          catalogIdField: card.catalogIdField,
          catalogId: card.catalogId,
          game: card.game,
          variant: label,
          priceCents: usdToSgdCents(market.price),
        });
      }
      results.gradedRefreshed++;
    } catch (err) {
      results.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Graded card ${card.catalogId}: ${msg}`);
      console.error("[cron/refresh-prices] Failed graded card:", card.catalogId, msg);
    }
  });
  await writePricesInBulk(gradedWrites, capturedAt);

  const [listedLeft, catalogLeft] = await Promise.all([
    Promise.all([prisma.pokemonCardCatalog.count({ where: listedDue }), prisma.riftboundCardCatalog.count({ where: listedDue })]).then(([a, b]) => a + b),
    Promise.all([prisma.pokemonCardCatalog.count({ where: catalogDue }), prisma.riftboundCardCatalog.count({ where: catalogDue })]).then(([a, b]) => a + b),
  ]);

  const summary =
    `Raw: ${results.rawRefreshed}, Graded: ${results.gradedRefreshed}, Failed: ${results.failed}. ` +
    `Still due — listed today: ${listedLeft}, catalog (>${CATALOG_REFRESH_DAYS}d): ${catalogLeft}`;
  console.log(`[cron/refresh-prices] Done. ${summary}`);
  await saveJustTcgQuota();
  await recordJobRun("refresh-prices", {
    ok: results.failed === 0,
    summary,
    errors: results.errors,
    data: { rawRefreshed: results.rawRefreshed, gradedRefreshed: results.gradedRefreshed, failed: results.failed, listedLeft, catalogLeft },
  });

  return NextResponse.json({
    rawRefreshed: results.rawRefreshed,
    gradedRefreshed: results.gradedRefreshed,
    failed: results.failed,
    remaining: { listedDueToday: listedLeft, catalogDue: catalogLeft },
    stoppedForTime: results.stoppedForTime,
    ...(results.errors.length > 0 && { errors: results.errors }),
  });
}

export const GET = runRefresh;
export const POST = runRefresh;
