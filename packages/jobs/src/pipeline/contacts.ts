/**
 * Saved contact names: copies the owner's phone contacts from OpenWA and applies them to people,
 * direct chats, group participants and incoming messages' sender names (packages/db
 * contact-names). Chats whose sender names changed get their search windows rebuilt.
 */
import { applyContactNames, latestSourceSessionId, replaceContactNames } from "@wabrain/db";
import type { PipelineDeps } from "./deps.js";

export type ContactSyncOutcome =
  | { status: "skipped"; reason: "openwa_not_configured" | "no_session" | "no_contacts" }
  | { status: "done"; contacts: number; people: number; chats: number; messages: number };

export async function syncContacts(
  deps: Pick<PipelineDeps, "database" | "queue" | "contacts" | "notifier" | "logger">,
  sessionId?: string,
): Promise<ContactSyncOutcome> {
  if (!deps.contacts) return { status: "skipped", reason: "openwa_not_configured" };
  const session = sessionId ?? (await latestSourceSessionId(deps.database.db));
  if (!session) return { status: "skipped", reason: "no_session" };
  const contacts = await deps.contacts.listSavedContacts(session);
  // No contacts at all is far more likely a session still loading than a phone without contacts:
  // keep the book instead of marking every saved name as unsaved.
  if (contacts.length === 0) return { status: "skipped", reason: "no_contacts" };
  const { book, applied } = await deps.database.transaction(async ({ db }) => ({
    book: await replaceContactNames(db, contacts),
    applied: await applyContactNames(db),
  }));
  for (const chatId of applied.changedChatIds) await deps.queue.enqueue("embed-chat", { chatId }, { singletonKey: chatId });
  if (applied.people + applied.chats > 0) await deps.notifier.notify({ type: "sync" });
  deps.logger.info("contacts synced", { contacts: contacts.length, ...book, people: applied.people, chats: applied.chats, messages: applied.messages });
  return { status: "done", contacts: contacts.length, people: applied.people, chats: applied.chats, messages: applied.messages };
}
