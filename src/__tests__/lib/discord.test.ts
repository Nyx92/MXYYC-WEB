import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { postCronResult, postErrorAlert } from "@/lib/discord";

/**
 * postCronResult posts a Discord alert for the two price-sync cron jobs, on
 * every run — success or failure. Silent no-op when
 * DISCORD_ALERTS_WEBHOOK_URL isn't set, matching the existing
 * DISCORD_WEBHOOK_URL convention. global.fetch is mocked — no real network call.
 */
describe("postCronResult", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not call fetch when DISCORD_ALERTS_WEBHOOK_URL is unset", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "");
    await postCronResult({ job: "refresh-prices", ok: true, summary: "Raw: 10, Graded: 2, Failed: 0" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts a green embed titled with the job name on success", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    await postCronResult({ job: "refresh-prices", ok: true, summary: "Raw: 10, Graded: 2, Failed: 0" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/test",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].title).toBe("✅ refresh-prices");
    expect(body.embeds[0].description).toBe("Raw: 10, Graded: 2, Failed: 0");
    expect(body.embeds[0].color).toBe(0x22c55e);
    expect(body.embeds[0].fields).toBeUndefined();
  });

  it("posts a red embed with an errors field on failure", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    await postCronResult({
      job: "backfill-prices",
      ok: false,
      summary: "Backfilled: 8, Failed: 2, Remaining: 40",
      errors: ["Pokemon card abc: JustTCG request failed: 500", "Pokemon card def: timeout"],
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].title).toBe("❌ backfill-prices");
    expect(body.embeds[0].color).toBe(0xef4444);
    expect(body.embeds[0].fields[0].value).toContain("JustTCG request failed: 500");
  });

  it("caps the errors field at 10 entries", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    const errors = Array.from({ length: 20 }, (_, i) => `card-${i}: failed`);
    await postCronResult({ job: "backfill-prices", ok: false, summary: "Failed: 20", errors });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].fields[0].value.split("\n")).toHaveLength(10);
  });

  it("does not throw when the Discord API call itself fails", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    mockFetch.mockRejectedValue(new Error("network down"));
    await expect(
      postCronResult({ job: "refresh-prices", ok: true, summary: "ok" })
    ).resolves.toBeUndefined();
  });
});

/**
 * postErrorAlert posts every Sentry-captured error (caught or uncaught, any
 * runtime) to DISCORD_ALERTS_WEBHOOK_URL — the same webhook postCronResult
 * uses — called from each Sentry `beforeSend` hook. Silent no-op when the
 * webhook env var isn't set, matching the other two Discord functions'
 * convention.
 */
describe("postErrorAlert", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not call fetch when DISCORD_ALERTS_WEBHOOK_URL is unset", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "");
    await postErrorAlert({ message: "boom", runtime: "server", environment: "production" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts a red embed with runtime, message, and environment", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    await postErrorAlert({
      message: "TypeError: x is not a function",
      runtime: "browser",
      environment: "production",
      url: "https://mxyyc.example/checkout",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/test",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].title).toBe("🚨 Error — browser");
    expect(body.embeds[0].description).toBe("TypeError: x is not a function");
    expect(body.embeds[0].color).toBe(0xef4444);
    expect(body.embeds[0].fields).toEqual([
      { name: "Environment", value: "production", inline: true },
      { name: "URL", value: "https://mxyyc.example/checkout", inline: true },
    ]);
  });

  it("omits the URL field when no url is given", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    await postErrorAlert({ message: "boom", runtime: "edge", environment: "preview" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.embeds[0].fields).toEqual([{ name: "Environment", value: "preview", inline: true }]);
  });

  it("does not throw when the Discord API call itself fails", async () => {
    vi.stubEnv("DISCORD_ALERTS_WEBHOOK_URL", "https://discord.com/api/webhooks/test");
    mockFetch.mockRejectedValue(new Error("network down"));
    await expect(
      postErrorAlert({ message: "boom", runtime: "server", environment: "production" })
    ).resolves.toBeUndefined();
  });
});
