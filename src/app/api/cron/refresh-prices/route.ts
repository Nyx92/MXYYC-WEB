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

/**
 * GET /api/cron/refresh-prices ← recommended schedule: once a day (cron-job.org)
 * POST /api/cron/refresh-prices ← kept for local curl testing
 *
 * The CHEAP, frequent half of the two-tier pricing strategy (see also
 * /api/cron/backfill-prices for the expensive, occasional half). This job
 * only ever writes *today's* price — it never touches history — so it's
 * safe to run daily indefinitely without approaching JustTCG's call quota:
 *
 *   - Raw prices for the whole catalog go through JustTCG's v1 batch
 *     endpoint, 100 cards per call (~13 calls for 1,200+ cards).
 *   - Graded prices need v2 (v1 doesn't return them), so those are one call
 *     per card — but only for cards that actually have a graded Listing,
 *     which today is a small fraction of the catalog.
 *
 * Total: roughly (catalog size / 100) + (graded-listed card count) calls
 * per run — under 20 today, and still cheap even as the catalog grows.
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
    await postCronResult({ job: "refresh-prices", ok: false, summary: `Crashed: ${msg}` });
    return NextResponse.json({ error: "refresh-prices crashed", message: msg }, { status: 500 });
  }
}

async function refreshPrices(): Promise<NextResponse> {
  const capturedAt = new Date(new Date().toISOString().slice(0, 10));

  const [pokemonCards, riftboundCards, pokemonListings, riftboundListings] = await Promise.all([
    prisma.pokemonCardCatalog.findMany({
      where: { tcgPlayerId: { not: null } },
      select: { id: true, tcgPlayerId: true, language: true },
    }),
    prisma.riftboundCardCatalog.findMany({
      where: { tcgPlayerId: { not: null } },
      select: { id: true, tcgPlayerId: true },
    }),
    prisma.listing.findMany({
      where: { game: "POKEMON", pokemonCardId: { not: null } },
      select: { condition: true, pokemonCardId: true },
    }),
    prisma.listing.findMany({
      where: { game: "RIFTBOUND", riftboundCardId: { not: null } },
      select: { condition: true, riftboundCardId: true },
    }),
  ]);

  const gradedPokemonCardIds = new Set(
    pokemonListings
      .filter((l) => toPriceVariantLabel(l.condition) !== "RAW")
      .map((l) => l.pokemonCardId)
  );
  const gradedRiftboundCardIds = new Set(
    riftboundListings
      .filter((l) => toPriceVariantLabel(l.condition) !== "RAW")
      .map((l) => l.riftboundCardId)
  );

  const allCards: CardRef[] = [
    ...pokemonCards.map((c) => ({
      catalogIdField: "pokemonCardId" as const,
      catalogId: c.id,
      game: "POKEMON" as const,
      tcgPlayerId: c.tcgPlayerId as string,
      language: c.language,
    })),
    ...riftboundCards.map((c) => ({
      catalogIdField: "riftboundCardId" as const,
      catalogId: c.id,
      game: "RIFTBOUND" as const,
      tcgPlayerId: c.tcgPlayerId as string,
    })),
  ];

  const results = { rawRefreshed: 0, gradedRefreshed: 0, failed: 0, errors: [] as string[] };

  // ── Raw prices: batched, 100 cards per call ────────────────────────────
  for (const batch of chunk(allCards, 100)) {
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
      // Counted only once the write landed — a failed write lands in `failed`.
      results.rawRefreshed += batch.length;
    } catch (err) {
      results.failed += batch.length;
      const msg = err instanceof Error ? err.message : String(err);
      results.errors.push(`Batch of ${batch.length} starting at ${batch[0]?.tcgPlayerId}: ${msg}`);
      console.error("[cron/refresh-prices] Batch failed:", msg);
    }
  }

  // ── Graded prices: one call per card that actually has a graded listing ─
  const gradedCards = allCards.filter(
    (c) =>
      (c.game === "POKEMON" && gradedPokemonCardIds.has(c.catalogId)) ||
      (c.game === "RIFTBOUND" && gradedRiftboundCardIds.has(c.catalogId))
  );

  const gradedWrites: PriceWrite[] = [];
  await runWithConcurrency(gradedCards, FETCH_CONCURRENCY, async (card) => {
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

  const summary = `Raw: ${results.rawRefreshed}, Graded: ${results.gradedRefreshed}, Failed: ${results.failed}`;
  console.log(`[cron/refresh-prices] Done. ${summary}`);
  await postCronResult({
    job: "refresh-prices",
    ok: results.failed === 0,
    summary,
    errors: results.errors,
  });

  return NextResponse.json({
    rawRefreshed: results.rawRefreshed,
    gradedRefreshed: results.gradedRefreshed,
    failed: results.failed,
    ...(results.errors.length > 0 && { errors: results.errors }),
  });
}

export const GET = runRefresh;
export const POST = runRefresh;
