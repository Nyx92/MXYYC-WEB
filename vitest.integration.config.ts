import { defineConfig } from "vitest/config";
import path from "path";
import { testDatabaseUrl } from "./src/__tests__/integration/testDatabaseUrl";

/**
 * Database integration tests: the real route handlers against a real,
 * disposable Postgres (TEST_DATABASE_URL, localhost/CI only — see
 * testDatabaseUrl.ts). Only external services are mocked (setup.ts).
 *
 *   TEST_DATABASE_URL=postgresql://test@127.0.0.1:54329/mxyyc_test pnpm test:integration
 */
const databaseUrl = testDatabaseUrl();

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/integration/**/*.test.ts"],
    globalSetup: ["src/__tests__/integration/globalSetup.ts"],
    setupFiles: ["src/__tests__/integration/setup.ts"],
    // One database, truncated before every test — files must not overlap.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Overrides anything inherited, so @/lib/prisma can only reach the test DB.
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_fake",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
      CRON_SECRET: "test-cron-secret",
      NEXTAUTH_SECRET: "test-secret",
      NEXTAUTH_URL: "http://localhost:3000",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      RESEND_API_KEY: "re_test_fake",
      SUPABASE_URL: "https://fake.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      JUSTTCG_API_KEY: "tcg_test_fake",
      NEXT_PUBLIC_USD_TO_SGD_RATE: "1.29",
      DISCORD_WEBHOOK_URL: "",
      DISCORD_ALERTS_WEBHOOK_URL: "",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
