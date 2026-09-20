import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendSms } from "@/lib/sms";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { normalizePhoneNumber, isValidE164 } from "@/lib/phone";
import {
  VERIFICATION_CODE_TTL_MS,
  generateVerificationCode,
  hashVerificationCode,
} from "@/lib/verificationCode";

/**
 * POST /api/user/verify/phone/request
 *
 * No body — sends a code to whatever phone number is already on the
 * account. Setting/changing the number itself happens in Edit Profile
 * (PUT /api/user, which resets phoneVerified when the number changes) —
 * this endpoint only ever sends to the number already on file, so a user
 * can never trigger an SMS to an arbitrary number they don't own.
 *
 * Rate limited by both user id and IP — this is a paid Twilio/SNS send on
 * every call, the most expensive endpoint in this feature to leave open.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const userId = session.user.id;

  // 🔒 Per-user + per-IP rate limits. In-memory stopgap (see src/lib/rateLimit.ts).
  const ip = getClientIp(req);

  const userLimit = checkRateLimit(`phone-verify-request:user:${userId}`, {
    limit: 3,
    windowMs: 15 * 60 * 1000,
  });
  const ipLimit = checkRateLimit(`phone-verify-request:ip:${ip}`, {
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
      select: { phoneNumber: true, phoneVerified: true },
    });
    if (!user) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    if (!user.phoneNumber) {
      return NextResponse.json(
        { error: "Add a phone number in Edit Profile before verifying." },
        { status: 400 }
      );
    }
    if (user.phoneVerified) {
      return NextResponse.json({ message: "Phone number is already verified." });
    }

    // Defensive normalize: numbers saved before E.164 normalization existed
    // (or any legacy data) are still just digits with the calling code
    // concatenated on — same shape normalizePhoneNumber expects.
    const phoneNumber = normalizePhoneNumber(user.phoneNumber);
    if (!isValidE164(phoneNumber)) {
      return NextResponse.json(
        { error: "Your phone number looks invalid. Update it in Edit Profile and try again." },
        { status: 400 }
      );
    }

    const code = generateVerificationCode();
    await prisma.user.update({
      where: { id: userId },
      data: {
        phoneVerificationCodeHash: hashVerificationCode(code),
        phoneVerificationCodeExpiresAt: new Date(Date.now() + VERIFICATION_CODE_TTL_MS),
        phoneVerificationAttempts: 0,
      },
    });

    const { success, error } = await sendSms({
      to: phoneNumber,
      body: `Your MXYYC verification code is ${code}. It expires in 10 minutes.`,
    });
    if (!success) {
      console.error("[user/verify/phone/request] SMS send failed:", error);
      return NextResponse.json({ error: "Failed to send verification code. Please try again." }, { status: 502 });
    }

    return NextResponse.json({ message: "Verification code sent." });
  } catch (err) {
    console.error("[user/verify/phone/request] error:", err);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
