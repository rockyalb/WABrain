import { describe, expect, it } from "vitest";
import type { Person, PersonFact } from "@wabrain/contracts";
import { extractPersonFacts, suggestChatContext, type ProfileMessageInput } from "./profile.js";
import { createMockProviders, mockJsonModel } from "./testing/index.js";

const fact = (overrides: Partial<PersonFact>): PersonFact => ({
  id: "f",
  key: "company",
  value: "Vodafone",
  confidence: 0.7,
  verified: false,
  selfClaimed: false,
  source: "ai",
  sourceMessageIds: ["x"],
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});

const person: Pick<Person, "id" | "displayName" | "languages" | "facts"> = {
  id: "p1",
  displayName: "Ana",
  languages: ["en"],
  facts: [fact({ id: "f-owner", key: "relationship", value: "client", source: "owner", verified: true }), fact({ id: "f-lang", key: "language", value: "en", confidence: 0.9 })],
};

const messages: ProfileMessageInput[] = [
  { id: "m1", at: "2026-09-20T09:00:00Z", fromOwner: false, text: "I'm the CFO at Vodafone now, call me on the new number" },
  { id: "m2", at: "2026-09-20T09:05:00Z", fromOwner: true, text: "Urime Ana! Babai yt si eshte?" },
  { id: "m3", at: "2026-09-20T09:06:00Z", fromOwner: false, text: "Good, my dad is a doctor in Porto. We're talking about the fibre tender" },
];

const extract = async (facts: unknown[]) => {
  const model = mockJsonModel({ facts });
  const result = await extractPersonFacts(createMockProviders({ text: model }), person, messages, { now: new Date("2026-09-23T08:00:00Z") });
  return { result, model };
};

const raw = (overrides: Record<string, unknown>) => ({
  subject: "this_person",
  key: "role",
  value: "CFO",
  confidence: 0.8,
  selfClaimed: false,
  sourceMessageIds: ["m1"],
  ...overrides,
});

