import type { AskResponse, Chat, Context, MessageView, Person, ReviewItem, Settings, Task, TaskEvent } from "@wabrain/contracts";

export type { AskResponse, Chat, Context, MessageView, Person, ReviewItem, Settings, Task, TaskEvent };

export interface Snapshot {
  tasks: Task[];
  reviewItems: ReviewItem[];
  contexts: Context[];
  chats: Chat[];
  people: Person[];
  settings: Settings;
}

export interface TaskDetail { task: Task; events: TaskEvent[]; evidence: MessageView[] }
export interface PersonDetail extends Person { facts: Person["facts"] }

export function displayDate(value: string | null, settings?: Settings): string {
  if (!value) return "No due date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    ...(settings?.timezone ? { timeZone: settings.timezone } : {}),
  }).format(new Date(value));
}

export function displayTime(value: string | null, settings?: Settings): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(settings?.timezone ? { timeZone: settings.timezone } : {}),
  }).format(new Date(value));
}

export function dateKey(value: string | null, settings: Settings): string | null {
  if (!value) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function todayKey(settings: Settings): string {
  return dateKey(new Date().toISOString(), settings)!;
}

export function timeKey(value: string, settings: Pick<Settings, "timezone">): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}

/** Convert the workspace's wall-clock time to an instant, including DST gaps/overlaps. */
export function zonedDateTime(date: string, time: string, zone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const localMs = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const offsetAt = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
    const local = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    return local - Math.floor(instant / 1000) * 1000;
  };
  const before = offsetAt(localMs - 86_400_000);
  const after = offsetAt(localMs + 86_400_000);
  const candidates = [...new Set([before, after])]
    .map((offset) => localMs - offset)
    .filter((instant) => instant + offsetAt(instant) === localMs)
    .sort((a, b) => a - b);
  return new Date(candidates[0] ?? localMs - before).toISOString();
}

export function effectiveContext(task: Pick<Task, "contextId" | "chatId" | "personId">, data: Snapshot): string | null {
  return task.contextId
    ?? data.chats.find((chat) => chat.id === task.chatId)?.defaultContextId
    ?? data.people.find((person) => person.id === task.personId)?.defaultContextId
    ?? null;
}

export function contextName(id: string | null, contexts: Context[]): string {
  return contexts.find((context) => context.id === id)?.name ?? "Unsorted";
}

export function reviewLabel(review: ReviewItem): string {
  switch (review.type) {
    case "create": return "New task";
    case "possibly_done": return "Possibly done";
    case "possibly_cancelled": return "Possibly cancelled";
    case "reschedule": return "Date change";
    case "merge": return "Merge tasks";
  }
}

export function reviewTitle(review: ReviewItem): string {
  return review.action.type === "create" ? review.action.title : review.summary;
}

/** A choice in a type-to-filter dropdown. `detail` is shown under the label and searched too. */
export interface ComboOption { value: string; label: string; detail?: string }

/** Lower case without accents, so "zoe" finds "Zoë" and "muller" finds "Müller". */
export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The phone number in a WhatsApp JID, e.g. "+447691234567"; null for groups and LIDs. */
export function jidPhone(jid: string): string | null {
  const match = /^(\d{6,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/.exec(jid);
  return match ? `+${match[1]}` : null;
}

/**
 * Options whose label has every typed word, or whose number has the typed
 * digits. Names that start with the query come first.
 */
export function filterOptions(options: ComboOption[], query: string): ComboOption[] {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  // Local numbers drop the leading 0 of the trunk prefix: "069 111" finds +355 69 111….
  const typed = query.replace(/\D/g, "");
  const digits = typed.replace(/^0+/, "");
  const first = words[0]!;
  const hits = options.filter((option) => {
    const text = foldText(`${option.label} ${option.detail ?? ""}`);
    if (words.every((word) => text.includes(word))) return true;
    return typed.length >= 3 && digits.length > 0 && (option.detail ?? "").replace(/\D/g, "").includes(digits);
  });
  const rank = (option: ComboOption) => foldText(option.label).startsWith(first) ? 0 : foldText(option.label).split(/\s+/).some((part) => part.startsWith(first)) ? 1 : 2;
  return hits.map((option, index) => ({ option, index })).sort((a, b) => rank(a.option) - rank(b.option) || a.index - b.index).map(({ option }) => option);
}
