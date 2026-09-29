import { describe, expect, it } from "vitest";
import { answerFromChunks, type RetrievedChunk } from "./ask.js";
import { createMockProviders, mockJsonModel } from "./testing/index.js";

const chunks: RetrievedChunk[] = [
  {
    chatId: "c-ana",
    chatName: "Ana",
    messages: [
      { id: "a1", at: "2026-09-10T09:00:00+02:00", senderName: "Ana", fromOwner: false, text: "The office rent is 400 EUR a month, due by the 5th." },
      { id: "a2", at: "2026-09-10T09:02:00+02:00", senderName: null, fromOwner: true, text: "ok, I'll pay it this month" },
    ],
  },
  {
    chatId: "c-mira",
    messages: [{ id: "b1", at: "2026-09-12T20:00:00+02:00", senderName: "Mira", fromOwner: false, text: "", derivedText: "Photo of a restaurant menu." }],
  },
];

const providersWith = (output: unknown) => {
  const model = mockJsonModel(output);
  return { model, providers: createMockProviders({ text: model }) };
};

const settings = { timezone: "Europe/Rome", endOfWorkDay: "17:00" };

describe("answerFromChunks", () => {
  it("answers with validated citations and stored excerpts", async () => {
    const { providers, model } = providersWith({
      found: true,
      answer: "The rent is 400 EUR a month.",
      citedMessageIds: ["a1", "invented", "a1"],
      suggestedTask: null,
    });
    const result = await answerFromChunks(providers, "How much is the office rent?", chunks, { settings });
    expect(result).toMatchObject({
      found: true,
      answer: "The rent is 400 EUR a month.",
      citations: [{ messageId: "a1", chatId: "c-ana", excerpt: "The office rent is 400 EUR a month, due by the 5th.", at: "2026-09-10T09:00:00+02:00" }],
      suggestedAction: null,
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain("<messages>");
    expect(prompt).toContain("2026-09-10 09:00");
  });

  it("says it did not find anything without calling the model when there are no chunks", async () => {
    const { providers, model } = providersWith({});
    expect(await answerFromChunks(providers, "When is the meeting?", [])).toMatchObject({
      found: false,
      answer: "I didn't find this in your chats.",
      citations: [],
      suggestedAction: null,
      run: null,
    });
    expect((await answerFromChunks(providers, "When is the meeting?", [])).answer).toBe("I didn't find this in your chats.");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("turns an answer without valid citations into not found", async () => {
    const { providers } = providersWith({ found: true, answer: "It is on Friday.", citedMessageIds: ["made-up"], suggestedTask: null });
    expect(await answerFromChunks(providers, "When is the meeting?", chunks)).toMatchObject({ found: false, answer: "I didn't find this in your chats." });
  });

  it("respects the model's found=false", async () => {
    const { providers } = providersWith({ found: false, answer: "No idea", citedMessageIds: ["a1"], suggestedTask: null });
    expect((await answerFromChunks(providers, "Who is the CFO?", chunks)).found).toBe(false);
  });

  it("returns a suggested task for the owner to tap, with a resolved due and cited evidence", async () => {
    const { providers } = providersWith({
      found: true,
      answer: "You said you would pay the rent this month.",
      citedMessageIds: ["a1", "a2"],
      suggestedTask: { kind: "todo", title: "Pay the office rent", description: "400 EUR by 5 October.", language: "en", due: { date: "2026-10-05", time: null }, confidence: 0.8 },
    });
    const result = await answerFromChunks(providers, "Did I pay the rent?", chunks, { settings });
    expect(result.suggestedAction).toMatchObject({
      type: "create",
      kind: "todo",
      title: "Pay the office rent",
      dueAt: "2026-10-05T17:00:00+02:00",
      dueHasTime: false,
      evidenceMessageIds: ["a1", "a2"],
      contextId: null,
    });
  });

  it("drops an invalid suggested task", async () => {
    const { providers } = providersWith({
      found: true,
      answer: "Po.",
      citedMessageIds: ["a1"],
      suggestedTask: { kind: "todo", title: "x", description: "", language: null, due: null, confidence: 0.5 },
    });
    expect((await answerFromChunks(providers, "A?", chunks)).suggestedAction).toBeNull();
  });
});
