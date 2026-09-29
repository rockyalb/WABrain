/**
 * Timezone helpers built on Intl only (no dependencies). They convert between absolute instants and
 * wall-clock dates in an IANA timezone, DST-correct.
 */

export interface LocalDateTime {
  /** "YYYY-MM-DD" */
  date: string;
  /** "HH:mm" */
  time: string;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

function wallClockParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Offset of the timezone from UTC at the given instant, in minutes (Europe/Rome: +60 or +120). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const p = wallClockParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

export function toLocal(instant: Date, timeZone: string): LocalDateTime {
  const p = wallClockParts(instant, timeZone);
  return {
    date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(),
  };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a real calendar date in "YYYY-MM-DD" form (rejects 2026-02-30). */
export function isValidDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

/** Calendar arithmetic on "YYYY-MM-DD" strings. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function weekdayOf(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function lastDayOfMonth(date: string): string {
  const [year, month] = date.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0));
  return `${pad(year, 4)}-${pad(month)}-${pad(last.getUTCDate())}`;
}

/**
 * The instant at which the wall clock in `timeZone` shows `date` `time`.
 * A time inside a spring-forward gap resolves to the same wall time shifted by the gap (02:30 → 03:30);
 * an ambiguous fall-back time resolves to the earlier instant.
 */
export function zonedTimeToInstant(date: string, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Try the offsets in effect a day before and a day after; one of them is right for any real zone.
  const candidates = [
    offsetMinutes(new Date(wallAsUtc - 86_400_000), timeZone),
    offsetMinutes(new Date(wallAsUtc + 86_400_000), timeZone),
  ].sort((a, b) => b - a);
  for (const offset of candidates) {
    const instant = new Date(wallAsUtc - offset * 60_000);
    const local = toLocal(instant, timeZone);
    if (local.date === date && local.time === time) return instant;
  }
  // Spring-forward gap: no instant shows this wall time. Use the pre-transition offset, which lands after the gap.
  return new Date(wallAsUtc - Math.min(...candidates) * 60_000);
}

/** ISO 8601 with the zone's local offset, e.g. "2026-09-24T17:00:00+02:00". */
export function toZonedIso(instant: Date, timeZone: string): string {
  const local = toLocal(instant, timeZone);
  const offset = offsetMinutes(instant, timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const seconds = pad(wallClockParts(instant, timeZone).second);
  return `${local.date}T${local.time}:${seconds}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
