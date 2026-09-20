# Pokémon MVP

A Pokemon card marketplace built with Next.js 14. Users can list cards for sale, buy cards directly via Stripe Checkout, or place offers backed by a Stripe manual-capture PaymentIntent. Offers have a 24-hour expiry window enforced by a Vercel Cron Job.

---

## Prerequisites

- [Node.js](https://nodejs.org/) **v22+** (use [nvm](https://github.com/nvm-sh/nvm) to manage versions)
- [pnpm](https://pnpm.io/) — this project enforces pnpm only. Running `npm install` or `yarn install` will fail.
- [Stripe CLI](https://stripe.com/docs/stripe-cli) — required for local webhook forwarding (`pnpm dev` starts it automatically)
- A [Supabase](https://supabase.com/) project (Postgres database + image storage)
- A [Stripe](https://stripe.com/) account (test mode keys are fine for local dev)

---

## Environment variables

Create a `.env` file in the project root. All of these are required:

```env
# Database (see Supabase section below for which URL to use)
DATABASE_URL=""

# Auth
NEXTAUTH_SECRET=""
NEXTAUTH_URL="http://localhost:3000"

# Stripe
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""

# Cron job auth — any long random string, must match Vercel env var
CRON_SECRET=""

# Supabase image storage
SUPABASE_URL=""
SUPABASE_SERVICE_ROLE_KEY=""
SUPABASE_BUCKET="card-images"

# App
NEXT_PUBLIC_SITE_URL="http://localhost:3000"
NEXT_PUBLIC_USD_TO_SGD_RATE="1.29"

# Card pricing (JustTCG — see "Cron jobs (card pricing)" below)
JUSTTCG_API_KEY=""

# Discord + Sentry (optional — see "Monitoring" below)
DISCORD_ALERTS_WEBHOOK_URL=""
SENTRY_AUTH_TOKEN=""
SENTRY_ORG=""
```

---

## Getting started

```bash
pnpm install    # installs dependencies and runs prisma generate
pnpm dev        # starts Next.js (port 3000) AND the Stripe webhook listener in parallel
```

`pnpm dev` uses [`concurrently`](https://github.com/open-cli-tools/concurrently) to run two processes at the same time:

| Label | Command | What it does |
|---|---|---|
| `next` (cyan) | `next dev -p 3000` | Next.js dev server |
| `stripe` (yellow) | `stripe listen --forward-to localhost:3000/api/stripe/webhook` | Forwards Stripe events to your local server |

Both processes are killed together when you press Ctrl+C — no orphaned processes left running.

If you want to start Next.js **without** the Stripe listener (e.g. UI-only work):

```bash
pnpm dev:next
```

---

## Database (Supabase + Prisma)

This project uses [Supabase](https://supabase.com/) as the hosted Postgres database and [Prisma](https://www.prisma.io/) as the ORM. Never edit tables directly in the Supabase GUI — always update `prisma/schema.prisma` and run a migration.

### Supabase setup

1. Create a new project at [supabase.com](https://supabase.com/).
2. Go to **Settings → Database** and copy your connection string.
3. Add it to your `.env`:

```env
# Session Pooler — use this for local dev and running migrations (port 5432)
DATABASE_URL="postgresql://postgres:<PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require"

# Transaction Pooler — use this in production / Vercel (port 6543)
# Prevents connection exhaustion in a serverless environment
DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require"
```

### Create and apply a migration

```bash
npx prisma migrate dev --name <migration_name>
npx prisma migrate deploy
```

### Seed the database

Seed data is defined in `prisma/seed.js`.

```bash
pnpm seed
```

### To reset the db when there's updates to schema

rm -rf prisma/migrations
npx prisma db push --force-reset
npx prisma migrate dev --name init
npx prisma db seed
pnpm prisma generate

---

## Stripe setup

### Webhook (local dev)

The Stripe webhook at `POST /api/stripe/webhook` handles `checkout.session.completed` and `checkout.session.expired` events.

`pnpm dev` automatically starts the Stripe CLI listener alongside Next.js — you don't need to run it manually. When it starts you'll see something like:

```
[stripe] Ready! Your webhook signing secret is whsec_...
```

Copy that `whsec_...` value and set it as `STRIPE_WEBHOOK_SECRET` in your `.env`. You only need to do this once — the secret doesn't change between runs.

> **Requires the Stripe CLI** to be installed and authenticated (`stripe login`). See [Prerequisites](#prerequisites).

### Webhook (production)

In your Stripe dashboard, add a webhook endpoint pointing to:

```
https://your-app.vercel.app/api/stripe/webhook
```

Set it to listen for `checkout.session.completed` and `checkout.session.expired`.

---

## Vercel deployment

### Environment variables

Set all variables from the `.env` section above in **Vercel → Project → Settings → Environment Variables**.

Use the **Transaction Pooler** `DATABASE_URL` (port 6543) in production.

### Cron jobs (offer + auction expiry)

Pending offers expire after 24 hours, and auctions need to be closed out once their end time passes. These are handled by:

- `GET /api/cron/expire-offers`
- `GET /api/cron/expire-auctions`

Two things are required for either to work:

1. Set `CRON_SECRET` to a long random string in Vercel's environment variables.
2. Something needs to actually call the endpoint on a schedule with header `Authorization: Bearer <CRON_SECRET>` — Vercel Hobby's built-in cron only allows once-per-day, so we use an external scheduler instead (see below).

**Current setup — [cron-job.org](https://console.cron-job.org/dashboard)** (account: `ngyx92@mxyyc.community`)

Both endpoints below are pinged **every minute**:

- `https://pokemon-mvp.vercel.app/api/cron/expire-auctions`
- `https://pokemon-mvp.vercel.app/api/cron/expire-offers`

### Cron jobs (card pricing)

Card market prices come from [JustTCG](https://justtcg.com). Two separate jobs, on two very different schedules, split the cost so daily use stays cheap even though a full price history pull is not:

- `GET /api/cron/refresh-prices` — **run daily.** Cheap: batches raw prices for the whole catalog (~100 cards/call) and only calls JustTCG per-card for cards with an actual graded listing. Only ever writes today's price.
- `GET /api/cron/backfill-prices?limit=500` — **run twice a month.** Expensive: one call per card, pulling up to a year of daily history. Self-resuming — a card is marked done once it succeeds, so this only ever pulls a given card's deep history once, no matter how many times the job runs. Catalog-wide and listing-prioritized: a card someone's actually selling is backfilled before one that's only in the catalog. Safe to call again the same day to keep working through a large catalog; each call defaults to 500 cards and caps at 950 to stay under JustTCG's daily request limit.

Both need the same `Authorization: Bearer <CRON_SECRET>` header as the other cron endpoints above. Add both to cron-job.org alongside the existing two jobs, at their respective cadences.

Set `DISCORD_ALERTS_WEBHOOK_URL` (optional) to post a Discord alert on every run of either job — success or failure, including a run that returned 200 but had some cards fail. Leave it unset to skip Discord entirely.

### Cron jobs (performance report)

- `GET /api/cron/report-performance` — pulls a p95 latency / throughput / error-rate summary from Sentry's API for the period since the last run and posts it to `DISCORD_ALERTS_WEBHOOK_URL` (same channel as the pricing jobs above). Recommended cadence: hourly.

Needs the same `Authorization: Bearer <CRON_SECRET>` header as the other cron endpoints, plus `SENTRY_AUTH_TOKEN` (a Sentry auth token with `org:read`/`project:read`/`event:read` scopes) and `SENTRY_ORG` (your Sentry org slug). Missing either posts a failure alert to Discord and returns 500 rather than failing silently.

---

## Monitoring

**[UptimeRobot](https://dashboard.uptimerobot.com/)** (account: `ngyx92@gmail.com`) monitors the health endpoint:

- `https://mxyyc-grading.vercel.app/api/health`

Alerts are integrated with Discord.

### Sentry (errors + performance)

Sentry ([sentry.server.config.ts](sentry.server.config.ts), [sentry.edge.config.ts](sentry.edge.config.ts), [instrumentation-client.ts](instrumentation-client.ts)) captures errors across all three runtimes (server, edge, browser). Sentry's own Discord delivery needs a paid plan, so this repo relays around it for free instead:

- **Errors** — every captured error (caught or uncaught) is posted to `DISCORD_ALERTS_WEBHOOK_URL` via each runtime's `beforeSend` hook. The browser can't hold that webhook URL directly (it would ship in the public bundle), so it relays through `POST /api/internal/log-error`, which is rate limited per IP (20/min) since it's an unauthenticated public endpoint.
- **Performance** — see the "Cron jobs (performance report)" section above. Posting one Discord message per transaction isn't viable (Discord caps webhooks at ~30 messages/minute, Sentry can produce far more), so this is a periodic digest instead of a per-event alert.

Both share `DISCORD_ALERTS_WEBHOOK_URL` and are optional — leave it unset to skip Discord and keep using Sentry's own dashboard only.

---

## Testing

Tests cover all transaction flows: Buy Now checkout, offer placement, offer accept/reject, offer expiry, the cron job, orders, and the Stripe webhook.

**Stripe and Prisma are fully mocked** — no real database or Stripe account is needed to run the tests.

### Commands

```bash
pnpm test              # Run all tests once and exit — same as what CI runs
pnpm test:watch        # Re-run tests on file save (use during development)
pnpm test:coverage     # Run tests + generate a coverage report
```

### Coverage report

```bash
pnpm test:coverage
open coverage/index.html
```

### Where the tests live

```
src/__tests__/
├── lib/
│   ├── money.test.ts              # dollarsToCents / centsToDollars utils
│   ├── offerExpiry.test.ts        # expireOffer — PI cancel + DB update logic
│   └── formatTimeRemaining.test.ts # offer countdown string formatting
└── api/
    ├── checkout/
    │   └── route.test.ts          # POST /api/checkout (Buy Now flow)
    ├── offers/
    │   ├── payment-intent.test.ts # POST /api/offers/payment-intent
    │   ├── route.test.ts          # GET + POST /api/offers
    │   └── patch-offer.test.ts    # PATCH /api/offers/[id] (accept / reject)
    ├── cron/
    │   └── expire-offers.test.ts  # GET /api/cron/expire-offers
    ├── orders/
    │   └── route.test.ts          # GET /api/orders
    └── stripe/
        └── webhook.test.ts        # POST /api/stripe/webhook
```

### How the mocking works

Each test file mocks three things so no real services are hit:

- **Stripe** — `vi.mock("stripe", ...)` replaces the Stripe SDK with a fake. You control what each method returns per test.
- **Prisma** — `vi.mock("@/lib/prisma", ...)` replaces the DB client with fakes. No real database is ever connected to.
- **next-auth** — `vi.mock("next-auth", ...)` controls who is "logged in" for each test.

### CI

Tests run automatically on every push and pull request to `main` via GitHub Actions (`.github/workflows/ci.yml`). A failed test blocks the build — Vercel will not deploy until all tests pass.
