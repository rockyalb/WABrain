import {
  addOwnerFact,
  assertContextExists,
  deleteFact,
  deletePersonData,
  getChatRow,
  getMessagesAround,
  getMessageViews,
  getPerson,
  listChats,
  listPeople,
  purgeChatData,
  updateChat,
  updateFact,
  updatePerson,
} from "@wabrain/db";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { audit, notifySync } from "../http/audit.js";
import { HttpError } from "../http/errors.js";
import {
  ChatListQuerySchema,
  CreateFactRequestSchema,
  MessagesQuerySchema,
  PeopleQuerySchema,
  UpdateChatRequestSchema,
  UpdateFactRequestSchema,
  UpdatePersonRequestSchema,
} from "../http/schemas.js";
import { jsonBody, queryParams } from "../http/validate.js";

/** Chats (with their rules), conversation views, and people. */
export function chatRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { database } = deps;

  app.get("/chats", async (c) => c.json(await listChats(database.db, queryParams(c, ChatListQuerySchema))));

  app.get("/chats/:chatId/messages", async (c) => {
    const query = queryParams(c, MessagesQuerySchema);
    await getChatRow(database.db, c.req.param("chatId"));
    return c.json({ items: await getMessagesAround(database.db, c.req.param("chatId"), query) });
  });

  app.patch("/chats/:id", async (c) => {
    const patch = await jsonBody(c, UpdateChatRequestSchema);
    const id = c.req.param("id");
    const chat = await database.transaction(async ({ db }) => {
      const before = await getChatRow(db, id);
      await assertContextExists(db, patch.defaultContextId);
      const updated = await updateChat(db, id, patch);
      if (patch.mode === "off" && before.mode !== "off") await purgeChatData(db, id);
      await audit(deps, c, { action: "chat.rule_changed", targetType: "chat", targetId: id, details: { fields: Object.keys(patch), mode: patch.mode ?? null, purged: patch.mode === "off" } }, db);
      return updated;
    });
    await notifySync(deps);
    return c.json(chat);
  });

  app.delete("/chats/:id/data", async (c) => {
    const id = c.req.param("id");
    await database.transaction(async ({ db }) => {
      await purgeChatData(db, id);
      await audit(deps, c, { action: "chat.data_deleted", targetType: "chat", targetId: id }, db);
    });
    await notifySync(deps);
    return c.body(null, 204);
  });

  app.get("/people", async (c) => c.json(await listPeople(database.db, queryParams(c, PeopleQuerySchema))));

  app.get("/people/:id", async (c) => c.json(await getPerson(database.db, c.req.param("id"))));

  app.patch("/people/:id", async (c) => {
    const patch = await jsonBody(c, UpdatePersonRequestSchema);
    await assertContextExists(database.db, patch.defaultContextId);
    const person = await updatePerson(database.db, c.req.param("id"), patch);
    await notifySync(deps);
    return c.json(person);
  });

  /**
   * Every stored source message of one fact, each with its own chatId, so the
   * app opens each source in the chat it came from. Purged messages are omitted.
   */
  app.get("/people/:id/facts/:factId/sources", async (c) => {
    const person = await getPerson(database.db, c.req.param("id"));
    const fact = person.facts.find((candidate) => candidate.id === c.req.param("factId"));
    if (!fact) throw new HttpError("not_found", "Fact not found");
    return c.json({ items: await getMessageViews(database.db, fact.sourceMessageIds) });
  });

  app.post("/people/:id/facts", async (c) => {
    const body = await jsonBody(c, CreateFactRequestSchema);
    const fact = await addOwnerFact(database.db, c.req.param("id"), body);
    await notifySync(deps);
    return c.json(fact, 201);
  });

  app.patch("/people/:id/facts/:factId", async (c) => {
    const body = await jsonBody(c, UpdateFactRequestSchema);
    const fact = await updateFact(database.db, c.req.param("id"), c.req.param("factId"), body);
    await notifySync(deps);
    return c.json(fact);
  });

  app.delete("/people/:id/facts/:factId", async (c) => {
    await deleteFact(database.db, c.req.param("id"), c.req.param("factId"));
    await notifySync(deps);
    return c.body(null, 204);
  });

  app.delete("/people/:id/data", async (c) => {
    const id = c.req.param("id");
    await database.transaction(async ({ db }) => {
      const { chatIds } = await deletePersonData(db, id);
      await audit(deps, c, { action: "person.data_deleted", targetType: "person", targetId: id, details: { chats: chatIds.length } }, db);
    });
    await notifySync(deps);
    return c.body(null, 204);
  });

  return app;
}
