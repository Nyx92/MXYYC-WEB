import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { usdToSgdCents } from "@/lib/money";
import {
  fetchCardVariants,
  pickPricedVariants,
  usdMarket,
  runWithConcurrency,
  getLastJustTcgQuota,
  type JustTcgMarket,
} from "@/lib/pricing/justtcg";
import { loadJustTcgQuota, recordJobRun, saveJustTcgQuota } from "@/lib/jobState";
import { postCronResult } from "@/lib/discord";

/**
 * GET /api/cron/backfill-prices ← schedule: every hour (cron-job.org)
 * POST /api/cron/backfill-prices ← kept for local curl testing
 *
 * The EXPENSIVE, occasional half of the two-tier pricing strategy (see also
 * /api/cron/refresh-prices for the cheap, frequent half). Pulls up to a full
 * year of daily history per card from JustTCG's v2 endpoint — the only one
 * that supports both graded prices and a configurable history window — one
 * call per card, since v2 has no batch mode.
 *
 * Self-resuming: a card is marked `priceBackfilledAt` once it succeeds, so a
 * card is only ever deep-pulled once, not re-pulled every run. Each
 * invocation processes at most `limit` cards (default 500, capped at 950)
 * to stay comfortably under JustTCG's 1,000-request daily cap even
 * alongside other calls made the same day. Run it again (same day or the
 * next) to keep working through the backlog — it always picks up wherever
 * it left off, and once every card is backfilled, a run does almost nothing
 * (only genuinely new catalog cards get pulled).
 *
 * Catalog-wide, listing-prioritized: every pending card is eligible now, not
 * just ones with a listing, but a card someone's actually trying to sell is
 * pulled before one nobody's listed yet, within the same per-run budget.
 *
 * For local testing:
 *   curl "http://localhost:3000/api/cron/backfill-prices?limit=50" \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

type PendingCard = { id: string; tcgPlayerId: string | null; language?: string };

// A card that fails this many runs leaves the queue (see
// priceBackfillAttempts in schema.prisma) instead of being retried — and
// burning JustTCG's daily request budget — on every run forever.
const MAX_BACKFILL_ATTEMPTS = 5;

// Runs in short slices: cron-job.org closes requests after 30 s, so a slice
// takes at most DEFAULT_LIMIT cards (overridable with ?limit=, capped at
// MAX_LIMIT) and stops starting new cards after TIME_BUDGET_MS.
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const TIME_BUDGET_MS = 15_000;
// JustTCG's Starter plan allows 10,000 calls a month. The backfill pauses
// below this many remaining so the refresh job (~1,600 calls a month) never
// runs dry before the monthly reset. A saved quota older than
// QUOTA_MAX_AGE_MS is ignored, so a reset is never missed.
const MONTHLY_RESERVE = 2_000;
const QUOTA_MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * Writes one variant's full backfill in a small, fixed number of queries
 * instead of one round trip per day. A card that's never been backfilled
 * before has no pre-existing rows for its history days (that's what
 * priceBackfilledAt gates), so the only day that can possibly already exist
 * is today — if the cheap daily refresh already wrote it first. One read
 * finds those, one createMany writes everything else, and only real
 * collisions (typically zero or one) get an individual update.
 */
async function backfillVariant(
  catalogIdField: "pokemonCardId" | "riftboundCardId",
  catalogId: string,
  game: "POKEMON" | "RIFTBOUND",
  label: string,
  market: JustTcgMarket,
  capturedAt: Date
) {
  const priceCentsByDay = new Map<string, number>();
  for (const point of market.price_history ?? []) {
    const day = new Date(point.t * 1000).toISOString().slice(0, 10);
    priceCentsByDay.set(day, usdToSgdCents(point.p));
  }
  // The live price can be newer than the last price_history point, or the
  // only price at all if a variant has no history array.
  if (typeof market.price === "number") {
    priceCentsByDay.set(capturedAt.toISOString().slice(0, 10), usdToSgdCents(market.price));
  }
  if (priceCentsByDay.size === 0) return;

  const days = [...priceCentsByDay.keys()];
  const existingRows = await prisma.priceHistory.findMany({
    where: {
      [catalogIdField]: catalogId,
      variant: label,
      capturedAt: { in: days.map((d) => new Date(d)) },
    },
    select: { id: true, capturedAt: true },
  });
  const existingIdByDay = new Map(
    existingRows.map((r) => [r.capturedAt.toISOString().slice(0, 10), r.id])
  );

  const toCreate = days
    .filter((day) => !existingIdByDay.has(day))
    .map((day) => ({
      game,
      [catalogIdField]: catalogId,
      variant: label,
      priceCents: priceCentsByDay.get(day) as number,
      capturedAt: new Date(day),
    }));
  if (toCreate.length > 0) {
    await prisma.priceHistory.createMany({ data: toCreate });
  }

  // Rare (typically zero or one row, per the comment above), but if a whole
  // year's history collides — e.g. a card gets backfilled twice — run these
  // concurrently instead of one round trip per day, capped like every other
  // DB-writing loop in this file.
  await runWithConcurrency([...existingIdByDay], 5, ([day, id]) =>
    prisma.priceHistory.update({
      where: { id },
      data: { priceCents: priceCentsByDay.get(day) as number },
    })
  );
}

