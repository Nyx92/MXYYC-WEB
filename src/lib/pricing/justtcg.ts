// src/lib/pricing/justtcg.ts
//
// Thin client for JustTCG (https://justtcg.com/docs), the vendor that
// replaced pokemonpricetracker.com. Unlike that old vendor, JustTCG covers
// Riftbound as well as Pokemon.
//
// Two endpoints, two very different jobs:
//   - fetchCardVariants (/v2/cards): one card per call, but the only one
//     that returns graded (PSA/CGC/BGS) prices and a configurable
//     price_history window (up to 1 year). Used by the occasional deep
//     backfill (see /api/cron/backfill-prices).
//   - fetchCardVariantsBatch (/v1/cards): up to 100 cards per call, but raw
//     conditions only, no graded prices, and a fixed ~7-day history we don't
//     use. Used by the frequent, cheap refresh (see /api/cron/refresh-prices)
//     to keep today's raw price current without burning the daily call quota.

import { checkRateLimit } from "@/lib/rateLimit";

const V2_BASE_URL = "https://api.justtcg.com/v2/cards";
const V1_BASE_URL = "https://api.justtcg.com/v1/cards";

// Without this, a single stalled JustTCG call hangs forever — no error, no
// timeout of its own — holding the calling cron function (and its database
// connection) open indefinitely instead of failing one card/batch and
// moving on the way every catch block here already expects.
const JUSTTCG_TIMEOUT_MS = 15_000;

// Both cron routes run several cards' JustTCG calls concurrently now (see
// runWithConcurrency), which would otherwise burst well past the Starter
// plan's 50-requests/minute cap in a few seconds. Every outbound call gates
// on this shared budget first, so concurrency only speeds up the database
// side of a run — the JustTCG call rate stays paced regardless of how many
// cards run at once. 45, not 50, leaves headroom against clock-edge misses.
// Skipped in tests: the in-memory bucket is shared process-wide, and a test
// file that (deliberately) exercises the real fetch path has no need to
// actually wait on a real clock for an external vendor's limit.
const JUSTTCG_RATE_LIMIT = { limit: 45, windowMs: 60_000 };

async function waitForJustTcgSlot(): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  while (true) {
    const result = checkRateLimit("justtcg-outbound", JUSTTCG_RATE_LIMIT);
    if (result.allowed) return;
    await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
  }
}

// The latest JustTCG quota numbers seen in a response: v1 batch responses
// carry a full `_metadata` block, v2 responses only the monthly remaining in
// the `ratelimit-remaining` header. Read by the backfill's quota guard and
// saved for the daily price report (see src/lib/jobState.ts).
export type JustTcgQuota = {
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  plan: string | null;
  at: string;
};
let lastQuota: JustTcgQuota | null = null;

export function getLastJustTcgQuota(): JustTcgQuota | null {
  return lastQuota;
}

function noteQuota(update: Partial<JustTcgQuota>) {
  const base: JustTcgQuota = lastQuota ?? { monthlyLimit: null, monthlyRemaining: null, dailyLimit: null, dailyRemaining: null, plan: null, at: "" };
  lastQuota = { ...base, ...update, at: new Date().toISOString() };
}

function noteQuotaFromHeaders(res: Response) {
  const remaining = res.headers?.get?.("ratelimit-remaining");
  if (remaining == null || !Number.isFinite(Number(remaining))) return;
  const limit = Number(res.headers.get("ratelimit-limit"));
  noteQuota({ monthlyRemaining: Number(remaining), ...(Number.isFinite(limit) && limit > 0 ? { monthlyLimit: limit } : {}) });
}

function noteQuotaFromMetadata(meta: Record<string, unknown> | undefined) {
  if (!meta || typeof meta.apiRequestsRemaining !== "number") return;
  noteQuota({
    monthlyLimit: (meta.apiRequestLimit as number) ?? null,
    monthlyRemaining: meta.apiRequestsRemaining as number,
    dailyLimit: (meta.apiDailyLimit as number) ?? null,
    dailyRemaining: (meta.apiDailyRequestsRemaining as number) ?? null,
    plan: (meta.apiPlan as string) ?? null,
  });
}

