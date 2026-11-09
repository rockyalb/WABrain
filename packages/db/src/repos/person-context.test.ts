import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chats, people } from "../schema.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { updateChat } from "./chats.js";
import { deleteContext, listContexts } from "./contexts.js";
import { updatePerson } from "./people.js";
import { suggestPersonDefaultContext } from "./pipeline.js";
import { readSync } from "./sync.js";

let testDb: TestDatabase;
let personal: string;
let work: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const contexts = await listContexts(testDb.database.db);
  personal = contexts.find((context) => context.name === "Personal")!.id;
  work = contexts.find((context) => context.name === "Work")!.id;
});
afterAll(async () => {
  await testDb.drop();
});

async function seed(id: string, personContext: string | null = null) {
  const { db } = testDb.database;
  await db.insert(people).values({ id: `p-${id}`, displayName: id, defaultContextId: personContext });
  await db.insert(chats).values({ id: `c-${id}`, jid: `${id}@s.whatsapp.net`, isGroup: false, mode: "on", personId: `p-${id}` });
  await db.insert(chats).values({ id: `g-${id}`, jid: `${id}@g.us`, isGroup: true, mode: "mentions_only", defaultContextId: work, contextConfirmed: true });
}

async function chat(id: string) {
  const [row] = await testDb.database.db.select().from(chats).where(eq(chats.id, id));
  return row!;
}

async function person(id: string) {
  const [row] = await testDb.database.db.select().from(people).where(eq(people.id, id));
  return row!;
}

describe("a direct chat's context belongs to its person", () => {
  it("a new direct chat takes the person's context", async () => {
    await seed("mira", personal);
    expect(await chat("c-mira")).toMatchObject({ defaultContextId: personal, contextConfirmed: true });
  });

  it("changing the person's context changes their direct chat, not groups, and syncs the chat", async () => {
    await seed("sam");
    const before = await readSync(testDb.database, null);
    await updatePerson(testDb.database.db, "p-sam", { defaultContextId: personal });
    expect(await chat("c-sam")).toMatchObject({ defaultContextId: personal, contextConfirmed: true });
    expect(await chat("g-sam")).toMatchObject({ defaultContextId: work });
    const delta = await readSync(testDb.database, before.cursor);
    expect(delta.chats.find((item) => item.id === "c-sam")?.defaultContextId).toBe(personal);
    expect(delta.people.find((item) => item.id === "p-sam")).toMatchObject({ defaultContextId: personal, contextConfirmed: true });
  });

  it("setting a direct chat's context sets the person's; a group keeps its own", async () => {
    await seed("ana", personal);
    const updated = await updateChat(testDb.database.db, "c-ana", { defaultContextId: work, contextConfirmed: true, mode: "off" });
    expect(updated).toMatchObject({ defaultContextId: work, contextConfirmed: true, mode: "off" });
    expect(await person("p-ana")).toMatchObject({ defaultContextId: work, contextConfirmed: true });

    const group = await updateChat(testDb.database.db, "g-ana", { defaultContextId: personal });
    expect(group.defaultContextId).toBe(personal);
    expect(await person("p-ana")).toMatchObject({ defaultContextId: work });
  });

  it("confirming a direct chat's suggested context confirms the person's", async () => {
    await seed("erion");
    expect(await suggestPersonDefaultContext(testDb.database.db, "p-erion", work)).toBe(true);
    expect(await chat("c-erion")).toMatchObject({ defaultContextId: work, contextConfirmed: false });
    await updateChat(testDb.database.db, "c-erion", { contextConfirmed: true });
    expect(await person("p-erion")).toMatchObject({ defaultContextId: work, contextConfirmed: true });
    expect(await chat("c-erion")).toMatchObject({ contextConfirmed: true });
  });

  it("a suggestion never replaces the person's context", async () => {
    await seed("jordan", personal);
    expect(await suggestPersonDefaultContext(testDb.database.db, "p-jordan", work)).toBe(false);
    expect(await person("p-jordan")).toMatchObject({ defaultContextId: personal, contextConfirmed: true });
  });

  it("a direct write to a direct chat's context cannot diverge from the person", async () => {
    await seed("casey", personal);
    await testDb.database.sql`update chats set default_context_id = ${work} where id = 'c-casey'`;
    expect((await chat("c-casey")).defaultContextId).toBe(personal);
  });

  it("deleting a context with a replacement moves the person and their chat together", async () => {
    const { db } = testDb.database;
    await seed("dita", work);
    await deleteContext(db, work, personal);
    expect(await person("p-dita")).toMatchObject({ defaultContextId: personal });
    expect(await chat("c-dita")).toMatchObject({ defaultContextId: personal });
    expect(await chat("g-dita")).toMatchObject({ defaultContextId: personal });
  });
});
