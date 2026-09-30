import { describe, expect, it } from "vitest";
import { closedRecently, filterOptions, jidPhone, taskActivityToday, timeKey, zonedDateTime } from "./model";

describe("workspace due times", () => {
  it("uses the saved timezone even when the browser has another timezone", () => {
    expect(zonedDateTime("2026-09-28", "10:30", "Europe/Rome")).toBe("2026-09-28T08:30:00.000Z");
    expect(timeKey("2026-09-28T08:30:00.000Z", { timezone: "Europe/Rome" })).toBe("10:30");
  });

  it("resolves daylight saving gaps and overlaps consistently", () => {
    expect(zonedDateTime("2026-03-29", "02:30", "Europe/Rome")).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedDateTime("2026-10-25", "02:30", "Europe/Rome")).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("person filter", () => {
  const people = [
    { value: "1", label: "Sam Carter", detail: "+447691112233" },
    { value: "2", label: "Samira Çelik", detail: "+447697778899" },
    { value: "3", label: "Mira", detail: undefined },
  ];
  const labels = (query: string) => filterOptions(people, query).map((option) => option.label);

  it("ignores accents and case and puts names that start with the query first", () => {
    expect(labels("samira celik")).toEqual(["Samira Çelik"]);
    expect(labels("mira")).toEqual(["Mira", "Samira Çelik"]);
    expect(labels("")).toHaveLength(3);
  });

  it("finds a contact by part of the phone number", () => {
    expect(labels("07691 112")).toEqual(["Sam Carter"]);
    expect(labels("0769")).toEqual(["Sam Carter", "Samira Çelik"]);
    expect(labels("69111")).toEqual(["Sam Carter"]);
    expect(labels("+44 7697 778")).toEqual(["Samira Çelik"]);
  });

  it("reads phone numbers only from phone JIDs", () => {
    expect(jidPhone("447691112233@s.whatsapp.net")).toBe("+447691112233");
    expect(jidPhone("447691112233:12@s.whatsapp.net")).toBe("+447691112233");
    expect(jidPhone("120363000000000000@g.us")).toBeNull();
    expect(jidPhone("123456789012345@lid")).toBeNull();
  });
});

describe("recently closed", () => {
  const settings = { timezone: "Europe/Rome" };
  const now = new Date("2026-09-29T09:00:00.000Z");
  it("keeps tasks closed today and yesterday in the saved timezone", () => {
    expect(closedRecently({ closedAt: "2026-09-29T07:00:00.000Z" }, settings, now)).toBe(true);
    expect(closedRecently({ closedAt: "2026-09-27T22:30:00.000Z" }, settings, now)).toBe(true); // 00:30 on the 28th in Rome
    expect(closedRecently({ closedAt: "2026-09-27T21:30:00.000Z" }, settings, now)).toBe(false); // 23:30 on the 27th
    expect(closedRecently({ closedAt: "2026-09-01T12:00:00.000Z" }, settings, now)).toBe(false);
  });
});

describe("daily task activity", () => {
  const settings = { timezone: "Europe/Rome" };
  const now = new Date("2026-09-30T10:00:00.000Z");
  const task = (id: string, status: "open" | "done" | "cancelled", createdAt: string, closedAt: string | null) => ({ id, status, createdAt, closedAt });

  it("counts all completions today independently from all tasks created today", () => {
    const counts = taskActivityToday([
      task("old-done", "done", "2026-09-20T10:00:00.000Z", "2026-09-30T08:00:00.000Z"),
      task("new-open", "open", "2026-09-30T09:00:00.000Z", null),
      task("new-cancelled", "cancelled", "2026-09-30T09:30:00.000Z", "2026-09-30T09:45:00.000Z"),
      task("new-done-yesterday", "done", "2026-09-30T07:00:00.000Z", "2026-09-29T07:00:00.000Z"),
    ] as Parameters<typeof taskActivityToday>[0], settings, now);
    expect(counts).toEqual({ completed: 1, created: 3 });
  });

  it("uses the configured timezone at the date boundary", () => {
    const counts = taskActivityToday([
      task("rome-today", "done", "2026-09-29T22:30:00.000Z", "2026-09-29T22:45:00.000Z"),
      task("rome-yesterday", "done", "2026-09-29T21:30:00.000Z", "2026-09-29T21:45:00.000Z"),
    ] as Parameters<typeof taskActivityToday>[0], settings, now);
    expect(counts).toEqual({ completed: 1, created: 1 });
  });
});
