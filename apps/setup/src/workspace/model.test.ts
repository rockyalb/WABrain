import { describe, expect, it } from "vitest";
import { filterOptions, jidPhone, timeKey, zonedDateTime } from "./model";

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
    expect(labels("069 111")).toEqual(["Sam Carter"]);
    expect(labels("069")).toEqual(["Sam Carter", "Samira Çelik"]);
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
