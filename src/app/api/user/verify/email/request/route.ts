import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail, buildEmailVerificationCodeEmail } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import {
  VERIFICATION_CODE_TTL_MS,
  generateVerificationCode,
  hashVerificationCode,
} from "@/lib/verificationCode";

/**
 * POST /api/user/verify/email/request
 *
 * Sends a 6-digit code to the signed-in user's email address. Stores only
 * its SHA-256 hash + a 10-minute expiry — see src/lib/verificationCode.ts.
 *
 * Rate limited by both user id and IP: this endpoint pays for a Resend send
 * on every call, and a signed-in attacker (or a compromised session) could
 * otherwise spam an inbox or run up the Resend bill.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // 🔒 Per-user + per-IP rate limits. In-memory stopgap (see src/lib/rateLimit.ts).
  const ip = getClientIp(req);

  const userLimit = checkRateLimit(`email-verify-request:user:${userId}`, {
    limit: 3,
    windowMs: 15 * 60 * 1000,
  });
  const ipLimit = checkRateLimit(`email-verify-request:ip:${ip}`, {
    limit: 5,
    windowMs: 15 * 60 * 1000,
  });
  if (!userLimit.allowed || !ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many verification requests. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });
    if (!user) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    if (user.emailVerified) {
      return NextResponse.json({ message: "Email is already verified." });
    }

    const code = generateVerificationCode();
    await prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationCodeHash: hashVerificationCode(code),
        emailVerificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        emailVerificationAttempts: 0,
      },
    });

    const { success } = await sendEmail({
      to: user.email,
      subject: "Your MXYYC verification code",
      html: buildEmailVerificationCodeEmail(code),
    });
    if (!success) {
      return NextResponse.json({ error: "Failed to send verification email. Please try again." }, { status: 502 });
    }

    return NextResponse.json({ message: "Verification code sent." });
  } catch (err) {
    console.error("[user/verify/email/request] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
