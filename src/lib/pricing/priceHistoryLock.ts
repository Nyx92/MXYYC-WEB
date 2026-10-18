import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Arbitrary constant shared by every PriceHistory writer.
const PRICE_HISTORY_LOCK = 724_001;

/**
 * Runs a PriceHistory "find existing rows, then createMany the rest" step
 * under one Postgres advisory lock. refresh-prices and backfill-prices both
 * start at :00 and both take listed cards first, so without it two runs can
 * each see "no row for today" and both insert one.
 *
 * ponytail: one global lock — the step is a couple of short queries, so
 * waiting is cheap; switch to per-card keys if writers ever queue up.
 */
export function withPriceHistoryLock<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PRICE_HISTORY_LOCK})`;
      return fn(tx);
    },
    { maxWait: 10_000, timeout: 20_000 }
  );
}
