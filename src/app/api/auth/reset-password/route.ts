import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

// Matches the signup form's own rule (src/app/auth/signup/page.tsx) so a
// reset can't produce a weaker password than signup would ever allow.
const MIN_PASSWORD_LENGTH = 10;

/**
 * POST /api/auth/reset-password
 *
 * Body: { uid: string, token: string, password: string }
 *
 * Verifies the raw token against the stored SHA-256 hash (constant-time
 * comparison — timingSafeEqual — so response timing can't leak how many
 * hash characters matched) and its expiry, then updates the password and
 * clears the token so it can't be reused.
 */
export async function POST(req: NextRequest) {
  // 🔒 Rate limit by IP — 10 per hour. The reset token itself has 256 bits
  // of entropy (not realistically brute-forceable), so this guard is mainly
  // DoS/abuse protection rather than a brute-force defense. In-memory
  // stopgap (see src/lib/rateLimit.ts).
  const ip = getClientIp(req);
  const { allowed } = checkRateLimit(`reset-password:${ip}`, {
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
    const { uid, token, password } = await req.json();
    if (
      !uid || typeof uid !== "string" ||
      !token || typeof token !== "string" ||
      !password || typeof password !== "string"
    ) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: uid },
      select: { passwordResetTokenHash: true, passwordResetTokenExpiresAt: true },
    });

    if (!user?.passwordResetTokenHash || !user.passwordResetTokenExpiresAt) {
      return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 });
    }
    if (user.passwordResetTokenExpiresAt < new Date()) {
      return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 });
    }

    const providedHash = crypto.createHash("sha256").update(token).digest("hex");
    const storedHash = user.passwordResetTokenHash;
    const isValid =
      providedHash.length === storedHash.length &&
      crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(storedHash));

    if (!isValid) {
      return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: uid },
      data: {
        password: hashedPassword,
        // One-time use — clear the token so this link can't be replayed.
        passwordResetTokenHash: null,
        passwordResetTokenExpiresAt: null,
      },
    });

    return NextResponse.json({ message: "Password updated successfully" });
  } catch (err) {
    console.error("[reset-password] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
