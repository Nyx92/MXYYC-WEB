import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchCardVariants,
  fetchCardVariantsBatch,
  usdMarket,
  chunk,
  pickPricedVariants,
} from "@/lib/pricing/justtcg";

/**
 * fetchCardVariants calls JustTCG's /v2/cards endpoint by tcgplayer_id and
 * returns its variants array as-is. usdPrice picks the USD market entry out
 * of a variant's markets array. global.fetch is mocked — no real network call.
 */

describe("fetchCardVariants", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the v2 cards endpoint with tcgplayer_id, the pokemon game slug, and graded=include", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ variants: [] }] }),
    });

    await fetchCardVariants({ tcgPlayerId: "42445", game: "POKEMON" });

    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.origin + calledUrl.pathname).toBe(
      "https://api.justtcg.com/v2/cards"
    );
    expect(calledUrl.searchParams.get("tcgplayer_id")).toBe("42445");
    expect(calledUrl.searchParams.get("game")).toBe("pokemon");
    expect(calledUrl.searchParams.get("graded")).toBe("include");
  });

  it("sends the API key as the x-api-key header", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchCardVariants({ tcgPlayerId: "1", game: "RIFTBOUND" });

    expect(mockFetch.mock.calls[0][1].headers["x-api-key"]).toBe(
      "tcg_test_fake"
    );
  });

  it("maps RIFTBOUND to JustTCG's actual (much longer) game slug", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchCardVariants({ tcgPlayerId: "1", game: "RIFTBOUND" });

    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("game")).toBe(
      "riftbound-league-of-legends-trading-card-game"
    );
  });

  it("maps a Japanese Pokemon card to the pokemon-japan game slug, not a language filter", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON", language: "Japanese" });

    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("game")).toBe("pokemon-japan");
    expect(calledUrl.searchParams.has("language")).toBe(false);
  });

  it("returns the first card's variants array", async () => {
    const variants = [{ type: "raw", condition: "Near Mint", grading: null, markets: [] }];
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ variants }] }),
    });

    const result = await fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON" });
    expect(result).toEqual(variants);
  });

  it("returns an empty array when JustTCG has no card for this id", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    const result = await fetchCardVariants({ tcgPlayerId: "unknown", game: "POKEMON" });
    expect(result).toEqual([]);
  });

  it("returns an empty array (not a throw) on a 404 — JustTCG genuinely has no record for this id", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchCardVariants({ tcgPlayerId: "unknown", game: "POKEMON" });
    expect(result).toEqual([]);
  });

  it("throws when the request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(
      fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON" })
    ).rejects.toThrow("401");
  });

  it("bounds the fetch with a 15s AbortSignal.timeout", async () => {
    const fakeSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fakeSignal);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    await fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON" });

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(mockFetch.mock.calls[0][1].signal).toBe(fakeSignal);
    timeoutSpy.mockRestore();
  });

  it("rejects with the abort's TimeoutError instead of hanging or swallowing it, when the timeout fires", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    });

    const pending = fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON" });
    await Promise.resolve(); // let fetchCardVariants reach the fetch() call and register its listener
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("forwards historyWindow as an include=price_history.<window> param", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON", historyWindow: "1y" });

    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("include")).toBe("price_history.1y");
  });

  it("omits the include param when no historyWindow is given", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchCardVariants({ tcgPlayerId: "1", game: "POKEMON" });

    const calledUrl = new URL(mockFetch.mock.calls[0][0]);
    expect(calledUrl.searchParams.has("include")).toBe(false);
  });
});

describe("fetchCardVariantsBatch", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an empty map without calling fetch for an empty input", async () => {
    const result = await fetchCardVariantsBatch([]);
    expect(result).toEqual(new Map());
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws for more than 100 ids without calling fetch", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i));
    await expect(fetchCardVariantsBatch(ids)).rejects.toThrow("max 100");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POSTs to the v1 batch endpoint with one {tcgplayerId} object per id", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await fetchCardVariantsBatch(["42360", "232496"]);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.justtcg.com/v1/cards");
    expect(init.method).toBe("POST");
    expect(init.headers["x-api-key"]).toBe("tcg_test_fake");
    expect(JSON.parse(init.body)).toEqual([
      { tcgplayerId: "42360" },
      { tcgplayerId: "232496" },
    ]);
  });

  it("normalizes each card's variants into the shared raw-only shape, keyed by tcgplayerId", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            tcgplayerId: "42360",
            variants: [{ condition: "Near Mint", price: 12.5 }],
          },
        ],
      }),
    });

    const result = await fetchCardVariantsBatch(["42360"]);
    expect(result.get("42360")).toEqual([
      { type: "raw", condition: "Near Mint", grading: null, markets: [{ currency: "USD", price: 12.5 }] },
    ]);
  });

  it("throws when the batch request fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchCardVariantsBatch(["1"])).rejects.toThrow("500");
  });

  it("bounds the batch fetch with a 15s AbortSignal.timeout", async () => {
    const fakeSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(fakeSignal);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    await fetchCardVariantsBatch(["1"]);

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(mockFetch.mock.calls[0][1].signal).toBe(fakeSignal);
    timeoutSpy.mockRestore();
  });
});

