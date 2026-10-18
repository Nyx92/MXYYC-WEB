import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { postCronResult } from "@/lib/discord";
import { loadJustTcgQuota } from "@/lib/jobState";
import { startOfSgDay } from "@/lib/sgTime";

/**
 * GET /api/cron/report-prices ← schedule: once a day (cron-job.org)
 *
 * Daily health report for the two pricing jobs, posted to
 * DISCORD_ALERTS_WEBHOOK_URL. The jobs themselves only alert when their
 * status changes; this report proves from the data that they are actually
 * moving forward — not just running, and not rewriting the same rows:
 *
 *   - Backfill: new cards backfilled in the last 24 h (a backfilled card
 *     leaves the queue for good), history rows added, remaining queue and
 *     an ETA, cards given up on.
 *   - Refresh: listed cards with a price today, catalog cards refreshed in
 *     the last 7 days, duplicate same-day rows (must be 0), when it last ran.
 *   - JustTCG quota left this month.
 *
 * Any check that fails turns the message red and is listed under "Errors".
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Generous versus the 30/60-minute schedules, so one missed call doesn't alert.
const REFRESH_MAX_SILENCE_MS = 2 * 60 * 60 * 1000;
const BACKFILL_MAX_SILENCE_MS = 3 * 60 * 60 * 1000;
const MONTHLY_RESERVE = 2_000; // matches backfill-prices' pause threshold

type Num = number | bigint;
const n = (v: Num | null | undefined) => Number(v ?? 0);

async function buildReport() {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const eightDaysAgo = new Date(now.getTime() - 8 * DAY_MS);
  const startOfToday = startOfSgDay(now);

  const priced = { tcgPlayerId: { not: null } };
  const count = async (where: object) =>
    (await prisma.pokemonCardCatalog.count({ where })) + (await prisma.riftboundCardCatalog.count({ where }));

  const [
    total, backfilled, pending, gaveUp, backfilled24h,
    listedTotal, listedToday, listedStale, refreshedWeek, neverRefreshed, catalogOverdue,
  ] = await Promise.all([
    count(priced),
    count({ ...priced, priceBackfilledAt: { not: null } }),
    count({ ...priced, priceBackfilledAt: null, priceBackfillAttempts: { lt: 5 } }),
    count({ ...priced, priceBackfilledAt: null, priceBackfillAttempts: { gte: 5 } }),
    count({ ...priced, priceBackfilledAt: { gte: dayAgo } }),
    count({ ...priced, listings: { some: {} } }),
    count({ ...priced, listings: { some: {} }, priceRefreshedAt: { gte: startOfToday } }),
    count({ ...priced, listings: { some: {} }, OR: [{ priceRefreshedAt: null }, { priceRefreshedAt: { lt: new Date(now.getTime() - 36 * 60 * 60 * 1000) } }] }),
    count({ ...priced, priceRefreshedAt: { gte: weekAgo } }),
    count({ ...priced, priceRefreshedAt: null }),
    count({ ...priced, priceRefreshedAt: { lt: eightDaysAgo } }),
  ]);

  // History rows (a day before the Singapore day they were written) vs today's-price rows.
  const [[writes], [dupes]] = await Promise.all([
    prisma.$queryRaw<{ history_rows: Num; history_cards: Num; today_rows: Num }[]>`
      SELECT
        count(*) FILTER (WHERE "capturedAt" < date(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Singapore')) AS history_rows,
        count(DISTINCT coalesce("pokemonCardId", "riftboundCardId")) FILTER (WHERE "capturedAt" < date(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Singapore')) AS history_cards,
        count(*) FILTER (WHERE "capturedAt" = date(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Singapore')) AS today_rows
      FROM "PriceHistory" WHERE "createdAt" >= ${dayAgo}`,
    prisma.$queryRaw<{ dupes: Num }[]>`
      SELECT count(*) AS dupes FROM (
        SELECT 1 FROM "PriceHistory" WHERE "capturedAt" >= ${weekAgo}
        GROUP BY coalesce("pokemonCardId", "riftboundCardId"), variant, "capturedAt" HAVING count(*) > 1
      ) d`,
  ]);

  const [refreshJob, backfillJob, quota] = await Promise.all([
    prisma.jobState.findUnique({ where: { job: "refresh-prices" } }),
    prisma.jobState.findUnique({ where: { job: "backfill-prices" } }),
    loadJustTcgQuota(),
  ]);

  const warnings: string[] = [];
  const ago = (d: Date | undefined | null) => (d ? `${Math.round((now.getTime() - d.getTime()) / 60000)} min ago` : "never");
  const backfillPaused = quota?.monthlyRemaining != null && quota.monthlyRemaining < MONTHLY_RESERVE;

  if (!refreshJob || now.getTime() - refreshJob.lastRunAt.getTime() > REFRESH_MAX_SILENCE_MS)
    warnings.push(`refresh-prices has not run recently (last run: ${ago(refreshJob?.lastRunAt)})`);
  else if (!refreshJob.lastOk) warnings.push(`refresh-prices is failing: ${refreshJob.lastSummary}`);

  if (!backfillJob || now.getTime() - backfillJob.lastRunAt.getTime() > BACKFILL_MAX_SILENCE_MS)
    warnings.push(`backfill-prices has not run recently (last run: ${ago(backfillJob?.lastRunAt)})`);
  else if (!backfillJob.lastOk) warnings.push(`backfill-prices is failing: ${backfillJob.lastSummary}`);

  if (pending > 0 && backfilled24h === 0 && !backfillPaused)
    warnings.push(`No backfill progress in 24 h although ${pending} cards are waiting and quota is available`);
  if (listedStale > 0) warnings.push(`${listedStale} listed card(s) have no price from the last 36 h`);
  if (catalogOverdue > 0 && neverRefreshed === 0) warnings.push(`${catalogOverdue} catalog card(s) not refreshed for over 8 days`);
  if (n(dupes.dupes) > 0) warnings.push(`${n(dupes.dupes)} duplicate price rows (same card, variant and day) in the last 7 days`);

  const perDay = backfilled24h;
  const eta = pending === 0 ? "done" : perDay > 0 ? `~${Math.ceil(pending / perDay)} days at the last 24 h's pace` : "no recent progress";

  const lines = [
    `**Backfill** — ${backfilled}/${total} cards done (${pending} waiting, ${gaveUp} given up). ETA: ${eta}.`,
    `Last 24 h: ${backfilled24h} new cards backfilled, ${n(writes.history_rows)} history rows added across ${n(writes.history_cards)} cards.` +
      (backfillPaused ? " Paused: JustTCG monthly reserve reached." : ""),
    `**Refresh** — listed cards priced today: ${listedToday}/${listedTotal}. Catalog refreshed in the last 7 days: ${refreshedWeek}/${total}` +
      (neverRefreshed > 0 ? ` (${neverRefreshed} never refreshed yet — first pass in progress)` : "") + ".",
    `Today's-price rows written in the last 24 h: ${n(writes.today_rows)}. Duplicate rows (7 days): ${n(dupes.dupes)}.`,
    `**Jobs** — refresh last ran ${ago(refreshJob?.lastRunAt)} (${refreshJob?.lastOk === false ? "failing" : "ok"}), backfill last ran ${ago(backfillJob?.lastRunAt)} (${backfillJob?.lastOk === false ? "failing" : "ok"}).`,
    `**JustTCG** — ${quota?.monthlyRemaining ?? "?"} of ${quota?.monthlyLimit ?? "?"} monthly calls left` +
      // Only v1 batch responses report the daily count, so it is as of the last refresh call.
      (quota?.dailyRemaining != null ? `, ${quota.dailyRemaining} of ${quota.dailyLimit} today (as of the last refresh call)` : "") +
      (quota?.plan ? ` (${quota.plan})` : "") + ".",
  ];
  return { ok: warnings.length === 0, summary: lines.join("\n"), warnings };
}

async function runReport(req: NextRequest): Promise<NextResponse> {
  const expectedToken = process.env.CRON_SECRET;
  if (!expectedToken) {
    console.error("[cron/report-prices] CRON_SECRET env var is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await buildReport();
    await postCronResult({ job: "price report", ok: report.ok, summary: report.summary, errors: report.warnings });
    return NextResponse.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/report-prices] Crashed:", msg);
    await postCronResult({ job: "price report", ok: false, summary: `Crashed: ${msg}` });
    return NextResponse.json({ error: "report-prices crashed", message: msg }, { status: 500 });
  }
}

export const GET = runReport;
export const POST = runReport;
