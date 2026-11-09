import { describe, expect, it } from "vitest";
import { editDistance, linkedChatIds, nameWordFuzzyMatches, nameWordMatches, resolveLinkName, resolveTaskLinks, type LinkableChat } from "./links.js";

const NOW = new Date("2026-10-01T12:00:00+02:00");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const chat = (id: string, name: string, overrides: Partial<LinkableChat> = {}): LinkableChat => ({
  id,
  isGroup: false,
  name,
  names: [name],
  lastMessageAt: daysAgo(3),
  ...overrides,
});

const resolve = (name: string, chats: LinkableChat[], excludeChatIds: string[] = []) =>
  resolveLinkName(name, chats, { excludeChatIds, now: NOW });

describe("nameWordMatches", () => {
  it("matches the same folded word", () => {
    expect(nameWordMatches("jordan", "jordan")).toBe(true);
  });
  it("does not match other names that only share a prefix", () => {
    expect(nameWordMatches("jordana", "jordan")).toBe(false);
    expect(nameWordMatches("sam", "samantha")).toBe(false);
  });
});

describe("fuzzy matching", () => {
  it("counts a swap of two neighbouring letters as one edit", () => {
    expect(editDistance("jordna", "jordan")).toBe(1);
    expect(editDistance("micheal", "michael")).toBe(1);
  });
  it("tolerates one typo in names of five or more letters", () => {
    expect(nameWordFuzzyMatches("jordna", "jordan")).toBe(true);
    expect(nameWordFuzzyMatches("kristen", "kristin")).toBe(true);
    expect(nameWordFuzzyMatches("jrodna", "jordan")).toBe(false);
  });
  it("never treats short names as typos of each other", () => {
    expect(nameWordFuzzyMatches("dana", "dina")).toBe(false);
    expect(nameWordFuzzyMatches("sam", "pam")).toBe(false);
  });
});

describe("resolveLinkName", () => {
  it("links the one chat a name means, with or without a possessive", () => {
    const chats = [chat("c-jordan", "Jordan"), chat("c-casey", "Casey <3"), chat("c-ben", "Ben")];
    expect(resolve("Jordan", chats)).toEqual({ name: "Jordan", chatId: "c-jordan", candidates: [], source: "ai" });
    expect(resolve("Jordan's", chats).chatId).toBe("c-jordan");
  });

  it("matches a first name against a full contact name, ignoring diacritics and the ~ mark", () => {
    const chats = [chat("c-1", "~Jordan Price"), chat("c-2", "Zoë Müller")];
    expect(resolve("jordan", chats).chatId).toBe("c-1");
    expect(resolve("Zoe", chats).chatId).toBe("c-2");
  });

  it("matches any of the chat's names (saved contact name, person name)", () => {
    const chats = [chat("c-1", "Mom", { names: ["Mom", "Dana Price"] })];
    expect(resolve("Dana", chats).chatId).toBe("c-1");
  });

  it("asks when several people the owner talks to share the name, most recent first", () => {
    const chats = [chat("c-robin-1", "Robin Hale", { lastMessageAt: daysAgo(30) }), chat("c-robin-2", "Robin Diaz", { lastMessageAt: daysAgo(2) })];
    const link = resolve("Robin", chats);
    expect(link.chatId).toBeNull();
    expect(link.candidates.map((candidate) => candidate.chatId)).toEqual(["c-robin-2", "c-robin-1"]);
  });

  it("picks the only matching person talked to within a year", () => {
    const chats = [
      chat("c-robin-old", "Robin Hale", { lastMessageAt: daysAgo(500) }),
      chat("c-robin-unknown", "Robin", { lastMessageAt: null }),
      chat("c-robin", "Robin Diaz", { lastMessageAt: daysAgo(10) }),
    ];
    expect(resolve("Robin", chats).chatId).toBe("c-robin");
  });

  it("offers a typo match but never links it on its own", () => {
    const link = resolve("Jordna", [chat("c-jordan", "Jordan")]);
    expect(link.chatId).toBeNull();
    expect(link.candidates).toEqual([{ chatId: "c-jordan", name: "Jordan" }]);
  });

  it("prefers an exact match over a typo match", () => {
    expect(resolve("Kristin", [chat("c-1", "Kristen"), chat("c-2", "Kristin")]).chatId).toBe("c-2");
  });

  it("offers partial matches when the full name matches nobody", () => {
    const link = resolve("Jordan Price", [chat("c-1", "Jordan Lee")]);
    expect(link.chatId).toBeNull();
    expect(link.candidates.map((candidate) => candidate.chatId)).toEqual(["c-1"]);
  });

  it("returns an unconfirmed link without candidates when nothing matches", () => {
    expect(resolve("Taylor", [chat("c-1", "Jordan")])).toEqual({ name: "Taylor", chatId: null, candidates: [], source: "ai" });
  });

  it("never links the task's own chat", () => {
    const chats = [chat("c-casey", "Casey")];
    expect(resolve("Casey", chats, ["c-casey"]).chatId).toBeNull();
  });

  it("restricts a name with a group word to groups", () => {
    const chats = [chat("c-person", "Design"), chat("c-group", "Design Team", { isGroup: true })];
    expect(resolve("the Design group", chats).chatId).toBe("c-group");
    expect(resolve("Design chat", chats).chatId).toBe("c-group");
    expect(resolve("Design", chats).chatId).toBe("c-person");
  });

  it("prefers a person's direct chat over groups containing the name, and finds a group by its plain name", () => {
    const chats = [chat("c-bday", "Jordan's birthday", { isGroup: true }), chat("c-jordan", "Jordan"), chat("c-design", "Design Team", { isGroup: true })];
    expect(resolve("Jordan", chats).chatId).toBe("c-jordan");
    expect(resolve("Design", chats).chatId).toBe("c-design");
  });
});

describe("resolveTaskLinks", () => {
  const chats = [chat("c-jordan", "Jordan"), chat("c-robin", "Robin"), chat("c-casey", "Casey")];

  it("resolves each name once, skips the own chat's duplicates and keeps at most three", () => {
    const links = resolveTaskLinks(["Jordan", "jordan", "Robin", "Casey", "Taylor", "Sam"], chats, { ownChatId: "c-casey", now: NOW });
    expect(links.map((link) => [link.name, link.chatId])).toEqual([
      ["Jordan", "c-jordan"],
      ["Robin", "c-robin"],
      ["Casey", null],
    ]);
  });

  it("drops blank names and a second name for an already linked chat", () => {
    const links = resolveTaskLinks(["  ", "@Jordan", "Jordan's"], chats, { ownChatId: null, now: NOW });
    expect(links).toEqual([{ name: "Jordan", chatId: "c-jordan", candidates: [], source: "ai" }]);
  });

  it("lists the chats of confirmed links", () => {
    expect(linkedChatIds(resolveTaskLinks(["Jordan", "Taylor"], chats, { ownChatId: null, now: NOW }))).toEqual(["c-jordan"]);
  });
});
