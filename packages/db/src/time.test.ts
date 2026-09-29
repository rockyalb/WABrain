import { describe, expect, it } from "vitest";
import { isValidTimeZone, resolveDateOnly, zonedTimeToUtc } from "./time.js";

const TZ = "Europe/Rome";

describe("date-only due resolution", () => {
  it("uses end of work day in winter time (UTC+1)", () => {
    expect(resolveDateOnly("2026-01-15", "17:00", TZ).toISOString()).toBe("2026-01-15T16:00:00.000Z");
  });

  it("crosses the spring-forward boundary (2026-03-29)", () => {
    expect(resolveDateOnly("2026-03-28", "17:00", TZ).toISOString()).toBe("2026-03-28T16:00:00.000Z");
    expect(resolveDateOnly("2026-03-29", "17:00", TZ).toISOString()).toBe("2026-03-29T15:00:00.000Z");
  });

  it("crosses the fall-back boundary (2026-10-25)", () => {
    expect(resolveDateOnly("2026-10-24", "17:00", TZ).toISOString()).toBe("2026-10-24T15:00:00.000Z");
    expect(resolveDateOnly("2026-10-25", "17:00", TZ).toISOString()).toBe("2026-10-25T16:00:00.000Z");
  });

  it("shifts a time inside the spring gap forward", () => {
    // 02:30 does not exist on 2026-03-29 in Rome; it becomes 03:30 (+02:00).
    expect(resolveDateOnly("2026-03-29", "02:30", TZ).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("picks the earlier instant for an ambiguous fall-back time", () => {
    // 02:30 happens twice on 2026-10-25; the first is at +02:00.
    expect(resolveDateOnly("2026-10-25", "02:30", TZ).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("handles midnight and other zones", () => {
    expect(resolveDateOnly("2026-07-01", "00:00", TZ).toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(resolveDateOnly("2026-03-08", "17:00", "America/New_York").toISOString()).toBe("2026-03-08T21:00:00.000Z");
    expect(zonedTimeToUtc({ year: 2026, month: 5, day: 1, hour: 9, minute: 15 }, "UTC").toISOString()).toBe(
      "2026-05-01T09:15:00.000Z",
    );
  });

  it("rejects impossible dates and times", () => {
    expect(() => resolveDateOnly("2026-02-30", "17:00", TZ)).toThrow(RangeError);
    expect(() => resolveDateOnly("2026-02-10", "25:00", TZ)).toThrow(RangeError);
    expect(isValidTimeZone("Europe/Rome")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});