// One retry for network-level failures only ("fetch failed", a timeout) —
// a brief glitch would otherwise cost a card one of its backfill attempts.
// HTTP error statuses are returned as-is for the caller to handle.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(JUSTTCG_TIMEOUT_MS) });
  } catch (err) {
    if (process.env.NODE_ENV !== "test") await new Promise((resolve) => setTimeout(resolve, 1000));
    console.warn("[justtcg] Network error, retrying once:", err instanceof Error ? err.message : err);
    return fetch(url, { ...init, signal: AbortSignal.timeout(JUSTTCG_TIMEOUT_MS) });
  }
}

export type JustTcgPricePoint = { t: number; p: number }; // t: unix seconds, p: price

export type JustTcgMarket = {
  currency: string;
  price: number;
  price_history?: JustTcgPricePoint[];
};

export type JustTcgVariant = {
  type: "raw" | "graded";
  condition: string | null;
  grading: { company: string; grade: number } | null;
  markets: JustTcgMarket[];
};

function apiKeyOrThrow(): string {
  const apiKey = process.env.JUSTTCG_API_KEY;
  if (!apiKey) throw new Error("JUSTTCG_API_KEY is not set");
  return apiKey;
}

/**
 * Maps our own game (+ Pokemon language) to JustTCG's actual game slugs.
 * Confirmed against JustTCG's own "Invalid game" error body, which lists
 * every valid slug — "riftbound" alone 400s, and Japanese Pokemon prints
 * are a wholly separate game slug, not a `language` filter on "pokemon".
 */
function justTcgGameSlug(game: "POKEMON" | "RIFTBOUND", language?: string): string {
  if (game === "RIFTBOUND") return "riftbound-league-of-legends-trading-card-game";
  return language?.toLowerCase() === "japanese" ? "pokemon-japan" : "pokemon";
}

/**
 * Fetches every priced variant (raw + graded) JustTCG has for one card,
 * looked up by its TCGPlayer product ID — the same ID our catalogs already
 * store, so no separate name/set matching step is needed.
 *
 * `historyWindow` controls how much of JustTCG's own daily price_history
 * comes back per variant (e.g. "1y" for the deep backfill's up-to-a-year
 * pull; omitted, it defaults to about a week — plenty for the cheap
 * refresh, which only reads the live `price` field anyway).
 *
 * Returns an empty array if JustTCG has no data for this card, never throws
 * for that case — only for a missing API key or a failed request, both of
 * which mean the caller's config is broken rather than "this card has no
 * price".
 */
export async function fetchCardVariants(params: {
  tcgPlayerId: string;
  game: "POKEMON" | "RIFTBOUND";
  language?: string;
  historyWindow?: string;
}): Promise<JustTcgVariant[]> {
  const url = new URL(V2_BASE_URL);
  url.searchParams.set("tcgplayer_id", params.tcgPlayerId);
  url.searchParams.set("game", justTcgGameSlug(params.game, params.language));
  url.searchParams.set("graded", "include");
  if (params.historyWindow) {
    url.searchParams.set("include", `price_history.${params.historyWindow}`);
  }

  await waitForJustTcgSlot();
  const res = await fetchWithRetry(url.toString(), {
    headers: { "x-api-key": apiKeyOrThrow() },
  });

  noteQuotaFromHeaders(res);

  // A 404 means JustTCG has no record at all for this tcgPlayerId — not a
  // transient failure, so it's treated the same as "found the card, no
  // variants" rather than an error the caller should retry forever.
  if (res.status === 404) return [];

  if (!res.ok) {
    throw new Error(`JustTCG request failed: ${res.status}`);
  }

  const json = await res.json();
  const card = json?.data?.[0];
  return (card?.variants ?? []) as JustTcgVariant[];
}

