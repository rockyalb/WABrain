import type { ChunkableMessage } from "@wabrain/db";
import { describe, expect, it } from "vitest";
import { buildChunkWindows, messageLine, messageLines, splitContent } from "./chunking.js";

const base = Date.parse("2026-09-01T08:00:00Z");
const message = (index: number, minutes: number, overrides: Partial<ChunkableMessage> = {}): ChunkableMessage => ({
  id: `m${index}`,
  sentAt: new Date(base + minutes * 60_000),
  fromOwner: false,
  senderName: "Sam",
  kind: "text",
  body: `mesazhi ${index}`,
  derivedText: null,
  ...overrides,
});

describe("messageLine", () => {
  it("labels the speaker and appends derived media text", () => {
    expect(messageLine(message(1, 0, { fromOwner: true, body: "  sent   it ✅ " }))).toBe("Me: sent it ✅");
    expect(messageLine(message(2, 0, { kind: "image", body: "", derivedText: "Invoice no. 42" }))).toBe("Sam: [image: Invoice no. 42]");
    expect(messageLine(message(3, 0, { kind: "voice", body: "", derivedText: "Coming at 5" }))).toBe("Sam: [voice note: Coming at 5]");
    expect(messageLine(message(4, 0, { senderName: null }))).toBe("Contact: mesazhi 4");
    expect(messageLine(message(5, 0, { kind: "image", body: "", derivedText: null }))).toBeNull();
    expect(messageLine(message(6, 0, { body: "x".repeat(50) }), 20)).toHaveLength(20);
  });
});

describe("buildChunkWindows", () => {
  it("splits conversations at quiet gaps and skips messages without text", () => {
    const windows = buildChunkWindows([
      message(1, 0),
      message(2, 5, { kind: "image", body: "" }),
      message(3, 10),
      message(4, 200),
    ]);
    expect(windows.map((window) => window.messageIds)).toEqual([["m1", "m3"], ["m4"]]);
    expect(windows[0]).toMatchObject({ text: "Sam: mesazhi 1\nSam: mesazhi 3", fromAt: new Date(base), toAt: new Date(base + 10 * 60_000) });
  });

  it("caps windows by messages and characters, with overlap", () => {
    const messages = Array.from({ length: 10 }, (_, index) => message(index, index));
    const windows = buildChunkWindows(messages, { maxMessages: 4, overlap: 1 });
    expect(windows.map((window) => window.messageIds)).toEqual([
      ["m0", "m1", "m2", "m3"],
      ["m3", "m4", "m5", "m6"],
      ["m6", "m7", "m8", "m9"],
    ]);

    const long = [message(0, 0, { body: "a".repeat(100) }), message(1, 1, { body: "b".repeat(100) }), message(2, 2)];
    expect(buildChunkWindows(long, { maxChars: 150, overlap: 2 }).map((window) => window.messageIds)).toEqual([["m0"], ["m1", "m2"]]);
  });

  it("only changes the last window of a conversation when messages are appended", () => {
    const messages = Array.from({ length: 25 }, (_, index) => message(index, index));
    const before = buildChunkWindows(messages);
    const after = buildChunkWindows([...messages, message(25, 25), message(26, 400)]);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after[before.length - 1]!.messageIds).toContain("m25");
    expect(after[after.length - 1]!.messageIds).toEqual(["m26"]);
  });

  it("returns no windows for an empty chat", () => {
    expect(buildChunkWindows([])).toEqual([]);
  });

  it("splits long message and PDF-derived text without losing the citation identity or tail", () => {
    const lateFact = "LATE-FACT-9917";
    const body = `${"contract section obligations payment deadline ".repeat(240)}${lateFact}`;
    const windows = buildChunkWindows([message(70, 0, { body })], { maxLineChars: 500, maxChars: 1_200 });
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.messageIds.includes("m70"))).toBe(true);
    // Parts of one message sharing a window cite it once.
    expect(windows.every((window) => new Set(window.messageIds).size === window.messageIds.length)).toBe(true);
    expect(windows.some((window) => window.text.includes(lateFact))).toBe(true);
    expect(messageLines(message(71, 0, { kind: "document", body: "", derivedText: `${"Page 1: material goes here ".repeat(80)}${lateFact}` }), 240)
      .some((line) => line.includes(lateFact))).toBe(true);
  });

  it("keeps every word of long content, repeats a little at each boundary, and keeps short lines unchanged", () => {
    const words = Array.from({ length: 600 }, (_, index) => `w${index}`);
    const content = words.join(" ");
    const parts = splitContent(content, 300);
    expect(parts.length).toBeGreaterThan(8);
    expect(parts.every((part) => part.length <= 300 && part === part.trim())).toBe(true);
    // No word is cut, every word appears, and consecutive parts overlap.
    const seen = new Set(parts.flatMap((part) => part.split(" ")));
    expect(words.every((word) => seen.has(word))).toBe(true);
    expect([...seen].every((word) => words.includes(word))).toBe(true);
    for (let index = 1; index < parts.length; index += 1) {
      expect(parts[index - 1]!.endsWith(parts[index]!.split(" ")[0]!) || parts[index - 1]!.includes(` ${parts[index]!.split(" ")[0]} `)).toBe(true);
    }
    // A phrase straddling a boundary is whole in some part.
    expect(parts.some((part) => part.includes("w299 w300 w301"))).toBe(true);
    expect(splitContent("short", 300)).toEqual(["short"]);
    expect(messageLines(message(80, 0, { body: "Good afternoon" }))).toEqual([messageLine(message(80, 0, { body: "Good afternoon" }))]);
  });
});
