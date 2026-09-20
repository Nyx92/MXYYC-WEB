/**
 * sms.ts — thin wrapper for sending transactional SMS (phone verification
 * codes), mirroring the shape of src/lib/email.ts.
 *
 * Unlike email.ts's sendEmailAsync (fire-and-forget, used for non-critical
 * notifications), sendSms() here is awaited — a verification code is the
 * entire point of the request, so the caller needs to know delivery failed
 * and report that back to the user instead of silently leaving them
 * waiting for a text that never arrives.
 *
 * Environment variables:
 *   SMS_PROVIDER                 — "twilio" (the only supported provider)
 *   SMS_DEV_MODE                 — "true" logs to console instead of sending
 *                                  (useful in local dev, avoids burning paid
 *                                  Twilio sends while iterating)
 *   TWILIO_ACCOUNT_SID           — required
 *   TWILIO_AUTH_TOKEN            — required
 *   TWILIO_MESSAGING_SERVICE_SID — required
 */

export interface SendSmsOptions {
  to: string;
  body: string;
}

export interface SendSmsResult {
  success: boolean;
  error?: string;
}

const SMS_DEV_MODE = process.env.SMS_DEV_MODE === "true";

export async function sendSms(opts: SendSmsOptions): Promise<SendSmsResult> {
  if (SMS_DEV_MODE) {
    console.log(`[sms:dev-mode] to=${opts.to} body="${opts.body}"`);
    return { success: true };
  }

  try {
    await sendViaTwilio(opts);
    return { success: true };
  } catch (err) {
    console.error("[sms] Failed to send to", opts.to, err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ── Twilio ───────────────────────────────────────────────────────────────────

async function sendViaTwilio(opts: SendSmsOptions): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!accountSid || !authToken || !messagingServiceSid) {
    throw new Error(
      "Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID"
    );
  }

  const { default: Twilio } = await import("twilio");
  const client = Twilio(accountSid, authToken);

  await client.messages.create({
    to: opts.to,
    messagingServiceSid,
    body: opts.body,
  });
}
