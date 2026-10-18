import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { isValidE164, normalizePhoneNumber } from "@/lib/phone";

// P2002 (unique violation) → which field collided, as a user-facing message.
function duplicateFieldError(err: any): string {
  const field = Array.isArray(err.meta?.target) ? err.meta.target[0] : err.meta?.target;
  return field === "username" ? "That username is already taken." : "That email is already in use.";
}

// This function is to store user details on successful sign up
export async function POST(req: Request) {
  // 🔒 Rate limit signups by IP — 10 per hour. Stops a script from mass
  // creating accounts; in-memory stopgap (see src/lib/rateLimit.ts).
  const ip = getClientIp(req);
  const { allowed } = checkRateLimit(`signup:${ip}`, {
    limit: 10,
    windowMs: 60 * 60 * 1000, // 1 hour
  });
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many signup attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    const data = await req.json();

    // Basic input validation
    if (typeof data.email !== "string" || !data.email.trim() || !data.password) {
      return NextResponse.json(
        { error: "Email and password required" },
        { status: 400 }
      );
    }
    if (data.password.length < 10) {
      return NextResponse.json(
        { error: "Password must be at least 10 characters" },
        { status: 400 }
      );
    }

    // Stored as E.164 — the signup form's react-phone-input-2 sends digits
    // only. See src/lib/phone.ts.
    if (data.phoneNumber != null && typeof data.phoneNumber !== "string") {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }
    const phoneNumber = data.phoneNumber ? normalizePhoneNumber(data.phoneNumber) : null;
    if (phoneNumber && !isValidE164(phoneNumber)) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }

    // Stored lowercased so login/forgot-password match regardless of case.
    const email = data.email.trim().toLowerCase();

    // Hash password before storing
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const newUser = await prisma.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        username: data.username || `${data.firstName}_${Date.now()}`,
        email,
        password: hashedPassword,
        country: data.country,
        sex: data.sex,
        dob: data.dob ? new Date(data.dob) : null,
        address: data.address,
        phoneNumber,
        verified: false,
        role: "user",
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        email: true,
        country: true,
        sex: true,
        dob: true,
        address: true,
        phoneNumber: true,
        verified: true,
        role: true,
      },
    });

    return NextResponse.json({ success: true, user: newUser }, { status: 201 });
  } catch (err: any) {
    console.error("❌ Error creating user:", err);
    if (err.code === "P2002") {
      return NextResponse.json({ error: duplicateFieldError(err) }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create user" }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const data = await req.json();

    if (typeof data.email !== "string" || !data.email.trim()) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    const email = data.email.trim().toLowerCase();

    // Phone number is optional here — Personal Information can be saved
    // without touching it. When present, it must already be a normalized
    // E.164 string (EditProfilePage normalizes react-phone-input-2's raw
    // digits before sending); see src/lib/phone.ts.
    if (data.phoneNumber !== undefined && data.phoneNumber !== null && !isValidE164(data.phoneNumber)) {
      return NextResponse.json({ error: "Invalid phone number" }, { status: 400 });
    }

    // A previously-verified email/phone doesn't carry over to a new
    // value — the user must re-verify. Compare against the DB, not the
    // client-supplied form (which round-trips the old value unless the
    // user edits it).
    const existing = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { email: true, phoneNumber: true, password: true },
    });
    // Normalized on both sides, so re-saving a legacy mixed-case email
    // unchanged doesn't count as a change (or demand the password).
    const emailChanged = existing?.email.trim().toLowerCase() !== email;

    // The email is the password-reset identity: changing it with only a
    // session would let anyone holding a stolen session redirect resets to
    // themselves and keep the account for good. Credentials accounts must
    // re-enter their password. (Google-only accounts have no password and
    // can't use forgot-password, so there's nothing to re-check.)
    if (emailChanged && existing?.password) {
      const ok =
        typeof data.currentPassword === "string" &&
        (await bcrypt.compare(data.currentPassword, existing.password));
      if (!ok) {
        return NextResponse.json(
          { error: "Enter your current password to change your email." },
          { status: 403 }
        );
      }
    }
    const phoneChanged =
      data.phoneNumber !== undefined && existing?.phoneNumber !== data.phoneNumber;

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        username: data.username,
        email,
        country: data.country,
        sex: data.sex,
        dob: data.dob ? new Date(data.dob) : null,
        address: data.address,
        ...(data.phoneNumber !== undefined ? { phoneNumber: data.phoneNumber } : {}),
        ...(emailChanged
          ? { emailVerified: null, emailVerificationCodeHash: null, emailVerificationCodeExpiresAt: null }
          : {}),
        ...(phoneChanged
          ? { phoneVerified: false, phoneVerificationCodeHash: null, phoneVerificationCodeExpiresAt: null }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        email: true,
        country: true,
        sex: true,
        dob: true,
        address: true,
        phoneNumber: true,
        phoneVerified: true,
        verified: true,
        role: true,
      },
    });

    return NextResponse.json(
      { success: true, user: updatedUser },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("❌ Error updating user:", err);
    if (err.code === "P2002") {
      return NextResponse.json({ error: duplicateFieldError(err) }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
