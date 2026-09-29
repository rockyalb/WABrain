import { describe, expect, it } from "vitest";
import { buildWorkingMemory, citableIds, fromNormalizedMessage, type WorkingMemoryInput } from "./working-memory.js";

const input: WorkingMemoryInput = {
  now: new Date("2026-09-23T08:05:00Z"), // Wednesday 10:05 in Rome
  settings: { timezone: "Europe/Rome", endOfWorkDay: "17:00" },
  chat: { id: "c1", name: "Ana", isGroup: false, defaultContextId: "ctx-work" },
  contexts: [
    { id: "ctx-work", name: "Work" },
    { id: "ctx-personal", name: "Personal" },
  ],
  person: {
    displayName: "Ana",
    languages: ["en"],
    facts: [
      {
        id: "f1",
        key: "company",
        value: "Vodafone",
        confidence: 0.8,
        verified: false,
        selfClaimed: true,
        source: "ai",
        sourceMessageIds: ["x"],
        updatedAt: "2026-09-01T00:00:00Z",
      },
    ],
  },
  ownerName: "Alex",
  burst: [
    { id: "m3", at: "2026-09-23T08:04:00Z", fromOwner: false, text: "send me the contract tomorrow", quotedMessageId: "q1" },
    { id: "m2", at: "2026-09-23T08:03:00Z", fromOwner: true, senderName: "Alex", text: "" , kind: "voice", derivedText: "will look at it today", derivedKind: "transcript" },
  ],
  preceding: [
    { id: "p2", at: 1790150400, fromOwner: false, text: "pershendetje" },
    { id: "p1", at: "2026-09-22T10:00:00Z", fromOwner: true, text: "Hello, how are you?" },
    { id: "m3", at: "2026-09-23T08:04:00Z", fromOwner: false, text: "duplicate of a burst message" },
  ],
  quoted: [
    { id: "q1", at: "2026-09-01T09:00:00Z", fromOwner: true, text: "the contract is ready" },
    { id: "p1", at: "2026-09-22T10:00:00Z", fromOwner: true, text: "already in window" },
  ],
  openTasks: [
    { id: "t1", kind: "todo", title: "Send the contract", dueAt: "2026-09-24T15:00:00Z", dueHasTime: false },
    { id: "t2", kind: "waiting_on", title: "Ana dergon fotot", dueAt: "2026-09-25T08:30:00Z", dueHasTime: true },
    { id: "t3", kind: "todo", title: "Pa afat", dueAt: null, dueHasTime: false },
  ],
};

describe("buildWorkingMemory", () => {
  const memory = buildWorkingMemory(input);

  it("gives the local time and a calendar for relative dates", () => {
    expect(memory.now).toMatchObject({
      instant: "2026-09-23T10:05:00+02:00",
      localDate: "2026-09-23",
      localTime: "10:05",
      weekday: "Wednesday",
      timezone: "Europe/Rome",
      endOfWorkDay: "17:00",
    });
    expect(memory.calendar).toMatchObject({
      today: "2026-09-23",
      tomorrow: "2026-09-24",
      dayAfterTomorrow: "2026-09-25",
      nextMonday: "2026-09-28",
      endOfMonth: "2026-09-30",
    });
    expect(memory.calendar.nextDays[1]).toEqual({ date: "2026-09-25", weekday: "Friday" });
    expect(memory.calendar.nextDays).toHaveLength(7);
  });

  it("maps 'next week' on a Monday to the following Monday", () => {
    const monday = buildWorkingMemory({ ...input, now: new Date("2026-09-28T08:00:00Z") });
    expect(monday.calendar.nextMonday).toBe("2026-10-05");
  });

  it("orders messages oldest first, marks the burst, and dedupes", () => {
    expect(memory.messages.map((message) => [message.id, message.isNew])).toEqual([
      ["p1", false],
      ["p2", false],
      ["m2", true],
      ["m3", true],
    ]);
    expect(memory.messages.find((message) => message.id === "m3")?.text).toBe("send me the contract tomorrow");
  });

  it("formats times locally and labels owner vs contact", () => {
    const m3 = memory.messages.find((message) => message.id === "m3")!;
    expect(m3).toMatchObject({ time: "2026-09-23 10:04", from: "contact", sender: "Ana", replyTo: "q1", language: "en" });
    expect(memory.messages.find((message) => message.id === "p2")?.time).toBe("2026-09-23 10:00");
  });

  it("keeps derived media text separate from typed text", () => {
    const voice = memory.messages.find((message) => message.id === "m2")!;
    expect(voice.text).toBe("[voice]");
    expect(voice.derived).toEqual({ type: "transcript", text: "will look at it today" });
    expect(voice.from).toBe("owner");
  });

  it("includes quoted messages outside the window only", () => {
    expect(memory.quotedMessages.map((message) => message.id)).toEqual(["q1"]);
  });

  it("lists open tasks with local dues (date-only vs timed)", () => {
    expect(memory.openTasks).toEqual([
      { id: "t1", kind: "todo", title: "Send the contract", due: "2026-09-24" },
      { id: "t2", kind: "waiting_on", title: "Ana dergon fotot", due: "2026-09-25 10:30" },
      { id: "t3", kind: "todo", title: "Pa afat", due: null },
    ]);
  });

  it("carries the chat, default context, contexts and person profile", () => {
    expect(memory.chat).toEqual({ id: "c1", name: "Ana", type: "direct", defaultContext: { id: "ctx-work", name: "Work" } });
    expect(memory.person).toEqual({ name: "Ana", languages: ["en"], facts: [{ key: "company", value: "Vodafone", verified: false }] });
  });

  it("applies limits", () => {
    const limited = buildWorkingMemory({
      ...input,
      burst: [{ id: "long", at: "2026-09-23T08:04:00Z", fromOwner: false, text: "x".repeat(50) }],
      limits: { maxPreceding: 1, maxTextChars: 10, maxOpenTasks: 1 },
    });
    // Only the most recent preceding message is kept.
    expect(limited.messages.map((message) => message.id)).toEqual(["m3", "long"]);
    expect(limited.messages[1]?.text).toBe(`${"x".repeat(10)}… [truncated]`);
    expect(limited.openTasks).toHaveLength(1);
  });

  it("exposes the citable ids", () => {
    const ids = citableIds(memory);
    expect([...ids.burst].sort()).toEqual(["m2", "m3"]);
    expect(ids.all.has("q1")).toBe(true);
    expect([...ids.openTasks]).toEqual(["t1", "t2", "t3"]);
    expect([...ids.contexts]).toEqual(["ctx-work", "ctx-personal"]);
  });
});

describe("fromNormalizedMessage", () => {
  it("maps direction and Unix-second timestamps", () => {
    const message = fromNormalizedMessage({
      id: "n1",
      timestamp: 1_790_150_400,
      direction: "outgoing",
      senderName: null,
      body: "",
      kind: "voice",
      derivedText: "transkript",
      language: null,
      quotedMessageId: null,
    });
    expect(message).toMatchObject({ id: "n1", at: 1_790_150_400, fromOwner: true, derivedKind: "transcript", derivedText: "transkript" });
  });
});
