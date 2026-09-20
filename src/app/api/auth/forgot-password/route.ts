import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendEmailAsync, buildPasswordResetEmail } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * POST /api/auth/forgot-password
 *
 * Body: { email: string }
 *
 * Always responds 200 with the same generic message, whether or not the
 * email belongs to an account — otherwise this endpoint would let anyone
 * probe which emails are registered (user enumeration).
 *
 * When the email does match a user with a password (credentials-based
 * account — Google-only accounts have no password to reset), generates a
 * random token, stores only its SHA-256 hash + a 1-hour expiry on the user
 * row, and emails the raw token as a reset link. The raw token never touches
 * the database, mirroring how passwords themselves are never stored in
 * plaintext.
 */
export async function POST(req: NextRequest) {
  // 🔒 Rate limit by IP — 10 per hour, same limit as signup (see
  // src/app/api/users/route.ts). Without this, an attacker can force a
  // Resend send (and flood a victim's inbox) on every request, since this
  // endpoint is intentionally unauthenticated. In-memory stopgap (see
  // src/lib/rateLimit.ts).
  const ip = getClientIp(req);
  const { allowed } = checkRateLimit(`forgot-password:${ip}`, {
    limit: 10,
    windowMs: 60 * 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const { email } = await req.json();
    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, password: true },
    });

    if (user?.password) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: tokenHash,
          passwordResetTokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
        },
      });

      const resetUrl = `${SITE_URL}/auth/reset-password?uid=${user.id}&token=${rawToken}`;
      sendEmailAsync({
        to: email,
        subject: "Reset your MXYYC password",
        html: buildPasswordResetEmail(resetUrl),
      });
    } else {
      // Equalize response timing with the branch above, which does an
      // extra awaited DB write — without this, a faster response would
      // itself leak whether the email is registered, undermining the
      // generic-message enumeration guard below.
      await prisma.user.count({ where: { id: "" } });
    }

    return NextResponse.json({
      message: "If an account exists for that email, a reset link has been sent.",
    });
  } catch (err) {
    console.error("[forgot-password] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
