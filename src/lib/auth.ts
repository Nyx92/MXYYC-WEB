/**
 * ✅ This file defines your NextAuth configuration (`authOptions`).
 * It controls:
 *   - How users log in (providers)
 *   - How their data is stored (adapter)
 *   - How sessions are managed (JWT vs DB)
 *   - What user data is exposed to the frontend (callbacks)
 *
 * 👉 Think of it as the "brain" of your authentication system.
 *
 * Providers:
 *   - Credentials — email + password login for manually registered users.
 *   - Google      — OAuth 2.0 for sign up / sign in with a Google account.
 *
 * Google sign-in flow (first time):
 *   1. PrismaAdapter creates a User row (name, email, image, emailVerified)
 *      and an Account row linking it to the Google provider.
 *   2. JWT callback fires — username/firstName/lastName are null on the new user.
 *   3. provisionGoogleUser() derives and persists those fields from the Google profile.
 *   4. Token is populated with the provisioned values.
 *
 * Google sign-in flow (returning user):
 *   Same path, but user.username is already set so provisioning is skipped.
 */

import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { checkRateLimit } from "@/lib/rateLimit";

/* -------------------------------------------------------------------------- */
/* Google user helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Derives firstName, lastName, and a sanitised base username from the
 * data Google provides (full name string + email).
 *
 * Pure function — exported so tests can cover it without a DB connection.
 *
 * Examples:
 *   "John Doe"  / "jdoe@gmail.com"   → { firstName:"John", lastName:"Doe",  baseUsername:"jdoe"  }
 *   "Alice"     / "alice@gmail.com"  → { firstName:"Alice", lastName:null,  baseUsername:"alice" }
 *   null        / "j.doe@gmail.com"  → { firstName:null,    lastName:null,  baseUsername:"j_doe" }
 */
export function deriveGoogleUserFields(
  name: string | null,
  email: string
): { firstName: string | null; lastName: string | null; baseUsername: string } {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? null;
  const lastName  = parts.slice(1).join(" ") || null;

  // Replace non-alphanumeric/underscore characters, then strip leading/trailing underscores.
  const raw = email
    .split("@")[0]
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  const baseUsername = raw || "user";

  return { firstName, lastName, baseUsername };
}

/**
 * Called once per new Google user, inside the JWT callback.
 * Writes username / firstName / lastName to the DB and returns the values.
 * Appends a timestamp suffix if the derived username is already taken by
 * another account.
 */
async function provisionGoogleUser(
  userId: string,
  name:   string | null,
  email:  string
): Promise<{ firstName: string | null; lastName: string | null; username: string }> {
  const { firstName, lastName, baseUsername } = deriveGoogleUserFields(name, email);

  // Check whether the desired username is already taken by a different user.
  let username = baseUsername;
  const taken = await prisma.user.findUnique({
    where:  { username },
    select: { id: true },
  });
  if (taken && taken.id !== userId) {
    username = `${baseUsername}_${Date.now()}`;
  }

  await prisma.user.update({
    where: { id: userId },
    data:  { username, firstName, lastName, verified: true },
  });

  return { firstName, lastName, username };
}

/* -------------------------------------------------------------------------- */

/**
 * `authOptions` — the core NextAuth configuration object.
 * Passed into NextAuth() in `/api/auth/[...nextauth]/route.ts`.
 */
