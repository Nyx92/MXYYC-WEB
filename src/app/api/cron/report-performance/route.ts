import { NextRequest, NextResponse } from "next/server";
import { postCronResult } from "@/lib/discord";

/**
 * GET /api/cron/report-performance ← called by an external scheduler (cron-job.org)
 * POST /api/cron/report-performance ← kept for local curl testing
 *
 * Sentry's own performance dashboards and alerting live behind a paid plan
 * for Discord delivery. This instead pulls a summary straight from Sentry's
 * Events (Discover) API on a schedule and posts it to the existing cron-alerts
 * Discord channel via postCronResult — same channel and pattern as
 * refresh-prices/backfill-prices.
 *
 * `project=-1` queries every project the auth token can see, so this needs
 * no project id — fine for this app's single Sentry project.
 *
 * For local testing:
 *   curl http://localhost:3000/api/cron/report-performance \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */
async function runReport(req: NextRequest): Promise<NextResponse> {
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.CRON_SECRET;

  if (!expectedToken) {
    console.error("[cron/report-performance] CRON_SECRET env var is not set");
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }
  if (authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sentryToken = process.env.SENTRY_AUTH_TOKEN;
  const sentryOrg = process.env.SENTRY_ORG;
  if (!sentryToken || !sentryOrg) {
    const summary = "Not configured: SENTRY_AUTH_TOKEN and/or SENTRY_ORG env vars are missing.";
    console.error("[cron/report-performance]", summary);
    await postCronResult({ job: "report-performance", ok: false, summary });
    return NextResponse.json({ error: summary }, { status: 500 });
  }

  // statsPeriod window should match this job's own run cadence (set in
  // cron-job.org, not in this repo) — each report should cover the period
  // since the last one, with no gap and no overlap.
  const statsPeriod = process.env.SENTRY_REPORT_PERIOD || "1h";
  const url =
    `https://sentry.io/api/0/organizations/${sentryOrg}/events/` +
    `?field=p95(transaction.duration)&field=count()&field=failure_rate()` +
    `&query=${encodeURIComponent("event.type:transaction")}` +
    `&statsPeriod=${statsPeriod}&project=-1`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${sentryToken}` },
    });
    if (!res.ok) {
      const body = await res.text();
      const summary = `Sentry API returned ${res.status}`;
      console.error("[cron/report-performance]", summary, body);
      await postCronResult({ job: "report-performance", ok: false, summary, errors: [body.slice(0, 500)] });
      return NextResponse.json({ error: summary }, { status: 502 });
    }

    const json = await res.json();
    const row = json?.data?.[0] ?? {};
    const p95 = row["p95(transaction.duration)"];
    const count = row["count()"];
    const failureRate = row["failure_rate()"];

    const summary =
      `p95 latency: ${typeof p95 === "number" ? Math.round(p95) + "ms" : "n/a"} · ` +
      `Throughput: ${typeof count === "number" ? count.toLocaleString() : "n/a"} transactions · ` +
      `Error rate: ${typeof failureRate === "number" ? (failureRate * 100).toFixed(1) + "%" : "n/a"} ` +
      `(last ${statsPeriod})`;

    await postCronResult({ job: "report-performance", ok: true, summary });
    return NextResponse.json({ p95, count, failureRate, statsPeriod });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/report-performance] Crashed:", err);
    await postCronResult({ job: "report-performance", ok: false, summary: `Crashed: ${msg}` });
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}

export const GET = runReport;
export const POST = runReport;
