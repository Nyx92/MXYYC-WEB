import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Vitest configuration for the MXYYC-WEB test suite.
 *
 * Vitest is the test runner. This file tells it:
 *   - WHERE to run tests (Node, not a browser)
 *   - WHAT fake environment variables to inject
 *   - HOW to resolve @/ path aliases used inside the route handlers
 *   - WHICH files to measure for code coverage
 *
 * Run tests with:
 *   pnpm test            → run all tests once (used in CI)
 *   pnpm test:watch      → re-run on file save (used during development)
 *   pnpm test:coverage   → run + generate a coverage report
 */
export default defineConfig({
  test: {
    // ── Environment ──────────────────────────────────────────────────────────
    // "node" means tests run in a plain Node.js process — no browser, no DOM.
    // This is correct because we are testing server-side API route handlers,
    // not React components or anything that needs a browser environment.
    environment: "node",
    // Client-component tests (React Testing Library) need a DOM — only those
    // files run in jsdom so the API/lib suites keep the faster node env.
    environmentMatchGlobs: [["src/__tests__/components/**", "jsdom"]],

    // ── Globals ───────────────────────────────────────────────────────────────
    // Makes describe(), it(), expect(), vi() etc. available in every test file
    // without needing to import them. Saves an import line on every file.
    // The TypeScript types for these globals come from vitest's own type defs.
    globals: true,

    // ── Fake environment variables ────────────────────────────────────────────
    // The route handler files read process.env at the top of the module, e.g.:
    //   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, ...)
    //   if (!process.env.CRON_SECRET) throw ...
    //
    // If those variables are undefined, the module crashes before a single test
    // runs. These fake values prevent that crash.
    //
    // IMPORTANT: the actual values here do NOT matter and are never sent
    // anywhere real. Stripe and Prisma are fully mocked in every test file —
    // no real network calls, no real database connections are ever made.
    env: {
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_fake",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
      // Must match what the cron tests use as the bearer token
      CRON_SECRET: "test-cron-secret",
      NEXTAUTH_SECRET: "test-secret",
      NEXTAUTH_URL: "http://localhost:3000",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      // Never actually connected to — Prisma is mocked
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      // email.ts constructs `new Resend(...)` at module load time, so any test
      // file that pulls in the real notifications module (even indirectly, e.g.
      // via `importOriginal` on webhookHelpers) needs this defined or the whole
      // module import throws before a single test runs. Resend is never actually
      // called — real network calls only happen through mocked modules in tests.
      RESEND_API_KEY: "re_test_fake",
      // src/lib/env.ts requires these at import time (via src/lib/prisma.ts's
      // side-effect import). Most test files mock @/lib/prisma so this never
      // runs, but a few (auth.test.ts, isAdminOrOwner.test.ts) import @/lib/auth
      // directly, which pulls in the real prisma.ts — no Supabase client is
      // ever actually constructed in tests, so these values never need to work.
      SUPABASE_URL: "https://fake.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
      // src/lib/pricing/justtcg.ts and src/lib/money.ts's usdToSgdCents —
      // JustTCG is mocked in every test file, so this key is never sent anywhere real.
      JUSTTCG_API_KEY: "tcg_test_fake",
      NEXT_PUBLIC_USD_TO_SGD_RATE: "1.29",
    },

    // ── Test discovery ────────────────────────────────────────────────────────
    // Superpowers-driven plans work in isolated git worktrees under
    // .worktrees/ (gitignored). Vitest's default exclude list doesn't know
    // about that convention, so a worktree left on disk inside the project
    // tree gets scanned as a second, nested copy of the whole test suite —
    // every test file appears to run twice with doubled (and often
    // conflicting) results. Excluding it here is the fix; the alternative
    // (always deleting worktrees immediately) doesn't hold when two plans
    // are executed concurrently in separate worktrees, as this project does.
    exclude: [
      "**/node_modules/**", "**/dist/**", "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
      "**/.worktrees/**",
      "src/__tests__/integration/**", // DB tests: pnpm test:integration
    ],

    // ── Coverage (pnpm test:coverage only) ───────────────────────────────────
    // Only relevant when running `pnpm test:coverage`. Ignored during normal
    // `pnpm test` runs.
    //
    // provider: "v8" uses Node's built-in V8 engine coverage tooling.
    // It is faster and needs no extra packages beyond @vitest/coverage-v8.
    //
    // reporter options:
    //   "text"  → prints a summary table in the terminal after tests finish
    //   "lcov"  → generates coverage/lcov.info (used by CI coverage services)
    //   "html"  → generates coverage/index.html (open in browser to explore)
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      // Only measure coverage for production code we actually care about.
      // This excludes things like Next.js page files, components, etc.
      include: ["src/app/api/**/*.ts", "src/lib/**/*.ts", "src/app/**/*.tsx"],
      // Don't count the test files themselves as "covered" code
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  },

  // ── Path alias ─────────────────────────────────────────────────────────────
  // The route handler files use the @/ alias throughout, e.g.:
  //   import { prisma } from "@/lib/prisma"
  //   import { expireOffer } from "@/lib/offerExpiry"
  //
  // This alias is defined in tsconfig.json and Next.js picks it up automatically.
  // Vitest has its own module resolver and knows nothing about tsconfig, so we
  // must teach it the same rule here: @/ resolves to the src/ folder.
  //
  // Without this line every test file would crash with "Cannot find module @/..."
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
