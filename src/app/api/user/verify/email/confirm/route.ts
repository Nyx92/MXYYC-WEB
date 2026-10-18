import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rateLimit";
import { MAX_VERIFICATION_ATTEMPTS, verificationCodeMatches } from "@/lib/verificationCode";

/**
 * POST /api/user/verify/email/confirm
 *
 * Body: { code: string }
 *
 * Verifies the 6-digit code sent by POST /api/user/verify/email/request.
 * Wrong guesses increment emailVerificationAttempts; once that hits
 * MAX_VERIFICATION_ATTEMPTS the code is locked out (the user must request a
 * fresh one) — a 6-digit space is small enough that the rate limit alone
 * isn't sufficient brute-force protection.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // 🔒 Rate limit confirm attempts by user id. In-memory stopgap (see
  // src/lib/rateLimit.ts). The per-code attempts counter below is the
  // primary brute-force defense; this just caps overall request volume.
  const { allowed } = checkRateLimit(`email-verify-confirm:${userId}`, {
    limit: 10,
    windowMs: 15 * 60 * 1000,
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const { code } = await req.json();
    if (!code || typeof code !== "string") {
      return NextResponse.json({ error: "Code is required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        emailVerificationCodeHash: true,
        emailVerificationCodeExpiresAt: true,
        emailVerificationAttempts: true,
      },
    });

    if (!user?.emailVerificationCodeHash || !user.emailVerificationCodeExpiresAt) {
      return NextResponse.json({ error: "No verification code was requested" }, { status: 400 });
    }
    if (user.emailVerificationCodeExpiresAt < new Date()) {
      return NextResponse.json({ error: "Code has expired. Request a new one." }, { status: 400 });
    }
    if (user.emailVerificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
      return NextResponse.json(
        { error: "Too many incorrect attempts. Request a new code." },
        { status: 400 }
      );
    }

    if (!verificationCodeMatches(code, user.emailVerificationCodeHash)) {
      await prisma.user.update({
        where: { id: userId },
        data: { emailVerificationAttempts: { increment: 1 } },
      });
      return NextResponse.json({ error: "Incorrect code" }, { status: 400 });
    }

    // Conditional on the hash we just checked still being the stored one:
    // PUT /api/user clears it when the email changes, so a confirm racing a
    // email change can't mark the NEW (unproven) value verified.
    const { count } = await prisma.user.updateMany({
      where: { id: userId, emailVerificationCodeHash: user.emailVerificationCodeHash },
      data: {
        emailVerified: new Date(),
        emailVerificationCodeHash: null,
        emailVerificationCodeExpiresAt: null,
        emailVerificationAttempts: 0,
      },
    });

    if (count !== 1) {
      return NextResponse.json({ error: "Your email changed. Request a new code." }, { status: 409 });
    }

    return NextResponse.json({ message: "Email verified." });
  } catch (err) {
    console.error("[user/verify/email/confirm] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
