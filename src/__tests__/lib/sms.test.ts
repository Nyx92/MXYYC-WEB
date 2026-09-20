import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * src/lib/sms.ts — Twilio send + dev-mode logging. The Twilio SDK call is
 * lazy-imported inside the module, so it's mocked at the package level
 * rather than needing the module under test to be re-imported per test.
 */

const mockTwilioCreate = vi.hoisted(() => vi.fn().mockResolvedValue({ sid: "SM123" }));
const mockTwilioClient = vi.hoisted(() => vi.fn(() => ({ messages: { create: mockTwilioCreate } })));

vi.mock("twilio", () => ({ default: mockTwilioClient }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sendSms", () => {
  it("logs to console and skips sending when SMS_DEV_MODE=true", async () => {
    process.env.SMS_DEV_MODE = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({ to: "+6591234567", body: "code 123456" });

    expect(result).toEqual({ success: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("+6591234567"));
    expect(mockTwilioCreate).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("sends via Twilio", async () => {
    process.env.SMS_DEV_MODE = "false";
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "token";
    process.env.TWILIO_MESSAGING_SERVICE_SID = "MG123";

    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({ to: "+6591234567", body: "code 123456" });

    expect(result).toEqual({ success: true });
    expect(mockTwilioCreate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+6591234567", messagingServiceSid: "MG123", body: "code 123456" })
    );
  });

  it("returns a failure result (not a throw) when Twilio isn't configured", async () => {
    process.env.SMS_DEV_MODE = "false";
    delete process.env.TWILIO_ACCOUNT_SID;

    const { sendSms } = await import("@/lib/sms");
    const result = await sendSms({ to: "+6591234567", body: "code 123456" });

    expect(result.success).toBe(false);
    expect(mockTwilioCreate).not.toHaveBeenCalled();
  });
});
