/**
 * notify-tick (every minute): due-date reminders, the daily summary, and the durable push retry.
 *
 * - Reminder: for each open task with a due date, once when now ≥ dueAt − reminderLeadMinutes. The
 *   claim key is (task, due value), so rescheduling re-arms the reminder. Tasks due longer ago than
 *   the grace window (worker downtime) are not reminded. Respects settings.remindersEnabled.
 * - Summary: once per local date, at or after settings.dailySummaryTime in settings.timezone (within a
 *   catch-up window), with counts {open, dueToday, overdue, review}.
 *
 * The claim and the durable notification are written in one transaction, so a claimed reminder or
 * summary is never lost: pushing it happens afterwards (`push.flushPending`), is recorded per device
 * only on success, and is retried by every later tick until it succeeds or expires. The same flush
 * retries Review item notifications whose immediate push failed.
 */
import { claimNotification, enqueueNotification, getSettings, listTasksDueForReminder, taskSummaryCounts } from "@wabrain/db";
import type { PipelineDeps } from "./deps.js";
import { localDay, minutesOf } from "./time.js";

export interface NotificationTickResult {
  reminders: number;
  summary: boolean;
}

const REMINDER_TTL_MS = 86_400_000;
const SUMMARY_TTL_MS = 12 * 3_600_000;

export async function runNotificationTick(
  deps: Pick<PipelineDeps, "database" | "push" | "logger" | "config">,
  now: Date,
): Promise<NotificationTickResult> {
  try {
    return await queueScheduledNotifications(deps, now);
  } finally {
    await deps.push.flushPending(now);
  }
}

async function queueScheduledNotifications(
  deps: Pick<PipelineDeps, "database" | "logger" | "config">,
  now: Date,
): Promise<NotificationTickResult> {
  const db = deps.database.db;
  const settings = await getSettings(db);
  let reminders = 0;

  if (settings.remindersEnabled) {
    const due = await listTasksDueForReminder(db, {
      now,
      leadMinutes: settings.reminderLeadMinutes,
      graceMs: deps.config.reminderGraceMs,
    });
    for (const task of due) {
      const dueAt = task.dueAt!.toISOString();
      const key = `${task.id}:${dueAt}`;
      const queued = await deps.database.transaction(async ({ db: tx }) => {
        if (!(await claimNotification(tx, "reminder", key, now))) return false;
        await enqueueNotification(tx, {
          key: `reminder:${key}`,
          payload: { type: "reminder", taskId: task.id, title: task.title, dueAt },
          at: now,
          taskId: task.id,
          expiresAt: new Date(now.getTime() + REMINDER_TTL_MS),
        });
        return true;
      });
      if (queued) reminders += 1;
    }
  }

  let summary = false;
  if (settings.dailySummaryTime) {
    const day = localDay(now, settings.timezone);
    const at = minutesOf(settings.dailySummaryTime);
    const windowMinutes = Math.max(1, Math.round(deps.config.summaryWindowMs / 60_000));
    if (day.minutes >= at && day.minutes < at + windowMinutes) {
      summary = await deps.database.transaction(async ({ db: tx }) => {
        if (!(await claimNotification(tx, "summary", day.date, now))) return false;
        const counts = await taskSummaryCounts(tx, { now, dayEnd: day.end });
        await enqueueNotification(tx, {
          key: `summary:${day.date}`,
          payload: { type: "summary", ...counts },
          at: now,
          expiresAt: new Date(now.getTime() + SUMMARY_TTL_MS),
        });
        return true;
      });
    }
  }
  if (reminders || summary) deps.logger.info("scheduled notifications queued", { reminders, summary });
  return { reminders, summary };
}
