import type { Person, PersonFact, PersonFactKey } from "@wabrain/contracts";
import { and, asc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.js";
import { notFound } from "../errors.js";
import { newId } from "../ids.js";
import { toPerson, toPersonFact, type PersonRow } from "../mappers.js";
import { clampLimit, decodeCursor, toPage, type Page, type PageRequest } from "../pagination.js";
import { chats, people, personFacts } from "../schema.js";
import { likePattern, purgeChatData } from "./chats.js";

export async function withFacts(db: Db, rows: PersonRow[]): Promise<Person[]> {
  if (!rows.length) return [];
  const facts = await db
    .select()
    .from(personFacts)
    .where(
      inArray(
        personFacts.personId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(personFacts.key), asc(personFacts.createdAt));
  return rows.map((row) =>
    toPerson(
      row,
      facts.filter((fact) => fact.personId === row.id),
    ),
  );
}

export async function listPeople(db: Db, filter: { q?: string | null } & PageRequest = {}): Promise<Page<Person>> {
  const limit = clampLimit(filter.limit);
  const where: SQL[] = [];
  if (filter.q) where.push(ilike(people.displayName, likePattern(filter.q)));
  if (filter.cursor) {
    const [name, id] = decodeCursor(filter.cursor, 2);
    where.push(sql`(${people.displayName}, ${people.id}) > (${String(name)}, ${String(id)})`);
  }
  const rows = await db
    .select()
    .from(people)
    .where(and(...where))
    .orderBy(asc(people.displayName), asc(people.id))
    .limit(limit + 1);
  const page = toPage(rows, limit, (row) => row, (row) => [row.displayName, row.id]);
  return { items: await withFacts(db, page.items), nextCursor: page.nextCursor };
}

export async function getPersonRow(db: Db, id: string): Promise<PersonRow> {
  const [row] = await db.select().from(people).where(eq(people.id, id));
  if (!row) throw notFound("Person");
  return row;
}

export async function getPerson(db: Db, id: string): Promise<Person> {
  const [person] = await withFacts(db, [await getPersonRow(db, id)]);
  return person!;
}

export async function updatePerson(
  db: Db,
  id: string,
  patch: { displayName?: string; defaultContextId?: string | null },
): Promise<Person> {
  const [row] = await db
    .update(people)
    .set({
      ...patch,
      ...(patch.displayName !== undefined ? { displayNameSource: "owner" as const } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(people.id, id))
    .returning();
  if (!row) throw notFound("Person");
  return getPerson(db, id);
}

/** Owner-entered fact: verified, confidence 1. */
export async function addOwnerFact(db: Db, personId: string, input: { key: PersonFactKey; value: string }): Promise<PersonFact> {
  await getPersonRow(db, personId);
  const [row] = await db
    .insert(personFacts)
    .values({
      id: newId(),
      personId,
      key: input.key,
      value: input.value,
      confidence: 1,
      verified: true,
      selfClaimed: false,
      source: "owner",
    })
    .returning();
  return toPersonFact(row!);
}

export async function updateFact(
  db: Db,
  personId: string,
  factId: string,
  patch: { value?: string; verified?: boolean },
): Promise<PersonFact> {
  const [row] = await db
    .update(personFacts)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(personFacts.id, factId), eq(personFacts.personId, personId)))
    .returning();
  if (!row) throw notFound("Fact");
  return toPersonFact(row);
}

export async function deleteFact(db: Db, personId: string, factId: string): Promise<void> {
  const deleted = await db
    .delete(personFacts)
    .where(and(eq(personFacts.id, factId), eq(personFacts.personId, personId)))
    .returning({ id: personFacts.id });
  if (!deleted.length) throw notFound("Fact");
}

/** Deletes the person's profile and the data of every chat that belongs to them. */
export async function deletePersonData(db: Db, personId: string): Promise<{ chatIds: string[] }> {
  await getPersonRow(db, personId);
  const owned = await db.select({ id: chats.id }).from(chats).where(eq(chats.personId, personId));
  for (const chat of owned) await purgeChatData(db, chat.id);
  await db.delete(people).where(eq(people.id, personId));
  return { chatIds: owned.map((chat) => chat.id) };
}
