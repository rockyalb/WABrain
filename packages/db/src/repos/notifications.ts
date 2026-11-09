/**
 * Durable notifications (Review items, reminders, daily summaries).
 *
 * The producing operation writes a `notification_events` row and one `notification_deliveries`
 * row per active device in its own transaction, so a notification exists exactly when its cause
 * committed. Two transports then read the same rows, keyed by the event id (`notificationId`):
 *
 * - push: `claimNotificationDeliveries` leases due deliveries (FOR UPDATE SKIP LOCKED plus a lease
 *   time, so the API and worker processes never send the same one concurrently), and
 *   `finishNotificationDelivery` records success or schedules a retry with exponential backoff;
 * - polling: the device's fallback sync lists its unacknowledged events and acknowledges them.
 *
 * A pushed event stays listed until the device acknowledges it; the device deduplicates by id.
 * Events whose cause is gone (a decided Review item, a closed or rescheduled task) or that expired
 * are neither pushed nor listed.
 */
import type { ReviewItemType } from "@wabrain/contracts";
import { and, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { chats, devices, notificationDeliveries, notificationEvents, people, reviewItems } from "../schema.js";

export type NotificationPayload =
  | { type: "review"; reviewItemId: string; reviewType: ReviewItemType; title: string; from?: string; handled?: "done" | "cancelled" }
  | { type: "handled"; taskId: string; title: string; status: "done" | "cancelled"; from?: string }
  | { type: "reminder"; taskId: string; title: string; dueAt: string }
  | { type: "summary"; open: number; dueToday: number; overdue: number; review: number };

/** A payload as sent to a device: always carries the durable event id. */
export type DeliveredNotificationPayload = NotificationPayload & { notificationId: string };

export interface EnqueueNotificationInput {
  /** Stable identity of the notification: a second enqueue with the same key is a no-op. */
  key: string;
  payload: NotificationPayload;
  at: Date;
  expiresAt: Date;
  taskId?: string | null;
  reviewItemId?: string | null;
}

export const REVIEW_NOTIFICATION_TTL_MS = 30 * 86_400_000;
/** How long a claimed delivery is reserved for its sender before another process may retry it. */
export const NOTIFICATION_LEASE_MS = 5 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/** Delay before the next push attempt after `attempts` failed ones (30 s, 1 min, 2 min, … 10 min). */
export function notificationRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempts - 1, 10)));
}

/**
 * Records a notification for every active device. Call it in the same transaction as the operation
 * producing the notification. Returns the event id (the existing one when the key was seen).
 */
export async function enqueueNotification(db: Db, input: EnqueueNotificationInput): Promise<string> {
  const [inserted] = await db
    .insert(notificationEvents)
    .values({
      id: newId(),
      dedupKey: input.key,
      payload: input.payload,
      taskId: input.taskId ?? null,
      reviewItemId: input.reviewItemId ?? null,
      createdAt: input.at,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: notificationEvents.dedupKey })
    .returning({ id: notificationEvents.id });
  if (!inserted) {
    const [existing] = await db
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.dedupKey, input.key));
    return existing!.id;
  }
  const recipients = await db.select({ id: devices.id }).from(devices).where(and(
    isNull(devices.revokedAt),
    sql`(${devices.id} not like 'web:%' or exists (select 1 from owner_sessions s where s.token_hash = substring(${devices.id} from 5) and s.expires_at > ${input.at.toISOString()}::timestamptz))`,
  ));
  if (recipients.length) {
    await db
      .insert(notificationDeliveries)
      .values(recipients.map(({ id }) => ({ eventId: inserted.id, deviceId: id, nextAttemptAt: input.at })))
      .onConflictDoNothing();
  }
  return inserted.id;
}

/**
 * The notification for a new or changed Review item. The key includes the item's `createdAt`, which
 * changes when a pending proposal is replaced, and whether a later message showed the create already
 * handled, so either change notifies again and the previous event is withdrawn. Devices show one
 * notification per Review item, so the new one replaces the old.
 */
