import type { Settings } from "@wabrain/contracts";
import { isValidDate, isValidTime, toZonedIso, zonedTimeToInstant } from "./time.js";

/** The due expression the model returns: a local calendar date and an optional local time. Never an instant. */
export interface ModelDue {
  date: string;
  time: string | null;
}

export interface ResolvedDue {
  /** ISO 8601 instant with the local offset. */
  dueAt: string;
  dueHasTime: boolean;
}

/**
 * Deterministically turns the model's local due into an instant:
 * date only → settings.endOfWorkDay in settings.timezone (dueHasTime false);
 * date + time → that local time (dueHasTime true). Returns null for an invalid date or time.
 */
export function resolveDue(due: ModelDue, settings: Pick<Settings, "timezone" | "endOfWorkDay">): ResolvedDue | null {
  if (!isValidDate(due.date)) return null;
  const hasTime = due.time !== null;
  const time = due.time ?? settings.endOfWorkDay;
  if (!isValidTime(time)) return null;
  const instant = zonedTimeToInstant(due.date, time, settings.timezone);
  return { dueAt: toZonedIso(instant, settings.timezone), dueHasTime: hasTime };
}
