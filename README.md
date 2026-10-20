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

Create a `.env` file in the project root. Unless marked optional, these are required (`src/lib/env.ts` refuses to boot without the core ones):

```env
# Database (see Supabase section below for which URL goes where)
DATABASE_URL=""
DIRECT_URL=""

# Auth
NEXTAUTH_SECRET=""
NEXTAUTH_URL="http://localhost:3000"

# Stripe
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=""

# Cron job auth — any long random string, must match Vercel env var
CRON_SECRET=""

# Card intake (MXYYC-TCG-IDENTIFIER → /admin/ingest). The identifier sends this
# as "Authorization: Bearer <token>"; unset = the ingest endpoint is closed.
INGEST_API_TOKEN=""
# Account that owns every listing published from Card Intake (default below).
INGEST_OWNER_EMAIL="admin@pokemon.com"

# Email (Resend) — FROM_EMAIL is optional, defaults to Resend's onboarding sender
RESEND_API_KEY=""
FROM_EMAIL="MXYYC <noreply@example.com>"

# SMS (Twilio) — required unless SMS_DEV_MODE="true" (logs SMS to the console instead)
SMS_DEV_MODE="false"
TWILIO_ACCOUNT_SID=""
TWILIO_AUTH_TOKEN=""
TWILIO_MESSAGING_SERVICE_SID=""

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
DISCORD_WEBHOOK_URL=""
NEXT_PUBLIC_SENTRY_DSN=""
SENTRY_AUTH_TOKEN=""
SENTRY_ORG=""
SENTRY_PROJECT=""
SENTRY_REPORT_PERIOD="1h"
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

This project uses [Supabase](https://supabase.com/) as the hosted Postgres database and [Prisma](https://www.prisma.io/) as the ORM. Never edit tables directly in the Supabase GUI — always update `prisma/schema.prisma` and push it (see below).

### Supabase setup

1. Create a new project at [supabase.com](https://supabase.com/).
2. Go to **Settings → Database** and copy the connection strings.
3. Add both to your `.env` (the same values in every environment):

```env
# Transaction pooler (port 6543) — used by the app at runtime.
# pgbouncer=true disables prepared statements (required behind the
# transaction pooler); connection_limit keeps serverless instances from
# exhausting the pool.
DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5"

