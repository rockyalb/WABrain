import { describe, expect, it } from "vitest";
import { formatReport, parseArgs } from "./operations.js";

describe("operations command", () => {
  it("accepts only the documented forms", () => {
    expect(parseArgs(["failures"])).toEqual({ command: "failures", json: false });
    expect(parseArgs(["failures", "--queue", "embed-chat", "--limit", "20", "--json"])).toEqual({
      command: "failures",
      queue: "embed-chat",
      limit: 20,
      json: true,
    });
    expect(parseArgs(["retry", "7d0c1d8e-58c4-4d5e-9d63-8f3f6f7b1f0a"])).toMatchObject({ command: "retry", id: "7d0c1d8e-58c4-4d5e-9d63-8f3f6f7b1f0a" });
    expect(parseArgs(["requeue-media"])).toEqual({ command: "requeue-media", json: false });
    expect(parseArgs(["requeue-media", "--all"])).toBeNull();
    expect(parseArgs(["requeue-voice"])).toEqual({ command: "requeue-voice", json: false });
    expect(parseArgs(["requeue-voice", "--all"])).toBeNull();
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["retry"])).toBeNull();
    expect(parseArgs(["retry", "a", "b"])).toBeNull();
    expect(parseArgs(["failures", "--queue", "dead.embed-chat"])).toBeNull();
    expect(parseArgs(["failures", "--limit", "all"])).toBeNull();
    expect(parseArgs(["drop"])).toBeNull();
  });

  it("prints a readable report", () => {
    expect(formatReport({ counts: {}, items: [] })).toBe("No failed jobs are waiting.");
    const text = formatReport({
      counts: { "embed-chat": 1 },
      items: [
        {
          id: "7d0c1d8e-58c4-4d5e-9d63-8f3f6f7b1f0a",
          queue: "embed-chat",
          sourceJobId: null,
          subject: { chatId: "[redacted]" },
          attempts: 4,
          createdAt: null,
          failedAt: "2026-09-24T10:00:00.000Z",
          reason: "Timed out; inspect worker capacity and provider availability.",
        },
      ],
    });
    expect(text).toContain("embed-chat 1");
    expect(text).toContain("7d0c1d8e-58c4-4d5e-9d63-8f3f6f7b1f0a  embed-chat  attempts=4  chatId=[redacted]");
    expect(text).toContain("operations retry <id>");
  });
});
