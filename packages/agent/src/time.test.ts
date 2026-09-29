import { describe, expect, it } from "vitest";
import { resolveDue } from "./due.js";
import { addDays, isValidDate, lastDayOfMonth, toLocal, toZonedIso, zonedTimeToInstant } from "./time.js";

const TZ = "Europe/Rome";
const settings = { timezone: TZ, endOfWorkDay: "17:00" };

describe("zonedTimeToInstant (Europe/Rome)", () => {
  it("uses +02:00 in summer and +01:00 in winter", () => {
    expect(zonedTimeToInstant("2026-09-24", "17:00", TZ).toISOString()).toBe("2026-09-24T15:00:00.000Z");
    expect(zonedTimeToInstant("2026-12-24", "17:00", TZ).toISOString()).toBe("2026-12-24T16:00:00.000Z");
  });

  it("handles the days around the October 2026 fall-back (25 Oct)", () => {
    expect(toZonedIso(zonedTimeToInstant("2026-10-24", "17:00", TZ), TZ)).toBe("2026-10-24T17:00:00+02:00");
    expect(toZonedIso(zonedTimeToInstant("2026-10-25", "17:00", TZ), TZ)).toBe("2026-10-25T17:00:00+01:00");
    expect(toZonedIso(zonedTimeToInstant("2026-10-26", "09:00", TZ), TZ)).toBe("2026-10-26T09:00:00+01:00");
  });

  it("resolves an ambiguous fall-back time to the earlier instant", () => {
    expect(zonedTimeToInstant("2026-10-25", "02:30", TZ).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("handles the March 2027 spring-forward (28 Mar)", () => {
    expect(toZonedIso(zonedTimeToInstant("2027-03-27", "17:00", TZ), TZ)).toBe("2027-03-27T17:00:00+01:00");
    expect(toZonedIso(zonedTimeToInstant("2027-03-28", "17:00", TZ), TZ)).toBe("2027-03-28T17:00:00+02:00");
    // 02:30 does not exist that night; it moves forward past the gap.
    expect(toZonedIso(zonedTimeToInstant("2027-03-28", "02:30", TZ), TZ)).toBe("2027-03-28T03:30:00+02:00");
  });

  it("works for other zones", () => {
    expect(zonedTimeToInstant("2026-07-01", "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTimeToInstant("2026-07-01", "09:00", "UTC").toISOString()).toBe("2026-07-01T09:00:00.000Z");
  });
});

describe("calendar helpers", () => {
  it("adds days across months and years", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("validates real dates", () => {
    expect(isValidDate("2026-02-28")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("26-02-01")).toBe(false);
  });

  it("finds the last day of the month", () => {
    expect(lastDayOfMonth("2026-09-23")).toBe("2026-09-30");
    expect(lastDayOfMonth("2028-02-10")).toBe("2028-02-29");
  });

  it("gives the local date and weekday", () => {
    // 23:30Z on 23 Sep is already 24 Sep (Thursday) in Rome.
    expect(toLocal(new Date("2026-09-23T23:30:00Z"), TZ)).toEqual({ date: "2026-09-24", time: "01:30", weekday: 4 });
  });
});

describe("resolveDue", () => {
  it("resolves a date-only due to the end of the work day", () => {
    expect(resolveDue({ date: "2026-09-24", time: null }, settings)).toEqual({ dueAt: "2026-09-24T17:00:00+02:00", dueHasTime: false });
    expect(resolveDue({ date: "2026-11-02", time: null }, settings)).toEqual({ dueAt: "2026-11-02T17:00:00+01:00", dueHasTime: false });
  });

  it("keeps an explicit time", () => {
    expect(resolveDue({ date: "2026-09-25", time: "10:30" }, settings)).toEqual({ dueAt: "2026-09-25T10:30:00+02:00", dueHasTime: true });
  });

  it("honours a custom end of work day", () => {
    expect(resolveDue({ date: "2026-09-24", time: null }, { ...settings, endOfWorkDay: "18:30" })?.dueAt).toBe("2026-09-24T18:30:00+02:00");
  });

  it("rejects invalid dates and times", () => {
    expect(resolveDue({ date: "2026-02-30", time: null }, settings)).toBeNull();
    expect(resolveDue({ date: "2026-09-24", time: "25:00" }, settings)).toBeNull();
    expect(resolveDue({ date: "tomorrow", time: null }, settings)).toBeNull();
  });
});