# Direct / session connection (port 5432) — used by the Prisma CLI for
# `db push` (schema.prisma's `directUrl`). Required.
DIRECT_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@<REGION>.pooler.supabase.com:5432/postgres"
```

### Apply schema changes

This project does **not** use Prisma migrations — there is no `prisma/migrations` folder, and none should be created (don't run `prisma migrate dev`/`migrate deploy`). Edit `prisma/schema.prisma`, then push it:

```bash
pnpm exec prisma db push
```

`db push` (without `--accept-data-loss`) stops and asks before any destructive change. The dev database is shared, so be careful.

### Seed the database

Seed data is defined in `prisma/seed.ts`.

```bash
pnpm seed
```

The seed's mock listings are attached to **real** Pokémon and Riftbound catalog cards (looked up by id, see `POKEMON_SEED_CARDS` and `riftboundVi` in `prisma/seed.ts`), so run `pnpm update-catalog` first (see "Card catalog" below). On a database without the catalog, the seed stops with a clear error before it deletes anything. The seed never writes to the catalog or to `PriceHistory`.

### To reset the db when there's updates to schema

```bash
pnpm reset-db
```

This runs `script/reset-db.sh`: it pushes `schema.prisma`, re-applies the `PriceHistory` delete block, and reseeds mock data. It never drops the protected `PokemonCardCatalog`, `RiftboundCardCatalog` and `PriceHistory` tables (never use `db push --force-reset` — it wipes them).

### Protected data

| Table | Written only by | Protection |
|---|---|---|
| `PokemonCardCatalog`, `RiftboundCardCatalog` | `pnpm update-catalog` (and the pricing crons, which only set their price timestamps) | The seed, reset-db and the admin upload never create, edit or delete catalog rows. A catalog card that has price history or listings cannot be deleted (`onDelete: Restrict`). |
| `PriceHistory` | the pricing crons | A database trigger blocks every `DELETE` and `TRUNCATE` ([`prisma/sql/protect-price-history.sql`](prisma/sql/protect-price-history.sql)). |

Prisma does not manage triggers. On a new database (for example staging), apply the block once after the first `db push`:

```bash
pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/sql/protect-price-history.sql
```

The trigger does not stop `DROP TABLE` (for example `prisma db push --force-reset`). Take a backup before every schema push. To delete price rows on purpose, see the instructions at the top of the SQL file.

### Row-Level Security

Every table in `public` has RLS on with no policies ([`prisma/sql/enable-rls.sql`](prisma/sql/enable-rls.sql)). This blocks the Supabase Data API (`anon` / `authenticated` keys). Prisma connects as the table owner, so the app is not affected. `db push` creates new tables with RLS off — `script/reset-db.sh` re-applies the file, and after a manual push run:

```bash
pnpm exec prisma db execute --schema prisma/schema.prisma --file prisma/sql/enable-rls.sql
```

---

### Card catalog (Pokémon / Riftbound)

The `PokemonCardCatalog` and `RiftboundCardCatalog` tables hold every known
card (not only listed ones). They are filled from a separate, manual CLI
project, **tcg-index-sync** (`/home/buba/projects/tcg-index-sync`), which
builds the card lists and fills in missing TCGPlayer ids. Full guide:
[`tcg-index-sync/README.md`](../tcg-index-sync/README.md).

Admins add listings on `/upload` with a TCG Player ID. The card must already be
in the catalog. If it is not, run `pnpm update-catalog` first. Editing a listing
changes only the listing (price, condition, images, owner), never the card.

#### Update the catalog (one command)

Run this from this repo:

```bash
pnpm update-catalog
```

It does everything in order:

1. Imports Pokémon delta files that are still pending from earlier runs.
2. Runs `pnpm sync:pokemon` in tcg-index-sync. This writes a new Pokémon delta file.
3. Imports that file into the catalog with `pnpm import:catalog-delta`.
4. Does the same for Riftbound.

tcg-index-sync lists every delta file that is not yet imported in
`state/<game>-pending-deltas.txt`. The script removes a file from that list
only after its import succeeds.

To update one game only, run `pnpm update-catalog pokemon` or `pnpm update-catalog riftbound`.

Before the first run:

- Clone tcg-index-sync next to this repo (`../tcg-index-sync`). If it is in a
  different folder, set `TCG_INDEX_SYNC_DIR=/path/to/tcg-index-sync`.
- In tcg-index-sync, run `pnpm install` and
  `pnpm exec playwright install chromium` once. The Riftbound sync needs the browser.
- Check `DATABASE_URL` in this repo's `.env`. The import writes to that database.

How it behaves:

- The import only adds and updates cards. It never deletes cards, and it skips
  cards without a `tcgPlayerId`. You can run it again with no risk.
- If a sync finds no changes, the import does nothing.
- If an import fails, the script stops. Fix the error, then run
  `pnpm update-catalog` again. It imports the failed file first.
- If someone ran a sync in tcg-index-sync without an import, the next
  `pnpm update-catalog` imports that delta too.
- After an import, you do not need to do anything more. The pricing crons below
  get prices for the new cards (backfill: once per card; refresh: daily for
  listed cards, weekly for the others).

To rebuild the full catalog, or to retry one unmatched Japanese set, see
"Common tasks" in the tcg-index-sync README.

### Card intake (scanned cards → listings)

The primary way cards go on sale. MXYYC-TCG-IDENTIFIER (separate project) scans and identifies cards, then sends each one here; an admin reviews them before anything is listed.

```
identifier ── POST /api/admin/ingest/items (Bearer INGEST_API_TOKEN) ──► IngestItem (PENDING)
admin      ── /admin/ingest/<batch> ── fix card / condition / price, approve ──► APPROVED
admin      ── "Publish approved" ──► Listing (forSale, owner INGEST_OWNER_EMAIL) ──► PUBLISHED
```

- **One item per physical card**, keyed by the sha256 of its front scan: sending the same scan again creates nothing, and a published item is never published twice (`src/lib/ingest.ts`, `publishIngestItem`).
- **Photos**: front and back scans, compressed to WebP in Supabase Storage under `card-images/ingest/`. They become the listing photos.
- **Price**: the latest RAW (Near Mint) price in `PriceHistory` for the matched card, rounded **up** to the next S$0.50 (minimum S$1.00) — no JustTCG call. Cards with no price yet stay unpublished until the admin types one.
- **Condition**: Near Mint by default; the admin can change it per card.
- **Review page** (`/admin/ingest`, "Card Intake" in the admin menu): each scan is shown next to the official image of the matched card (tcgdex for Pokémon, riftcodex for Riftbound — linked, not stored; "No image" when the source has none). "Approve all perfect & high" approves the cards the identifier was sure about. For the rest, "Wrong card? Choose the correct one" lists the candidates with their images, or "Not in the list? Enter its TCGPlayer ID". Rejected cards are never listed.
- **After publishing**: the **Listed** tab shows each listing's live state — For sale, Sold (the owner is no longer the ingest account), In auction, Collected. Ingest records are kept as the history of where a listing came from; never delete their photos, the listing uses the same files.
- **Close batch** hides a finished batch from the list ("Show closed batches" brings it back). Nothing is deleted; scans sent later under the same name start a new open batch.
- **Setup**: set `INGEST_API_TOKEN` (long random string) here and as `MXYYC_INGEST_TOKEN` in the identifier's `.env`, with `MXYYC_API_URL` pointing at this site. The owner account (`INGEST_OWNER_EMAIL`) must exist.

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

Card market prices come from [JustTCG](https://justtcg.com), **Starter plan: 10,000 calls a month, 1,000 a day, 50 a minute.** The catalog has ~32k priceable cards, so the jobs are built around that budget and around two hard limits: **cron-job.org closes a request after 30 s**, and Vercel Hobby functions run at most 300 s. Each job therefore runs in **short slices** (≤ ~15 s of new work), picks up where the last slice stopped, and costs **0 JustTCG calls when nothing is due**.

| Job | cron-job.org schedule | What one call does |
|---|---|---|
| `GET /api/cron/refresh-prices` | **every 30 minutes** | Writes **today's** price. First: listed cards not refreshed today (daily prices for everything on sale). Then: catalog cards not refreshed for 7 days (a weekly price for the whole catalog, ~330 calls a week). Up to 12 batch calls (1,200 cards) per slice. Tracked per card in `priceRefreshedAt`. |
| `GET /api/cron/backfill-prices` | **every hour** | Pulls up to **one year of history** for up to 15 cards (`?limit=`, max 50) that were never backfilled — listed cards first. A card is backfilled once (`priceBackfilledAt`); a card that fails 5 times leaves the queue (`priceBackfillAttempts`, reset to 0 to retry). **Pauses automatically** when fewer than 2,000 JustTCG calls are left this month, so the refresh never runs dry; resumes after the monthly reset. |
| `GET /api/cron/report-prices` | **once a day** | Posts the daily health report (below). Makes no JustTCG calls. |

All three need the same `Authorization: Bearer <CRON_SECRET>` header as the other cron endpoints above.

**Budget at this pace:** refresh ≈ 1,600 calls a month; backfill uses the rest (≈ 7,000–8,000 a month), so a full year of history for every catalog card takes about 4 months after a full catalog import. A bigger JustTCG plan shortens that without code changes (raise the backfill schedule or `?limit=`).

**Alerts and monitoring** (set `DISCORD_ALERTS_WEBHOOK_URL`; leave it unset to skip Discord):

- **Status changes, immediately:** a job posts to Discord only when it **starts failing** (❌) and when it **recovers** (✅ "Recovered —"), not on every slice. Each job's last run and status are stored in the `JobState` table.
- **Daily price report** (`report-prices`), built from the data itself so it proves the jobs are moving forward:
  - Backfill: cards done / waiting / given up, new cards backfilled and history rows added in the last 24 h, an ETA, and whether it is paused for quota.
  - Refresh: listed cards priced today, catalog cards refreshed in the last 7 days, duplicate same-day rows (must be 0).
  - JustTCG calls left this month and today.
  - It turns **red with warnings** when a job has not run recently or is failing, when the backfill made no progress although cards and quota were available, when listed cards lack a recent price, when catalog cards are more than 8 days old, or when duplicate rows appear.

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

### Integration tests (real Postgres)

`src/__tests__/integration/` runs the real API route handlers against a real Postgres to prove the database-level guarantees the mocked suite can't: conditional `updateMany` guards, unique constraints, transactions and concurrent-request races (Buy Now reservation, Stripe webhook, offers, auctions, collection requests, price crons). Only external services are mocked (Stripe, NextAuth session, email/SMS, Discord, JustTCG).

```bash
# Any disposable Postgres works, e.g.:
docker run -d --name mxyyc-test-db -e POSTGRES_USER=test -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=mxyyc_test -p 54329:5432 postgres:16

TEST_DATABASE_URL=postgresql://test@127.0.0.1:54329/mxyyc_test pnpm test:integration
```

- The suite **wipes the database**: it runs `prisma db push --force-reset` once, then truncates every table before each test. It only reads `TEST_DATABASE_URL` (never `DATABASE_URL`/`DIRECT_URL` from `.env`) and refuses to start unless the host is `localhost`, `127.0.0.1` or `postgres` (the CI service).
- `pnpm test` does not run these; CI runs them in a separate `integration` job against a `postgres:16` service container.
- Tests marked `it.fails` document known bugs — they pass while the bug exists and start failing once it is fixed (then flip them to `it`).

### CI

Tests run automatically on every push and pull request to `main` via GitHub Actions (`.github/workflows/ci.yml`). A failed test blocks the build — Vercel will not deploy until all tests pass.
