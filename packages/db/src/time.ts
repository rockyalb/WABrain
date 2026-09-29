/**
 * Timezone arithmetic without Temporal. Offsets come from Intl, and local
 * times are converted with Temporal's "compatible" disambiguation: a time in a
 * DST overlap resolves to the earlier instant, and a time in a DST gap shifts
 * forward by the gap length.
 */

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Wall-clock fields of an instant in a timezone. */
export function toLocal(instantMs: number, timeZone: string): LocalDateTime & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** Offset (local minus UTC) in milliseconds at an instant. */
export function offsetAt(instantMs: number, timeZone: string): number {
  const local = toLocal(instantMs, timeZone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** Converts a wall-clock time in `timeZone` to an instant. */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): Date {
  const localMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsetBefore = offsetAt(localMs - DAY_MS, timeZone);
  const offsetAfter = offsetAt(localMs + DAY_MS, timeZone);
  const candidates = [...new Set([offsetBefore, offsetAfter])]
    .map((offset) => localMs - offset)
    .filter((instant) => instant + offsetAt(instant, timeZone) === localMs)
    .sort((a, b) => a - b);
  // Overlap: earliest. Gap: no candidate matches; the pre-transition offset
  // lands the same distance after the gap.
  return new Date(candidates[0] ?? localMs - offsetBefore);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

/**
 * Resolves a date-only due ("YYYY-MM-DD") to `endOfWorkDay` ("HH:mm") on
 * that date in `timeZone`.
 */
export function resolveDateOnly(date: string, endOfWorkDay: string, timeZone: string): Date {
  const dateMatch = DATE_ONLY.exec(date);
  const timeMatch = LOCAL_TIME.exec(endOfWorkDay);
  if (!dateMatch || !timeMatch) throw new RangeError(`Invalid date-only due: ${date} / ${endOfWorkDay}`);
  const [year, month, day] = [Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return zonedTimeToUtc({ year, month, day, hour: Number(timeMatch[1]), minute: Number(timeMatch[2]) }, timeZone);
}