export const authOptions: NextAuthOptions = {
  /* ------------------------------------------------------------------------ */
  /* 1️⃣ ADAPTER — CONNECT NEXTAUTH TO YOUR DATABASE                           */
  /* ------------------------------------------------------------------------ */
  /**
   * The Prisma adapter makes NextAuth talk to your database through Prisma.
   * It automatically creates / updates / deletes:
   *   - Users
   *   - Accounts (OAuth links — one per provider per user)
   *   - Sessions
   *   - Verification tokens
   *
   * Even though we use JWTs for sessions (stateless), the adapter is still
   * needed to persist User and Account rows for OAuth providers like Google.
   */
  adapter: PrismaAdapter(prisma),

  /* ------------------------------------------------------------------------ */
  /* 2️⃣ PROVIDERS — HOW USERS LOG IN                                          */
  /* ------------------------------------------------------------------------ */
  /**
   * Each provider defines one login method.
   *   - CredentialsProvider: email + password (manually registered accounts)
   *   - GoogleProvider:      OAuth 2.0 (sign up / sign in with Google)
   */
  providers: [
    /* ── Credentials (email + password) ──────────────────────────────────── */
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email:    { label: "Email",    type: "text"     },
        password: { label: "Password", type: "password" },
      },
      /**
       * 🔁 Flow summary:
       *  1. User calls `signIn("credentials", { email, password })`
       *  2. NextAuth calls this `authorize()` function server-side
       *  3. You verify the credentials
       *  4. If valid → return a user object
       *     If invalid → return null (reject login)
       */
      async authorize(credentials, req) {
        // Reject immediately if missing email or password
        if (!credentials?.email || !credentials.password) return null;

        // 🔒 Rate limit login attempts to slow down credential-stuffing /
        // brute-force attacks. Keyed by ip:email when the IP is available
        // from the incoming request headers (this NextAuth version's
        // `authorize(credentials, req)` signature types `req.headers` as a
        // plain `Record<string, any>` copied from the original request, so
        // `x-forwarded-for` is present whenever the platform sets it, e.g.
        // on Vercel); falls back to email alone otherwise. In-memory stopgap
        // limiter — see src/lib/rateLimit.ts for its production caveats.
        const forwardedFor = req?.headers?.["x-forwarded-for"];
        const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)
          ?.toString()
          .split(",")[0]
          ?.trim();
        const email = credentials.email.trim();
        // Lowercased so case variants of one address share a bucket.
        const rateLimitKey = ip ? `${ip}:${email.toLowerCase()}` : email.toLowerCase();

        const { allowed } = checkRateLimit(rateLimitKey, {
          limit: 5,
          windowMs: 15 * 60 * 1000, // 15 minutes
        });
        // Return null exactly like an invalid password — do NOT surface a
        // distinct "rate limited" error, or an attacker could use that
        // signal to enumerate which emails have accounts.
        if (!allowed) return null;

        // 1️⃣ Look up the user by email in the Prisma `User` table —
        // case-insensitively, since accounts created before signup started
        // lowercasing emails may still be stored mixed-case.
        const user = await prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
        });

        // 2️⃣ Google-only accounts have no password — reject credentials attempts
        if (!user || !user.password) return null;

        // 3️⃣ Compare the provided password with the hashed password in the DB
        const isValid = await bcrypt.compare(credentials.password, user.password);
        if (!isValid) return null; // wrong password → reject

        // 4️⃣ Return a sanitized user object (this becomes `user` in JWT callback)
        //    ⚠️ Never return `password` or sensitive info
        return {
          id:            user.id,
          email:         user.email,
          firstName:     user.firstName,
          lastName:      user.lastName,
          username:      user.username,
          role:          user.role,
          country:       user.country,
          sex:           user.sex,
          dob:           user.dob ? user.dob.toISOString() : null,
          address:       user.address,
          phoneNumber:   user.phoneNumber,
          phoneVerified: user.phoneVerified,
          emailVerified: user.emailVerified ? user.emailVerified.toISOString() : null,
          verified:      user.verified,
        };
      },
    }),

    /* ── Google OAuth ─────────────────────────────────────────────────────── */
    /**
     * GoogleProvider handles the full OAuth 2.0 redirect flow.
     * On first sign-in the PrismaAdapter creates the User + Account rows.
     * On subsequent sign-ins it finds the existing Account and returns the
     * linked User — no duplicate users are created.
     *
     * Required env vars:
     *   GOOGLE_CLIENT_ID     — from Google Cloud Console → Credentials
     *   GOOGLE_CLIENT_SECRET — same place
     *
     * Authorised redirect URI (add in Google Cloud Console):
     *   http://localhost:3000/api/auth/callback/google      (local dev)
     *   https://your-domain.com/api/auth/callback/google   (production)
     */
    GoogleProvider({
      clientId:     process.env.GOOGLE_CLIENT_ID     as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    }),
  ],

  /* ------------------------------------------------------------------------ */
  /* 3️⃣ SESSION STRATEGY — HOW WE STORE SESSION STATE                         */
  /* ------------------------------------------------------------------------ */
  /**
   * Options:
   *  - "database" → store active sessions in DB (persistent)
   *  - "jwt"       → store session info in encrypted JWT cookie (stateless)
   *
   * We choose "jwt" because:
   *  ✅ faster (no DB lookup on every request)
   *  ✅ scales easily
   *  ⚠️ user data must be manually kept in sync with DB (we handle below)
   */
  session: {
    strategy: "jwt",
  },

  /* ------------------------------------------------------------------------ */
  /* 4️⃣ PAGES — CUSTOM ROUTES                                                 */
  /* ------------------------------------------------------------------------ */
  /**
   * By default, NextAuth shows its own login UI.
   * This tells it to use our custom page at `/auth/login` instead.
   */
  pages: {
    signIn: "/auth/login",
  },

  /* ------------------------------------------------------------------------ */
  /* 5️⃣ CALLBACKS — MODIFY DATA DURING AUTH FLOW                              */
  /* ------------------------------------------------------------------------ */
  /**
   * Callbacks let you hook into internal events.
   * The two key ones here:
   *  - `jwt()`     runs when tokens are created or updated
   *  - `session()` runs when the frontend requests session data
   */
  callbacks: {
    /* ---------------------------------------------------------------------- */
    /* 🔹 JWT CALLBACK — internal "source of truth" for user state            */
    /* ---------------------------------------------------------------------- */
    /**
     * Runs every time a token is created or accessed.
     * Used to:
     *   - Attach user data at login (credentials or Google)
     *   - Provision username/name for first-time Google users
     *   - Re-sync with the database when profile updates happen
     *
     * The token is stored in the browser cookie (client side) and
     * decrypted automatically by NextAuth on each request.
     */
    async jwt({ token, user, account, trigger }) {
      // 🧩 CASE 1 — When a user just logged in (credentials OR Google)
      //   `user` is only present on the initial sign-in, not on every request.
      if (user) {
        token.id    = user.id;
        token.email = user.email ?? "";
        token.role  = user.role  ?? "user";

        // Fields that may not be set yet for brand-new Google users.
        token.country       = user.country       ?? null;
        token.sex           = user.sex           ?? null;
        token.dob           = user.dob           ?? null;
        token.address       = user.address       ?? null;
        token.phoneNumber   = user.phoneNumber   ?? null;
        token.phoneVerified = user.phoneVerified ?? false;
        token.emailVerified = user.emailVerified
          ? (user.emailVerified instanceof Date
              ? user.emailVerified.toISOString()
              : user.emailVerified)
          : null;

        // 🧩 CASE 1a — First-time Google sign-in: username/name are null.
        //   Derive and persist them from the Google profile, then set on token.
        if (account?.provider === "google" && !user.username) {
          try {
            const provisioned = await provisionGoogleUser(
              user.id,
              user.name  ?? null,
              user.email ?? ""
            );
            token.firstName = provisioned.firstName;
            token.lastName  = provisioned.lastName;
            token.username  = provisioned.username;
            token.verified  = true;
          } catch (err) {
            // Provisioning failed — log and fall back to whatever the DB has.
            // The user can fill in their profile manually later.
            console.error("[auth] Google provisioning failed:", err);
            token.firstName = user.firstName ?? null;
            token.lastName  = user.lastName  ?? null;
            token.username  = user.username  ?? null;
            token.verified  = user.verified  ?? false;
          }
        } else {
          // 🧩 CASE 1b — Credentials login or returning Google user (already provisioned).
          //   Attach all the user info to the token payload.
          token.firstName = user.firstName ?? null;
          token.lastName  = user.lastName  ?? null;
          token.username  = user.username  ?? null;
          token.verified  = user.verified  ?? false;
        }

        token.pwv = await currentPasswordVersion(user.id);
        return token;
      }

      // 🧩 Every later use of the token — revalidate against the DB.
      //   The JWT is otherwise trusted for its whole (sliding) 30-day life, so
      //   without this a password reset wouldn't evict a stolen session, and a
      //   demoted admin would keep `role: "admin"`. Throwing here makes
      //   NextAuth clear the session cookie and getServerSession() return null.
      //   ponytail: one PK lookup per authenticated request; cache with a short
      //   TTL if it ever shows up in DB load.
      let dbUser;
      try {
        dbUser = await prisma.user.findUnique({ where: { id: token.id as string } });
      } catch (err) {
        // A transient DB error must not sign everyone out — keep the session
        // as-is and revalidate on the next request.
        console.error("⚠️ JWT revalidation error:", err);
        return token;
      }
      if (!dbUser) throw new Error("Session revoked: user no longer exists");
      // Tokens issued before this check existed carry no `pwv` and are
      // rejected too (a one-time re-login): adopting the current value would
      // let a token stolen before a reset survive it.
      if (token.pwv !== passwordVersion(dbUser.password)) {
        throw new Error("Session revoked: password changed");
      }
      token.role = dbUser.role;

      // 🧩 CASE 2 — When `useSession().update()` is called client-side
      //   → Copy the latest user record (already loaded above) into the token.
      if (trigger === "update") {
        token.email         = dbUser.email;
        token.firstName     = dbUser.firstName;
        token.lastName      = dbUser.lastName;
        token.username      = dbUser.username;
        token.country       = dbUser.country;
        token.sex           = dbUser.sex;
        token.dob           = dbUser.dob ? dbUser.dob.toISOString() : null;
        token.address       = dbUser.address;
        token.phoneNumber   = dbUser.phoneNumber;
        token.phoneVerified = dbUser.phoneVerified;
        token.emailVerified = dbUser.emailVerified
          ? dbUser.emailVerified.toISOString()
          : null;
        token.verified      = dbUser.verified;
      }

      return token;
    },

    /* ---------------------------------------------------------------------- */
    /* 🔹 SESSION CALLBACK — what the frontend receives from `useSession()`   */
    /* ---------------------------------------------------------------------- */
    /**
     * This runs whenever the client or server calls:
     *   - `useSession()` (React hook)
     *   - `getServerSession()` (server-side)
     *
     * Whatever you attach here is what your frontend sees in `session.user`.
     * (It's a "projection" of the JWT payload)
     */
    async session({ session, token }) {
      if (session.user) {
        session.user.id            = token.id            as string;
        session.user.email         = token.email         as string;
        session.user.firstName     = token.firstName     as string | null;
        session.user.lastName      = token.lastName      as string | null;
        session.user.username      = token.username      as string | null;
        session.user.role          = token.role          as string | null;
        session.user.country       = token.country       as string | null;
        session.user.sex           = token.sex           as string | null;
        session.user.dob           = token.dob           as string | null;
        session.user.address       = token.address       as string | null;
        session.user.phoneNumber   = token.phoneNumber   as string | null;
        session.user.phoneVerified = token.phoneVerified as boolean;
        session.user.emailVerified = token.emailVerified as string | null;
        session.user.verified      = token.verified      as boolean;
      }
      return session;
    },
  },
};