async function backfillCard(
  catalogIdField: "pokemonCardId" | "riftboundCardId",
  catalogId: string,
  game: "POKEMON" | "RIFTBOUND",
  tcgPlayerId: string,
  language: string | undefined,
  capturedAt: Date
): Promise<number> {
  const variants = await fetchCardVariants({
    tcgPlayerId,
    game,
    language,
    historyWindow: "1y",
  });

  // A card with several graded prices (PSA 8/9/10, CGC, ...) used to pay for
  // each variant's read+write round trip one after another — the real cost
  // of even a single card's backfill when many grades exist. These write to
  // different rows, so they run concurrently instead.
  const picks = pickPricedVariants(variants).filter((p) => usdMarket(p.variant) !== null);
  await runWithConcurrency(picks, 5, ({ label, variant }) =>
    backfillVariant(catalogIdField, catalogId, game, label, usdMarket(variant) as JustTcgMarket, capturedAt)
  );
  return picks.length;
}

// Best-effort: a failure to record the attempt must not mask the original
// backfill error (it's already logged and in the run summary).
async function recordFailedAttempt(
  model: "pokemonCardCatalog" | "riftboundCardCatalog",
  id: string
) {
  try {
    await (prisma[model] as any).update({
      where: { id },
      data: { priceBackfillAttempts: { increment: 1 } },
    });
  } catch (err) {
    console.error("[cron/backfill-prices] Could not record failed attempt:", id, err);
  }
}