describe("extractPersonFacts", () => {
  it("flags identity claims from the person's own messages as self-claimed, whatever the model says", async () => {
    const { result } = await extract([raw({ selfClaimed: false }), raw({ key: "company", value: "Vodafone", confidence: 0.9 })]);
    expect(result.facts).toEqual([
      { key: "role", value: "CFO", confidence: 0.8, selfClaimed: true, sourceMessageIds: ["m1"], existingFactId: null },
      { key: "company", value: "Vodafone", confidence: 0.9, selfClaimed: true, sourceMessageIds: ["m1"], existingFactId: null },
    ]);
  });

  it("does not mark a fact the owner stated as self-claimed", async () => {
    const { result } = await extract([raw({ key: "name", value: "Ana Carter", sourceMessageIds: ["m2"], selfClaimed: true })]);
    expect(result.facts[0]).toMatchObject({ key: "name", selfClaimed: false });
  });

  it("never stores facts about third parties on this person", async () => {
    const { result } = await extract([raw({ subject: "someone_else", key: "role", value: "doctor", sourceMessageIds: ["m3"] })]);
    expect(result.facts).toEqual([]);
  });

  it("drops facts with unknown or no sources", async () => {
    const { result } = await extract([raw({ sourceMessageIds: ["ghost"] }), raw({ sourceMessageIds: ["m1", "ghost"] }), raw({ sourceMessageIds: [] })]);
    expect(result.facts).toEqual([]);
  });

  it("never contradicts an owner-entered or verified fact", async () => {
    const { result } = await extract([raw({ key: "relationship", value: "friend", sourceMessageIds: ["m1"] })]);
    expect(result.facts).toEqual([]);
  });

  it("skips unchanged facts and proposes stronger evidence as an update", async () => {
    const { result } = await extract([
      raw({ key: "language", value: "EN", confidence: 0.5, selfClaimed: false }),
      raw({ key: "topic", value: "fibre tender", confidence: 0.6, sourceMessageIds: ["m3"] }),
    ]);
    expect(result.facts).toEqual([
      { key: "topic", value: "fibre tender", confidence: 0.6, selfClaimed: false, sourceMessageIds: ["m3"], existingFactId: null },
    ]);
  });

  it("updates an AI fact when confidence grows", async () => {
    const withAiCompany = { ...person, facts: [fact({ id: "f-co", key: "company", value: "Vodafone", confidence: 0.4 })] };
    const model = mockJsonModel({ facts: [raw({ key: "company", value: "vodafone", confidence: 0.9 })] });
    const result = await extractPersonFacts(createMockProviders({ text: model }), withAiCompany, messages);
    expect(result.facts[0]).toMatchObject({ existingFactId: "f-co", confidence: 0.9 });
  });

  it("makes no model call without messages", async () => {
    const model = mockJsonModel({ facts: [] });
    expect(await extractPersonFacts(createMockProviders({ text: model }), person, [])).toEqual({ facts: [], run: null });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("marks group messages by the subject via fromPerson", async () => {
    const group: ProfileMessageInput[] = [{ id: "g1", at: "2026-09-20T09:00:00Z", fromOwner: false, fromPerson: false, text: "Ana eshte menaxhere" }];
    const model = mockJsonModel({ facts: [raw({ sourceMessageIds: ["g1"], value: "manager" })] });
    const result = await extractPersonFacts(createMockProviders({ text: model }), person, group);
    expect(result.facts[0]).toMatchObject({ value: "manager", selfClaimed: false });
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain('\\"bySubject\\":false');
  });
});

describe("suggestChatContext", () => {
  const contexts = [
    { id: "ctx-work", name: "Work" },
    { id: "ctx-personal", name: "Personal" },
  ];

  it("keeps the owner's choice", () => {
    expect(suggestChatContext({ defaultContextId: "ctx-personal", facts: [] }, contexts)).toEqual({ contextId: "ctx-personal", confidence: 1 });
  });

  it("suggests Work for clients, companies and roles", () => {
    const suggestion = suggestChatContext({ defaultContextId: null, facts: [fact({ key: "relationship", value: "client", verified: true }), fact({ key: "company", value: "Vodafone" })] }, contexts);
    expect(suggestion.contextId).toBe("ctx-work");
    expect(suggestion.confidence).toBeGreaterThan(0.8);
  });

  it("suggests Personal for family and friends", () => {
    expect(suggestChatContext({ defaultContextId: null, facts: [fact({ key: "relationship", value: "sister", verified: true })] }, contexts)).toEqual({
      contextId: "ctx-personal",
      confidence: 1,
    });
    expect(suggestChatContext({ defaultContextId: null, facts: [fact({ key: "relationship", value: "childhood friend", confidence: 0.9 })] }, contexts).contextId).toBe(
      "ctx-personal",
    );
  });

  it("lowers confidence when signals conflict and returns null without any", () => {
    const mixed = suggestChatContext(
      { defaultContextId: null, facts: [fact({ key: "relationship", value: "friend", confidence: 0.6 }), fact({ key: "company", value: "Vodafone", confidence: 0.6 })] },
      contexts,
    );
    expect(mixed.contextId).toBe("ctx-personal");
    expect(mixed.confidence).toBeLessThan(0.6);
    expect(suggestChatContext({ defaultContextId: null, facts: [] }, contexts)).toEqual({ contextId: null, confidence: 0 });
  });

  it("matches alternative context names", () => {
    const named = [
      { id: "a", name: "Business" },
      { id: "b", name: "Home" },
    ];
    expect(suggestChatContext({ defaultContextId: null, facts: [fact({ key: "relationship", value: "colleague", verified: true })] }, named).contextId).toBe("a");
    expect(suggestChatContext({ defaultContextId: null, facts: [fact({ key: "relationship", value: "cousin", verified: true })] }, named).contextId).toBe("b");
  });
});