/**
 * Fetches raw-condition prices for up to 100 cards in a single call, via
 * JustTCG's v1 batch endpoint. No graded prices — confirmed empirically that
 * v1 ignores `graded=include` entirely, unlike v2.
 *
 * Returns a Map keyed by tcgPlayerId, normalized into the same JustTcgVariant
 * shape fetchCardVariants returns, so callers don't need to branch on which
 * endpoint the data came from.
 */
export async function fetchCardVariantsBatch(
  tcgPlayerIds: string[]
): Promise<Map<string, JustTcgVariant[]>> {
  if (tcgPlayerIds.length === 0) return new Map();
  if (tcgPlayerIds.length > 100) {
    throw new Error("fetchCardVariantsBatch: max 100 cards per call");
  }

  await waitForJustTcgSlot();
  const res = await fetchWithRetry(V1_BASE_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKeyOrThrow(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(tcgPlayerIds.map((tcgplayerId) => ({ tcgplayerId }))),
  });

  if (!res.ok) {
    throw new Error(`JustTCG batch request failed: ${res.status}`);
  }

  const json = await res.json();
  noteQuotaFromMetadata(json?._metadata);
  const result = new Map<string, JustTcgVariant[]>();

  for (const card of json?.data ?? []) {
    const variants: JustTcgVariant[] = (card.variants ?? []).map((v: any) => ({
      type: "raw",
      condition: v.condition ?? null,
      grading: null,
      markets: [{ currency: "USD", price: v.price }],
    }));
    result.set(card.tcgplayerId, variants);
  }

  return result;
}

/** Splits an array into chunks of at most `size` — for fetchCardVariantsBatch's 100-card cap. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Runs `items` through `fn` with at most `concurrency` in flight at once —
 * used by both cron routes so a run's per-card JustTCG calls and database
 * writes overlap instead of paying one full round trip at a time in
 * sequence. Callers cap `concurrency` at the Supabase pooler's
 * connection_limit=5 (see src/lib/prisma.ts) so this doesn't open more
 * database connections than the pool can actually serve at once.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<unknown>
) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/**
 * Picks a variant's USD market entry — JustTCG's default currency for the
 * NA region — including its price_history, so callers can backfill past
 * days instead of only ever recording "today".
 */
export function usdMarket(variant: JustTcgVariant): JustTcgMarket | null {
  return variant.markets.find((m) => m.currency === "USD") ?? variant.markets[0] ?? null;
}

// JustTCG's grading.company values, mapped to the label word Listing.condition
// uses ("Beckett", not JustTCG's "BGS") — see src/app/utils/mapCondition.ts.
// SGC has no entry: JustTCG doesn't grade-track SGC, so those listings get no price.
const GRADING_COMPANY_LABELS: Record<string, string> = {
  PSA: "PSA",
  CGC: "CGC",
  BGS: "BECKETT",
};

/**
 * Picks exactly the variants we store a price for, out of everything
 * JustTCG returned for a card: one deliberate "RAW" pick (the Near Mint
 * condition — the project's standard raw reference, not just whichever raw
 * sub-condition happens to appear last in the response), plus every graded
 * variant JustTCG can attribute to PSA, CGC, or BGS.
 *
 * Before this, the raw pick wasn't deliberate — every raw sub-condition
 * (Damaged, Lightly Played, ...) mapped to the same "RAW" label, so
 * whichever one the API listed last silently won.
 */
export function pickPricedVariants(
  variants: JustTcgVariant[]
): { label: string; variant: JustTcgVariant }[] {
  const picks: { label: string; variant: JustTcgVariant }[] = [];

  const nearMint = variants.find(
    (v) => v.type === "raw" && v.condition?.toLowerCase() === "near mint"
  );
  if (nearMint) picks.push({ label: "RAW", variant: nearMint });

  for (const variant of variants) {
    if (variant.type !== "graded" || !variant.grading) continue;
    const company = GRADING_COMPANY_LABELS[variant.grading.company.toUpperCase()];
    if (!company) continue;
    const label = `${company} ${variant.grading.grade}`;
    // First per label wins — one day must never get two rows for one label.
    if (picks.some((p) => p.label === label)) continue;
    picks.push({ label, variant });
  }

  return picks;
}
