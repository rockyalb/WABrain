/**
 * Delta sync. Cursors are sync_version high-water marks. Writers hold a
 * shared advisory lock while they own unpublished versions (see the trigger
 * migration); taking the exclusive lock here waits for them, so every version
 * at or below the returned mark is committed and no change can be skipped.
 */
import type { Chat, Context, Person, ReviewItem, Settings, Task } from "@wabrain/contracts";
import { and, eq, gt, gte, or } from "drizzle-orm";
import type { Database } from "../client.js";
import { invalid } from "../errors.js";
import { toChat, toContext, toReviewItem, toTask } from "../mappers.js";
import { chats, contexts, people, reviewItems, syncTombstones, tasks } from "../schema.js";
import { withFacts } from "./people.js";
import { getSettings } from "./settings.js";

export const SYNC_LOCK = 727001;
export const CLOSED_TASK_WINDOW_MS = 7 * 86_400_000;

export interface SyncDeleted {
  tasks: string[];
  reviewItems: string[];
  contexts: string[];
  chats: string[];
  people: string[];
}

export interface SyncResult {
  cursor: string;
  full: boolean;
  tasks: Task[];
  reviewItems: ReviewItem[];
  contexts: Context[];
  chats: Chat[];
  people: Person[];
  settings: Settings;
  deleted: SyncDeleted;
}

export function encodeSyncCursor(version: number): string {
  return Buffer.from(`v1:${version}`).toString("base64url");
}

export function decodeSyncCursor(cursor: string): number {
  const match = /^v1:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw invalid("Invalid sync cursor");
  return Number(match[1]);
}

/** Highest version below which every write has committed, plus the wipe watermark. */
async function highWaterMark(database: Database): Promise<{ high: number; reset: number }> {
  return database.transaction(async ({ sql }) => {
    await sql`select pg_advisory_xact_lock(${SYNC_LOCK})`;
    const [seq] = await sql<{ last_value: string; is_called: boolean }[]>`select last_value, is_called from sync_version_seq`;
    const [settingsRow] = await sql<{ sync_reset_version: string }[]>`select sync_reset_version from settings where id = 1`;
    return {
      high: seq?.is_called ? Number(seq.last_value) : 0,
      reset: Number(settingsRow?.sync_reset_version ?? 0),
    };
  });
}

export async function readSync(database: Database, since: string | null | undefined, now = new Date()): Promise<SyncResult> {
  const sinceVersion = since ? decodeSyncCursor(since) : null;
  const { high, reset } = await highWaterMark(database);
  const full = sinceVersion === null || sinceVersion < reset || sinceVersion > high;
  const { db } = database;
  const settings = await getSettings(db);
  const deleted: SyncDeleted = { tasks: [], reviewItems: [], contexts: [], chats: [], people: [] };

  if (full) {
    const closedSince = new Date(now.getTime() - CLOSED_TASK_WINDOW_MS);
    const [taskRows, reviewRows, contextRows, chatRows, personRows] = await Promise.all([
      db.select().from(tasks).where(or(eq(tasks.status, "open"), gte(tasks.closedAt, closedSince))),
      db.select().from(reviewItems).where(eq(reviewItems.state, "pending")),
      db.select().from(contexts),
      db.select().from(chats),
      db.select().from(people),
    ]);
    return {
      cursor: encodeSyncCursor(high),
      full: true,
      tasks: taskRows.map(toTask),
      reviewItems: reviewRows.map(toReviewItem),
      contexts: contextRows.map(toContext),
      chats: chatRows.map(toChat),
      people: await withFacts(db, personRows),
      settings,
      deleted,
    };
  }

  const after = sinceVersion!;
  const [taskRows, reviewRows, contextRows, chatRows, personRows, tombstones] = await Promise.all([
    db.select().from(tasks).where(gt(tasks.syncVersion, after)),
    db.select().from(reviewItems).where(gt(reviewItems.syncVersion, after)),
    db.select().from(contexts).where(gt(contexts.syncVersion, after)),
    db.select().from(chats).where(gt(chats.syncVersion, after)),
    db.select().from(people).where(gt(people.syncVersion, after)),
    db.select().from(syncTombstones).where(and(gt(syncTombstones.syncVersion, after))),
  ]);
  for (const tombstone of tombstones) deleted[tombstone.entity].push(tombstone.entityId);
  // Decided review items leave the client's pending list.
  deleted.reviewItems.push(...reviewRows.filter((row) => row.state !== "pending").map((row) => row.id));
  return {
    cursor: encodeSyncCursor(high),
    full: false,
    tasks: taskRows.map(toTask),
    reviewItems: reviewRows.filter((row) => row.state === "pending").map(toReviewItem),
    contexts: contextRows.map(toContext),
    chats: chatRows.map(toChat),
    people: await withFacts(db, personRows),
    settings,
    deleted: {
      tasks: [...new Set(deleted.tasks)],
      reviewItems: [...new Set(deleted.reviewItems)],
      contexts: [...new Set(deleted.contexts)],
      chats: [...new Set(deleted.chats)],
      people: [...new Set(deleted.people)],
    },
  };
}
