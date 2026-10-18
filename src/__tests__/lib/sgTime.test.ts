import { describe, it, expect } from "vitest";
import { sgDateString, sgDay, startOfSgDay } from "@/lib/sgTime";

describe("Singapore calendar day helpers", () => {
  it("rolls over to the next day at 16:00 UTC (00:00 Singapore)", () => {
    expect(sgDateString(new Date("2026-10-17T15:59:59Z"))).toBe("2026-10-17");
    expect(sgDateString(new Date("2026-10-17T16:00:00Z"))).toBe("2026-10-18");
  });

  it("returns the Singapore day as a date-only value (UTC midnight of that date)", () => {
    // 01:00 Singapore on the 18th is still the 17th in UTC — labelled the 18th.
    expect(sgDay(new Date("2026-10-17T17:00:00Z")).toISOString()).toBe("2026-10-18T00:00:00.000Z");
  });

  it("gives the instant the Singapore day began", () => {
    expect(startOfSgDay(new Date("2026-10-18T03:00:00Z")).toISOString()).toBe("2026-10-17T16:00:00.000Z");
  });
});