export async function enqueueReviewNotification(
  db: Db,
  item: {
    id: string;
    type: ReviewItemType;
    title: string;
    taskId: string | null;
    createdAt: Date | string;
    needsPick?: boolean;
    /** A create that looks already handled: the notification offers "Save as done" and Discard. */
    handled?: "done" | "cancelled" | null;
    /** When it is announced, if later than createdAt (a handled hint learned afterwards). */
    at?: Date;
  },
): Promise<string> {
  const created = new Date(item.createdAt);
  const key = `review:${item.id}:${created.toISOString()}${item.handled ? `:${item.handled}` : ""}`;
  const at = item.at ?? created;
  const from = await reviewOrigin(db, item.id);
  await db
    .delete(notificationEvents)
    .where(and(eq(notificationEvents.reviewItemId, item.id), ne(notificationEvents.dedupKey, key)));
  return enqueueNotification(db, {
    key,
    at,
    expiresAt: new Date(at.getTime() + REVIEW_NOTIFICATION_TTL_MS),
    reviewItemId: item.id,
    taskId: item.taskId,
    payload: {
      type: "review",
      reviewItemId: item.id,
      reviewType: item.type,
      title: item.title,
      ...(from ? { from } : {}),
      ...(item.needsPick ? { needsPick: true } : {}),
      ...(item.handled ? { handled: item.handled } : {}),
    },
  });
}

/**
 * "Saved as done": a create the analysis applied straight into Done or Cancelled because the same
 * burst showed it handled. Informational; it stays listed only while the task keeps that status.
 */
export async function enqueueHandledNotification(
  db: Db,
  task: { taskId: string; title: string; status: "done" | "cancelled"; chatId: string | null; personId: string | null; at: Date },
): Promise<string> {
  const from = await chatOrigin(db, task.chatId, task.personId);
  return enqueueNotification(db, {
    key: `handled:${task.taskId}`,
    at: task.at,
    expiresAt: new Date(task.at.getTime() + HANDLED_NOTIFICATION_TTL_MS),
    taskId: task.taskId,
    payload: { type: "handled", taskId: task.taskId, title: task.title, status: task.status, ...(from ? { from } : {}) },
  });
}

const HANDLED_NOTIFICATION_TTL_MS = 86_400_000;

const MAX_FROM_CHARS = 80;

/**
 * Who a Review item came from, for the notification: the person, "Person · Group" for a group chat,
 * or the chat's name when no person is known. Null when the item has neither (e.g. a merge).
 */
async function reviewOrigin(db: Db, reviewItemId: string): Promise<string | null> {
  const [row] = await db
    .select({ chatId: reviewItems.chatId, personId: reviewItems.personId })
    .from(reviewItems)
    .where(eq(reviewItems.id, reviewItemId));
  return row ? chatOrigin(db, row.chatId, row.personId) : null;
}

/** The same "Person · Group" label for a chat and person. */
async function chatOrigin(db: Db, chatId: string | null, personId: string | null): Promise<string | null> {
  const [chatRow] = chatId ? await db.select({ name: chats.name, isGroup: chats.isGroup }).from(chats).where(eq(chats.id, chatId)) : [];
  const [personRow] = personId ? await db.select({ name: people.displayName }).from(people).where(eq(people.id, personId)) : [];
  const person = personRow?.name?.trim() || null;
  const chat = chatRow?.name?.trim() || null;
  const from = chatRow?.isGroup && person && chat ? `${person} · ${chat}` : (person ?? chat);
  return from ? from.slice(0, MAX_FROM_CHARS) : null;
}

/**
 * Events still worth showing: unexpired, Review item still pending, reminder's task open with that due
 * value, "saved as done" task still closed that way.
 */
const activeEvent = (now: Date) => sql`e.expires_at > ${now.toISOString()}::timestamptz
  and (e.review_item_id is null
    or exists (select 1 from review_items r where r.id = e.review_item_id and r.state = 'pending'))
  and (e.payload->>'type' <> 'reminder'
    or exists (select 1 from tasks t where t.id = e.task_id and t.status = 'open'
      and t.due_at = (e.payload->>'dueAt')::timestamptz))
  and (e.payload->>'type' <> 'handled'
    or exists (select 1 from tasks t where t.id = e.task_id and t.status = e.payload->>'status'))`;

const withId = (payload: NotificationPayload, id: string): DeliveredNotificationPayload => ({ ...payload, notificationId: id });

export interface DeviceNotification {
  id: string;
  createdAt: string;
  payload: DeliveredNotificationPayload;
}

