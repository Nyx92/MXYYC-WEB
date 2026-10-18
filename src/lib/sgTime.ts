// src/lib/sgTime.ts
//
// Price dates follow the Singapore calendar day (the marketplace's users are
// in Singapore). PriceHistory.capturedAt is a date-only column, stored as
// UTC midnight of that calendar date.

export const SG_TIME_ZONE = "Asia/Singapore";

const sgDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: SG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// "YYYY-MM-DD" of the Singapore calendar day that contains `instant`.
export function sgDateString(instant: Date): string {
  return sgDateFormat.format(instant);
}

// That Singapore day as a date-only value (UTC midnight of the date) — the
// form PriceHistory.capturedAt stores.
export function sgDay(instant: Date): Date {
  return new Date(sgDateString(instant));
}

// The instant the Singapore day containing `instant` began (00:00 SGT,
// which is 16:00 UTC the day before).
export function startOfSgDay(instant: Date): Date {
  return new Date(`${sgDateString(instant)}T00:00:00+08:00`);
}
