import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { suggestPriceCents, isValidIngestToken, ingestOwnerEmail } from "@/lib/ingest";

const withAuth = (value?: string) => new Request("http://x", { headers: value ? { authorization: value } : {} });

afterEach(() => {
  delete process.env.INGEST_API_TOKEN;
  delete process.env.INGEST_OWNER_EMAIL;
});

describe("suggestPriceCents", () => {
  it("rounds the market price up to the next S$0.50, never below S$1.00", () => {
    expect(suggestPriceCents(1234)).toBe(1250);
    expect(suggestPriceCents(1250)).toBe(1250);
    expect(suggestPriceCents(1251)).toBe(1300);
    expect(suggestPriceCents(12)).toBe(100);
  });
  it("has no suggestion without a market price", () => {
    expect(suggestPriceCents(null)).toBeNull();
    expect(suggestPriceCents(0)).toBeNull();
  });
});

describe("isValidIngestToken", () => {
  it("accepts only the exact bearer token", () => {
    process.env.INGEST_API_TOKEN = "secret-token";
    expect(isValidIngestToken(withAuth("Bearer secret-token"))).toBe(true);
    expect(isValidIngestToken(withAuth("Bearer secret-tokenX"))).toBe(false);
    expect(isValidIngestToken(withAuth())).toBe(false);
  });
  it("is closed when no token is configured", () => {
    expect(isValidIngestToken(withAuth("Bearer "))).toBe(false);
  });
});

describe("ingestOwnerEmail", () => {
  it("defaults to admin@pokemon.com and can be overridden", () => {
    expect(ingestOwnerEmail()).toBe("admin@pokemon.com");
    process.env.INGEST_OWNER_EMAIL = "shop@mxyyc.test";
    expect(ingestOwnerEmail()).toBe("shop@mxyyc.test");
  });
});