/** The device's unacknowledged, still-active notifications, oldest first (at most 100). */
export async function listDeviceNotifications(db: Db, deviceId: string, now = new Date()): Promise<DeviceNotification[]> {
  const rows = await db.execute<{ id: string; created_at: Date | string; payload: NotificationPayload }>(sql`
    select e.id, e.created_at, e.payload
    from notification_events e
    join notification_deliveries d on d.event_id = e.id
    where d.device_id = ${deviceId} and d.acknowledged_at is null and ${activeEvent(now)}
    order by e.created_at, e.id
    limit 100`);
  return rows.map((row) => ({
    id: row.id,
    createdAt: new Date(row.created_at).toISOString(),
    payload: withId(row.payload, row.id),
  }));
}

/** Marks the device's deliveries as handled: they are no longer listed or pushed. Unknown ids are ignored. */
export async function acknowledgeNotifications(db: Db, deviceId: string, ids: string[], now = new Date()): Promise<void> {
  if (!ids.length) return;
  await db
    .update(notificationDeliveries)
    .set({ acknowledgedAt: now })
    .where(
      and(
        eq(notificationDeliveries.deviceId, deviceId),
        inArray(notificationDeliveries.eventId, [...new Set(ids)]),
        isNull(notificationDeliveries.acknowledgedAt),
      ),
    );
}

export interface ClaimedDelivery {
  eventId: string;
  deviceId: string;
  /** Push attempts including this one. */
  attempts: number;
  payload: DeliveredNotificationPayload;
}

/**
 * Leases a bounded batch of due push deliveries: not yet pushed or acknowledged, for an active
 * device that has a push endpoint, of a still-active event. Concurrent callers get disjoint rows.
 */
export async function claimNotificationDeliveries(
  db: Db,
  now = new Date(),
  options: { limit?: number; leaseMs?: number } = {},
): Promise<ClaimedDelivery[]> {
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? NOTIFICATION_LEASE_MS));
  const rows = await db.execute<{ event_id: string; device_id: string; attempts: number; payload: NotificationPayload }>(sql`
    with due as (
      select d.event_id, d.device_id
      from notification_deliveries d
      join notification_events e on e.id = d.event_id
      join devices dv on dv.id = d.device_id
      where d.pushed_at is null and d.acknowledged_at is null and dv.revoked_at is null
        and (dv.id not like 'web:%' or exists (select 1 from owner_sessions s where s.token_hash = substring(dv.id from 5) and s.expires_at > ${now.toISOString()}::timestamptz))
        and exists (select 1 from push_endpoints p where p.device_id = d.device_id)
        and d.next_attempt_at <= ${now.toISOString()}::timestamptz
        and ${activeEvent(now)}
      order by d.next_attempt_at, d.event_id
      limit ${options.limit ?? 50}
      for update of d skip locked
    ), leased as (
      update notification_deliveries d
      set next_attempt_at = ${leaseUntil.toISOString()}::timestamptz, attempts = d.attempts + 1
      from due
      where d.event_id = due.event_id and d.device_id = due.device_id
      returning d.event_id, d.device_id, d.attempts
    )
    select l.event_id, l.device_id, l.attempts, e.payload
    from leased l join notification_events e on e.id = l.event_id`);
  return rows.map((row) => ({
    eventId: row.event_id,
    deviceId: row.device_id,
    attempts: Number(row.attempts),
    payload: withId(row.payload, row.event_id),
  }));
}

/** Records a push outcome: `pushed` only after the push service accepted it; otherwise retry later. */
export async function finishNotificationDelivery(
  db: Db,
  delivery: Pick<ClaimedDelivery, "eventId" | "deviceId" | "attempts">,
  pushed: boolean,
  now = new Date(),
): Promise<void> {
  await db
    .update(notificationDeliveries)
    .set(pushed ? { pushedAt: now } : { nextAttemptAt: new Date(now.getTime() + notificationRetryDelayMs(delivery.attempts)) })
    .where(and(eq(notificationDeliveries.eventId, delivery.eventId), eq(notificationDeliveries.deviceId, delivery.deviceId)));
}

/** Deletes expired events (and, by cascade, their deliveries). */
export async function pruneNotifications(db: Db, now = new Date()): Promise<void> {
  await db.delete(notificationEvents).where(lte(notificationEvents.expiresAt, now));
}
