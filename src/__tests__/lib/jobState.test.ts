import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * recordJobRun stores each pricing job's last run in JobState and alerts
 * Discord only when the job's status changes (first failure, ok → failing,
 * failing → ok), since the jobs now run every 30–60 minutes and posting
 * every run would flood the channel. Prisma and Discord are mocked.
 */

const mockPrisma = vi.hoisted(() => ({
  jobState: { findUnique: vi.fn(), upsert: vi.fn() },
}));
const mockPostCronResult = vi.hoisted(() => vi.fn());

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/discord", () => ({ postCronResult: mockPostCronResult }));
vi.mock("@/lib/pricing/justtcg", () => ({ getLastJustTcgQuota: () => null }));

import { recordJobRun } from "@/lib/jobState";

function previousRun(lastOk: boolean | null) {
  mockPrisma.jobState.findUnique.mockResolvedValue(lastOk === null ? null : { lastOk });
}

describe("recordJobRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the run in JobState", async () => {
    previousRun(true);
    await recordJobRun("refresh-prices", { ok: true, summary: "Raw: 5" });

    expect(mockPrisma.jobState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { job: "refresh-prices" },
        update: expect.objectContaining({ lastOk: true, lastSummary: "Raw: 5", lastRunAt: expect.any(Date) }),
      })
    );
  });

  it("alerts on the first ever run when it fails", async () => {
    previousRun(null);
    await recordJobRun("refresh-prices", { ok: false, summary: "Failed: 1", errors: ["boom"] });

    expect(mockPostCronResult).toHaveBeenCalledWith({
      job: "refresh-prices",
      ok: false,
      summary: "Failed: 1",
      errors: ["boom"],
    });
  });

  it("does not alert on the first ever run when it succeeds", async () => {
    previousRun(null);
    await recordJobRun("refresh-prices", { ok: true, summary: "Raw: 5" });
    expect(mockPostCronResult).not.toHaveBeenCalled();
  });

  it("alerts when an ok job starts failing", async () => {
    previousRun(true);
    await recordJobRun("backfill-prices", { ok: false, summary: "Failed: 2" });

    expect(mockPostCronResult).toHaveBeenCalledWith(expect.objectContaining({ job: "backfill-prices", ok: false, summary: "Failed: 2" }));
  });

  it("alerts with a \"Recovered — \" summary when a failing job succeeds again", async () => {
    previousRun(false);
    await recordJobRun("backfill-prices", { ok: true, summary: "Backfilled: 3" });

    expect(mockPostCronResult).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, summary: "Recovered — Backfilled: 3" })
    );
  });

  it("stays quiet on ok → ok", async () => {
    previousRun(true);
    await recordJobRun("refresh-prices", { ok: true, summary: "Raw: 5" });
    expect(mockPostCronResult).not.toHaveBeenCalled();
  });

  it("stays quiet on failing → failing", async () => {
    previousRun(false);
    await recordJobRun("refresh-prices", { ok: false, summary: "Failed: 1" });
    expect(mockPostCronResult).not.toHaveBeenCalled();
  });
});