async function runBackfill(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.CRON_SECRET;

  if (!expectedToken) {
    console.error("[cron/backfill-prices] CRON_SECRET env var is not set");
    await postCronResult({
      job: "backfill-prices",
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
    return await backfillPrices(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/backfill-prices] Crashed:", msg);
    await recordJobRun("backfill-prices", { ok: false, summary: `Crashed: ${msg}` });
    return NextResponse.json({ error: "backfill-prices crashed", message: msg }, { status: 500 });
  }
}

async function backfillPrices(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : DEFAULT_LIMIT, MAX_LIMIT);
  const startedAt = Date.now();

  // Quota guard (see MONTHLY_RESERVE). Checked again after every card below.
  const saved = await loadJustTcgQuota();
  const savedIsFresh = saved != null && Date.now() - new Date(saved.at).getTime() < QUOTA_MAX_AGE_MS;
  const belowReserve = (q: { monthlyRemaining: number | null } | null) =>
    q?.monthlyRemaining != null && q.monthlyRemaining < MONTHLY_RESERVE;
  if (savedIsFresh && belowReserve(saved)) {
    const summary = `Paused: ${saved!.monthlyRemaining} JustTCG calls left this month (reserve ${MONTHLY_RESERVE} kept for refresh-prices)`;
    await recordJobRun("backfill-prices", { ok: true, summary, data: { paused: true, monthlyRemaining: saved!.monthlyRemaining } });
    return NextResponse.json({ backfilled: 0, failed: 0, paused: true, monthlyRemaining: saved!.monthlyRemaining });
  }
  let paused = false;

  const capturedAt = new Date(new Date().toISOString().slice(0, 10));
  // No listings filter here: every pending card is eligible, listed or not.
  const basePending = {
    tcgPlayerId: { not: null },
    priceBackfilledAt: null,
    priceBackfillAttempts: { lt: MAX_BACKFILL_ATTEMPTS },
  };
  // Fewest-failed first, so a card that keeps failing drops behind fresh
  // ones instead of being picked first (and failing again) every run.
  const queueOrder = [{ priceBackfillAttempts: "asc" as const }, { id: "asc" as const }];

  // Listed cards first, since a card someone's actually trying to sell
  // matters more than one nobody's listed yet, when JustTCG's daily budget
  // is the limiting factor. No new state: same priceBackfilledAt queue,
  // just drained in two ordered passes instead of one query gated on
  // listing existence. Once the listed pass alone fills the budget, the
  // unlisted pass is skipped entirely — no point spending a second query.
  async function takeCards<T extends "pokemonCardCatalog" | "riftboundCardCatalog">(
    model: T,
    remaining: number
  ): Promise<PendingCard[]> {
    if (remaining <= 0) return [];
    const select =
      model === "pokemonCardCatalog"
        ? { id: true, tcgPlayerId: true, language: true }
        : { id: true, tcgPlayerId: true };

    const listed: PendingCard[] = await (prisma[model] as any).findMany({
      where: { ...basePending, listings: { some: {} } },
      select,
      take: remaining,
      orderBy: queueOrder,
    });
    if (listed.length >= remaining) return listed;

    const unlisted: PendingCard[] = await (prisma[model] as any).findMany({
      where: { ...basePending, listings: { none: {} } },
      select,
      take: remaining - listed.length,
      orderBy: queueOrder,
    });
    return [...listed, ...unlisted];
  }

  const pokemonCards = await takeCards("pokemonCardCatalog", limit);
  const riftboundCards = await takeCards("riftboundCardCatalog", limit - pokemonCards.length);

  // noData = backfilled, but JustTCG had no price at all for the card (its
  // chart stays empty); skipped = left for the next slice (time or quota).
  const results = { backfilled: 0, noData: 0, failed: 0, skipped: 0, errors: [] as string[] };
  const shouldStop = () => paused || Date.now() - startedAt > TIME_BUDGET_MS;
  const checkQuota = () => {
    if (belowReserve(getLastJustTcgQuota())) paused = true;
  };

  // Cards run several at a time instead of one at a time — each one pays a
  // JustTCG round trip plus several database round trips, so processing them
  // strictly in sequence was the main reason a run could take far longer
  // than any cron-job.org timeout. Capped at the Supabase pooler's
  // connection_limit=5 (see src/lib/prisma.ts).
  const BACKFILL_CONCURRENCY = 5;

  await runWithConcurrency(pokemonCards, BACKFILL_CONCURRENCY, async (card) => {
    if (shouldStop()) {
      results.skipped++;
      return;
    }
    try {
      const written = await backfillCard("pokemonCardId", card.id, "POKEMON", card.tcgPlayerId as string, card.language, capturedAt);
      if (written === 0) results.noData++;
      await prisma.pokemonCardCatalog.update({
        where: { id: card.id },
        data: { priceBackfilledAt: new Date() },
      });
      results.backfilled++;
    } catch (err) {
      results.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Pokemon card ${card.id}: ${msg}`);
      console.error("[cron/backfill-prices] Failed to backfill card:", card.id, msg);
      await recordFailedAttempt("pokemonCardCatalog", card.id);
    }
    checkQuota();
  });

  await runWithConcurrency(riftboundCards, BACKFILL_CONCURRENCY, async (card) => {
    if (shouldStop()) {
      results.skipped++;
      return;
    }
    try {
      const written = await backfillCard("riftboundCardId", card.id, "RIFTBOUND", card.tcgPlayerId as string, undefined, capturedAt);
      if (written === 0) results.noData++;
      await prisma.riftboundCardCatalog.update({
        where: { id: card.id },
        data: { priceBackfilledAt: new Date() },
      });
      results.backfilled++;
    } catch (err) {
      results.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Riftbound card ${card.id}: ${msg}`);
      console.error("[cron/backfill-prices] Failed to backfill card:", card.id, msg);
      await recordFailedAttempt("riftboundCardCatalog", card.id);
    }
    checkQuota();
  });

  // Cards that used up their attempts are out of the queue but still need a
  // human look (bad tcgPlayerId, card JustTCG doesn't know) — report them.
  const givenUp = {
    tcgPlayerId: { not: null },
    priceBackfilledAt: null,
    priceBackfillAttempts: { gte: MAX_BACKFILL_ATTEMPTS },
  };
  const [remainingPokemon, remainingRiftbound, givenUpPokemon, givenUpRiftbound] = await Promise.all([
    prisma.pokemonCardCatalog.count({ where: basePending }),
    prisma.riftboundCardCatalog.count({ where: basePending }),
    prisma.pokemonCardCatalog.count({ where: givenUp }),
    prisma.riftboundCardCatalog.count({ where: givenUp }),
  ]);
  const gaveUp = givenUpPokemon + givenUpRiftbound;

  const remaining = remainingPokemon + remainingRiftbound;
  const summary =
    `Backfilled: ${results.backfilled} (no JustTCG data: ${results.noData}), Failed: ${results.failed}, Remaining: ${remaining}` +
    (gaveUp > 0 ? `, Gave up after ${MAX_BACKFILL_ATTEMPTS} attempts: ${gaveUp}` : "") +
    (paused ? ` — paused: JustTCG monthly reserve (${MONTHLY_RESERVE}) reached` : "");
  console.log(`[cron/backfill-prices] Done. ${summary}`);
  await saveJustTcgQuota();
  await recordJobRun("backfill-prices", {
    ok: results.failed === 0,
    summary,
    errors: results.errors,
    data: { backfilled: results.backfilled, noData: results.noData, failed: results.failed, skipped: results.skipped, remaining, gaveUp, paused },
  });

  return NextResponse.json({
    backfilled: results.backfilled,
    noData: results.noData,
    failed: results.failed,
    skipped: results.skipped,
    paused,
    remaining,
    gaveUp,
    ...(results.errors.length > 0 && { errors: results.errors }),
  });
}

export const GET = runBackfill;
export const POST = runBackfill;
