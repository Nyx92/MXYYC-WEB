// src/lib/jobState.ts
//
// Background-job bookkeeping in the JobState table: each job's last run and
// status, plus the latest JustTCG quota numbers ("justtcg-quota").
//
// The pricing crons now run in short slices every 30–60 minutes (cron-job.org
// closes requests after 30 s), so posting every run to Discord would flood the
// channel. Instead a job alerts only when its status changes — ok → failing,
// failing → ok — and the daily /api/cron/report-prices digest shows progress.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { postCronResult } from "@/lib/discord";
import { getLastJustTcgQuota, type JustTcgQuota } from "@/lib/pricing/justtcg";

export async function recordJobRun(
  job: string,
  run: { ok: boolean; summary: string; errors?: string[]; data?: Prisma.InputJsonValue }
): Promise<void> {
  try {
    const previous = await prisma.jobState.findUnique({ where: { job }, select: { lastOk: true } });
    const fields = { lastRunAt: new Date(), lastOk: run.ok, lastSummary: run.summary, data: run.data };
    await prisma.jobState.upsert({ where: { job }, create: { job, ...fields }, update: fields });

    const statusChanged = previous ? previous.lastOk !== run.ok : !run.ok;
    if (statusChanged) {
      await postCronResult({
        job,
        ok: run.ok,
        summary: run.ok ? `Recovered — ${run.summary}` : run.summary,
        errors: run.errors,
      });
    }
  } catch (err) {
    // Bookkeeping must never fail the job itself; still try to surface a failure.
    console.error(`[jobState] Could not record ${job} run:`, err);
    if (!run.ok) await postCronResult({ job, ok: false, summary: run.summary, errors: run.errors });
  }
}

const QUOTA_JOB = "justtcg-quota";

// Persists the latest quota numbers seen in this invocation (if any call was made).
export async function saveJustTcgQuota(): Promise<void> {
  const quota = getLastJustTcgQuota();
  if (!quota) return;
  try {
    const fields = {
      lastRunAt: new Date(quota.at),
      lastOk: true,
      lastSummary: `${quota.monthlyRemaining ?? "?"} of ${quota.monthlyLimit ?? "?"} monthly requests left`,
      data: quota as unknown as Prisma.InputJsonValue,
    };
    await prisma.jobState.upsert({ where: { job: QUOTA_JOB }, create: { job: QUOTA_JOB, ...fields }, update: fields });
  } catch (err) {
    console.error("[jobState] Could not save JustTCG quota:", err);
  }
}

export async function loadJustTcgQuota(): Promise<JustTcgQuota | null> {
  const row = await prisma.jobState.findUnique({ where: { job: QUOTA_JOB } });
  return (row?.data as unknown as JustTcgQuota | null) ?? null;
}
