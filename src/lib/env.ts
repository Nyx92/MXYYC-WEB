// src/lib/env.ts
//
// Validates required environment variables once, at import time, so a
// missing/misconfigured var fails loudly and immediately at app boot instead
// of surfacing later as a confusing runtime error deep inside a request
// handler (e.g. `new Stripe(undefined)` throwing a cryptic SDK error, or a
// Prisma connection string failing hundreds of requests in).
//
// Import this module once, as early as possible (see src/lib/prisma.ts,
// which is itself imported by nearly every API route), so the check runs
// as soon as the app boots.
//
// This does NOT rewrite every existing `process.env.X as string` call site
// to use `env.X` — that's a larger refactor left for later. New/changed code
// is encouraged to `import { env } from "@/lib/env"` instead of reaching
// into `process.env` directly, since `env.X` is guaranteed non-empty here
// while `process.env.X as string` is just an unchecked type assertion.
//
// Var names below match what this project's code actually reads via
// `process.env.X` (checked against src/lib/prisma.ts, src/lib/auth.ts,
// src/app/api/stripe/webhook/route.ts, and the Supabase `createClient(...)`
// call sites in src/app/api/cards/route.ts, src/app/api/cards/[id]/route.ts
// and prisma/seed.ts) — NOT necessarily the names a generic Next.js +
// Supabase starter would use (this project has no NEXT_PUBLIC_SUPABASE_URL /
// NEXT_PUBLIC_SUPABASE_ANON_KEY; server code reads SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY directly, since Supabase is only ever touched
// server-side here).

const REQUIRED_VARS = [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  // src/lib/email.ts constructs `new Resend(...)` at module load, which
  // throws without a key; every cron route rejects requests without CRON_SECRET.
  "RESEND_API_KEY",
  "CRON_SECRET",
] as const;

type RequiredEnvVar = (typeof REQUIRED_VARS)[number];

const missing = REQUIRED_VARS.filter((name) => !process.env[name]);

if (missing.length > 0) {
  throw new Error(
    `[env] Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Set them in .env before starting the app — see .env for the full list ` +
      `of variables this project reads and what each one is for.`
  );
}

// Every key in REQUIRED_VARS was just confirmed present above, so this cast
// is safe — `env` is a fully-validated, non-optional view of those vars.
export const env: Record<RequiredEnvVar, string> = Object.fromEntries(
  REQUIRED_VARS.map((name) => [name, process.env[name] as string])
) as Record<RequiredEnvVar, string>;
