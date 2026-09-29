import { toLocal, zonedTimeToUtc } from "@wabrain/db";

export interface LocalDay {
  /** "YYYY-MM-DD" in the timezone. */
  date: string;
  /** Minutes since local midnight. */
  minutes: number;
  start: Date;
  end: Date;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The local calendar day containing `now` in `timeZone`, with its UTC bounds. */
export function localDay(now: Date, timeZone: string): LocalDay {
  const local = toLocal(now.getTime(), timeZone);
  const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  return {
    date: `${local.year}-${pad(local.month)}-${pad(local.day)}`,
    minutes: local.hour * 60 + local.minute,
    start: zonedTimeToUtc({ year: local.year, month: local.month, day: local.day, hour: 0, minute: 0 }, timeZone),
    end: zonedTimeToUtc({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 }, timeZone),
  };
}

/** "HH:mm" → minutes since midnight. */
export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}