/**
 * isAdminOrOwner — the "can this user touch this resource" check used by
 * routes where BOTH an admin and the resource's owner may act (currently
 * just the owner/admin split in cards/[id]/route.ts PUT). Centralized so a
 * future route with the same admin-or-owner shape can reuse it instead of
 * hand-copying `session.user.role === "admin" || card.ownerId === session.user.id`
 * a third time — that hand-copying pattern is exactly how the two prior auth
 * gaps (commits f034471, 6410447) happened.
 *
 * NOT a drop-in replacement for owner-only checks (e.g. offers/[id]/route.ts's
 * accept/reject, which intentionally has no admin bypass) — only use this
 * where admin access is already an intended behavior.
 */
export function isAdminOrOwner(
  session: { user?: { id?: string; role?: string | null } } | null | undefined,
  ownerId: string
): boolean {
  if (!session?.user?.id) return false;
  return session.user.role === "admin" || session.user.id === ownerId;
}

/**
 * A short, non-reversible fingerprint of the stored password hash, kept in
 * the JWT so a password change (reset-password) invalidates every session
 * issued before it. Google-only accounts (no password) get a constant.
 */
function passwordVersion(passwordHash: string | null): string {
  return crypto.createHash("sha256").update(passwordHash ?? "").digest("hex").slice(0, 16);
}

async function currentPasswordVersion(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({ where: { id: userId }, select: { password: true } });
  return passwordVersion(row?.password ?? null);
}
