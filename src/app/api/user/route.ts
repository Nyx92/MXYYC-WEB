import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";
import { isValidE164 } from "@/lib/phone";

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
    if (!data.email || !data.password) {
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

    // Hash password before storing
    const hashedPassword = await bcrypt.hash(data.password, 10);

    const newUser = await prisma.user.create({
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        username: data.username || `${data.firstName}_${Date.now()}`,
        email: data.email,
        password: hashedPassword,
        country: data.country,
        sex: data.sex,
        dob: data.dob ? new Date(data.dob) : null,
        address: data.address,
        phoneNumber: data.phoneNumber,
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
      const field = Array.isArray(err.meta?.target) ? err.meta.target[0] : err.meta?.target;
      const error = field === "username" ? "That username is already taken." : "That email is already in use.";
      return NextResponse.json({ error }, { status: 409 });
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

    if (!data.email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

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
      select: { email: true, phoneNumber: true },
    });
    const emailChanged = existing?.email !== data.email;
    const phoneChanged =
      data.phoneNumber !== undefined && existing?.phoneNumber !== data.phoneNumber;

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        username: data.username,
        email: data.email,
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
      return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update user" }, { status: 500 });
  }
}
