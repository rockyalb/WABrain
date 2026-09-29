/**
 * The owner's phone contacts (saved names by jid) and how names are chosen from them: a saved name
 * wins, otherwise the name the person chose in WhatsApp is shown with a leading "~", as WhatsApp
 * does, so the two are never confused. Names the owner set in this app (`displayNameSource` "owner")
 * are never touched.
 */
import { inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { contactNames } from "../schema.js";

/** Marks a name the person chose for themselves in WhatsApp (not one the owner saved). */
export const UNSAVED_NAME_MARK = "~";

/** "~Ana" for a WhatsApp push name; null for no name. Already-marked names are kept as they are. */
export function unsavedName(name: string | null | undefined): string | null {
  const clean = name?.trim();
  if (!clean) return null;
  return clean.startsWith(UNSAVED_NAME_MARK) ? clean : `${UNSAVED_NAME_MARK}${clean}`;
}

/** Saved names for the given jids (absent when not saved). */
export async function savedContactNames(db: Db, jids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(jids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ jid: contactNames.jid, name: contactNames.name }).from(contactNames).where(inArray(contactNames.jid, unique));
  return new Map(rows.map((row) => [row.jid, row.name]));
}

export interface ContactBookChange {
  added: number;
  renamed: number;
  removed: number;
}

/**
 * Replaces the contact book with the phone's current contacts: new and renamed ones are written,
 * contacts no longer saved are removed. Blank names are ignored.
 */
export async function replaceContactNames(db: Db, contacts: ReadonlyArray<{ jid: string; name: string }>): Promise<ContactBookChange> {
  const byJid = new Map<string, string>();
  for (const contact of contacts) {
    const name = contact.name.trim();
    if (contact.jid && name) byJid.set(contact.jid, name);
  }
  const current = new Map((await db.select({ jid: contactNames.jid, name: contactNames.name }).from(contactNames)).map((row) => [row.jid, row.name]));
  const changes = [...byJid].filter(([jid, name]) => current.get(jid) !== name);
  const removed = [...current.keys()].filter((jid) => !byJid.has(jid));
  for (let i = 0; i < changes.length; i += 500) {
    await db
      .insert(contactNames)
      .values(changes.slice(i, i + 500).map(([jid, name]) => ({ jid, name })))
      .onConflictDoUpdate({ target: contactNames.jid, set: { name: sql`excluded.name`, syncedAt: sql`now()` } });
  }
  for (let i = 0; i < removed.length; i += 500) {
    await db.delete(contactNames).where(inArray(contactNames.jid, removed.slice(i, i + 500)));
  }
  const added = changes.filter(([jid]) => !current.has(jid)).length;
  return { added, renamed: changes.length - added, removed: removed.length };
}

/**
 * Applies the contact book to stored names: people (unless the owner named them), direct chats,
 * group participants and incoming messages' sender names take the saved name; names that are not
 * saved get the "~" mark. Phone-number labels ("+44…") are left alone. Returns the chats whose
 * messages changed, whose search windows need rebuilding.
 */
export async function applyContactNames(db: Db): Promise<{ people: number; chats: number; participants: number; messages: number; changedChatIds: string[] }> {
  const saved = sql`exists (select 1 from contact_names cn where cn.jid = `;
  const peopleSaved = await db.execute<{ id: string }>(sql`
    update people p set display_name = cn.name, updated_at = now()
    from contact_names cn
    where p.primary_jid = cn.jid and p.display_name_source = 'auto' and p.display_name is distinct from cn.name
    returning p.id`);
  const peopleUnsaved = await db.execute<{ id: string }>(sql`
    update people p set display_name = ${UNSAVED_NAME_MARK} || p.display_name, updated_at = now()
    where p.display_name_source = 'auto' and p.primary_jid is not null
      and p.display_name not like ${`${UNSAVED_NAME_MARK}%`} and p.display_name not like '+%'
      and not ${saved}p.primary_jid)
    returning p.id`);
  const chatsSaved = await db.execute<{ id: string }>(sql`
    update chats c set name = cn.name, updated_at = now()
    from contact_names cn
    where c.jid = cn.jid and not c.is_group and c.name is distinct from cn.name
    returning c.id`);
  const chatsUnsaved = await db.execute<{ id: string }>(sql`
    update chats c set name = ${UNSAVED_NAME_MARK} || c.name, updated_at = now()
    where not c.is_group and c.name is not null
      and c.name not like ${`${UNSAVED_NAME_MARK}%`} and c.name not like '+%'
      and not ${saved}c.jid)
    returning c.id`);
  const participantsSaved = await db.execute<{ id: string }>(sql`
    update participants pa set display_name = cn.name
    from contact_names cn
    where pa.jid = cn.jid and pa.display_name is distinct from cn.name
    returning pa.id`);
  const participantsUnsaved = await db.execute<{ id: string }>(sql`
    update participants pa set display_name = ${UNSAVED_NAME_MARK} || pa.display_name
    where pa.display_name is not null and pa.display_name not like ${`${UNSAVED_NAME_MARK}%`} and pa.display_name not like '+%'
      and not ${saved}pa.jid)
    returning pa.id`);
  const messagesSaved = await db.execute<{ chat_id: string }>(sql`
    update messages m set sender_name = cn.name
    from contact_names cn
    where m.sender_jid = cn.jid and m.direction = 'incoming' and m.sender_name is distinct from cn.name
    returning m.chat_id`);
  const messagesUnsaved = await db.execute<{ chat_id: string }>(sql`
    update messages m set sender_name = ${UNSAVED_NAME_MARK} || m.sender_name
    where m.direction = 'incoming' and m.sender_name is not null
      and m.sender_name not like ${`${UNSAVED_NAME_MARK}%`} and m.sender_name not like '+%'
      and not ${saved}m.sender_jid)
    returning m.chat_id`);
  const messageRows = [...messagesSaved, ...messagesUnsaved];
  return {
    people: peopleSaved.length + peopleUnsaved.length,
    chats: chatsSaved.length + chatsUnsaved.length,
    participants: participantsSaved.length + participantsUnsaved.length,
    messages: messageRows.length,
    changedChatIds: [...new Set(messageRows.map((row) => row.chat_id))],
  };
}