describe("chunk", () => {
  it("splits an array into groups of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one chunk when the array is smaller than the size", () => {
    expect(chunk([1, 2], 100)).toEqual([[1, 2]]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunk([], 100)).toEqual([]);
  });
});

describe("pickPricedVariants", () => {
  it("picks the Near Mint variant as RAW, ignoring other raw sub-conditions", () => {
    const variants = [
      { type: "raw" as const, condition: "Damaged", grading: null, markets: [{ currency: "USD", price: 1 }] },
      { type: "raw" as const, condition: "Near Mint", grading: null, markets: [{ currency: "USD", price: 10 }] },
      { type: "raw" as const, condition: "Lightly Played", grading: null, markets: [{ currency: "USD", price: 5 }] },
    ];
    const picks = pickPricedVariants(variants);
    expect(picks).toHaveLength(1);
    expect(picks[0].label).toBe("RAW");
    expect(picks[0].variant.condition).toBe("Near Mint");
  });

  it("picks every graded variant it can attribute to PSA, CGC, or BGS", () => {
    const variants = [
      { type: "graded" as const, condition: null, grading: { company: "PSA", grade: 10 }, markets: [{ currency: "USD", price: 300 }] },
      { type: "graded" as const, condition: null, grading: { company: "CGC", grade: 9.5 }, markets: [{ currency: "USD", price: 250 }] },
      { type: "graded" as const, condition: null, grading: { company: "BGS", grade: 9 }, markets: [{ currency: "USD", price: 200 }] },
    ];
    const picks = pickPricedVariants(variants);
    expect(picks.map((p) => p.label)).toEqual(["PSA 10", "CGC 9.5", "BECKETT 9"]);
  });

  it("keeps only the first variant per label so one day never gets duplicate rows", () => {
    const variants = [
      { type: "graded" as const, condition: null, grading: { company: "PSA", grade: 10 }, markets: [{ currency: "USD", price: 300 }] },
      { type: "graded" as const, condition: null, grading: { company: "psa", grade: 10 }, markets: [{ currency: "USD", price: 999 }] },
    ];
    const picks = pickPricedVariants(variants);
    expect(picks).toHaveLength(1);
    expect(picks[0].variant.markets[0].price).toBe(300);
  });

  it("skips a graded variant it can't attribute to a known company", () => {
    const variants = [
      { type: "graded" as const, condition: null, grading: { company: "SGC", grade: 9 }, markets: [{ currency: "USD", price: 50 }] },
    ];
    expect(pickPricedVariants(variants)).toEqual([]);
  });

  it("returns no RAW pick when there is no Near Mint variant", () => {
    const variants = [
      { type: "raw" as const, condition: "Damaged", grading: null, markets: [{ currency: "USD", price: 1 }] },
    ];
    expect(pickPricedVariants(variants)).toEqual([]);
  });
});

describe("usdMarket", () => {
  it("picks the USD market entry among several currencies", () => {
    const variant = {
      type: "raw" as const,
      condition: "Near Mint",
      grading: null,
      markets: [
        { currency: "EUR", price: 100 },
        { currency: "USD", price: 120 },
      ],
    };
    expect(usdMarket(variant)?.price).toBe(120);
  });

  it("falls back to the first market when there is no USD entry", () => {
    const variant = {
      type: "raw" as const,
      condition: "Near Mint",
      grading: null,
      markets: [{ currency: "EUR", price: 100 }],
    };
    expect(usdMarket(variant)?.price).toBe(100);
  });

  it("returns null when there are no markets at all", () => {
    const variant = {
      type: "raw" as const,
      condition: "Near Mint",
      grading: null,
      markets: [],
    };
    expect(usdMarket(variant)).toBeNull();
  });

  it("carries the market's price_history through unchanged", () => {
    const variant = {
      type: "raw" as const,
      condition: "Near Mint",
      grading: null,
      markets: [
        { currency: "USD", price: 120, price_history: [{ t: 1788825600, p: 118 }] },
      ],
    };
    expect(usdMarket(variant)?.price_history).toEqual([{ t: 1788825600, p: 118 }]);
  });
});

/**
 * Both cron routes now run several cards' JustTCG calls concurrently
 * (runWithConcurrency), which would otherwise burst well past the Starter
 * plan's 50-requests/minute cap in a few seconds. Every outbound call gates
 * on a shared budget first — verified here directly, not just by reasoning
 * about the concurrency numbers.
 *
 * Skipped in every other test in this file via NODE_ENV === "test" (see
 * waitForJustTcgSlot in justtcg.ts), so this suite overrides NODE_ENV only
 * for the duration of this one test.
 */
describe("outbound rate limiting", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ variants: [] }] }) });
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("holds the next call once the per-minute budget (45) is spent, then releases it once the window rolls over", async () => {
    for (let i = 0; i < 45; i++) {
      await fetchCardVariants({ tcgPlayerId: String(i), game: "POKEMON" });
    }
    expect(mockFetch).toHaveBeenCalledTimes(45);

    const pending = fetchCardVariants({ tcgPlayerId: "over-budget", game: "POKEMON" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(45); // 46th call is still waiting

    await vi.advanceTimersByTimeAsync(60_000); // the 60s window rolls over
    await pending;
    expect(mockFetch).toHaveBeenCalledTimes(46);
  });
});
