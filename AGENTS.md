# Agent instructions — MXYYC-WEB

See [README.md](README.md) for setup, environment variables, and Stripe/Supabase configuration.

- **Package manager:** pnpm only (`preinstall` blocks npm/yarn). Use `pnpm <script>`, not `npx`/`npm run`.
- **Before calling a change done:** run `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm lint`. Stripe and Prisma are fully mocked in tests — no live credentials needed to run the suite.
- **Schema changes:** this project pushes schema changes directly with `pnpm exec prisma db push` against the real Supabase dev database — no `prisma/migrations` folder is checked in. (README.md's `prisma migrate dev` / `migrate deploy` section describes the *default* Prisma workflow, not what this repo actually does.)
- **Rate limiting:** any new endpoint that calls a paid external service (Resend email, Twilio/SNS SMS, Stripe) must be rate limited — see `src/lib/rateLimit.ts` and existing call sites (e.g. `src/app/api/user/verify/*/request/route.ts`) for the per-user / per-IP bucket pattern.
- **Purchase gate:** buy now, cart checkout, offers, and auction bids all require the buyer to have both `emailVerified` and `phoneVerified` set — see `src/lib/purchaseVerification.ts`. Any new route that authorizes or charges a payment must call it too.
- **Protected tables:** the card catalogs are written only by `pnpm update-catalog` (the pricing crons may set price timestamps). `PriceHistory` has a trigger that blocks `DELETE`/`TRUNCATE` (`prisma/sql/protect-price-history.sql`) — never work around it, and never run `db push --force-reset` against Supabase.
- **Phone numbers:** stored as E.164 (`+` + digits, no separators) via `src/lib/phone.ts`'s `normalizePhoneNumber`/`isValidE164` — `react-phone-input-2` (used at signup and in profile editing) returns digits only, so callers must normalize before storing or sending SMS.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
