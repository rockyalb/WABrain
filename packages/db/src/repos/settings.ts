import type { Settings } from "@wabrain/contracts";
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { toSettings, type SettingsRow } from "../mappers.js";
import { contexts, settings } from "../schema.js";

export const DEFAULT_CONTEXTS = [
  { name: "Work", color: "#3B82F6", sortOrder: 0 },
  { name: "Personal", color: "#10B981", sortOrder: 1 },
] as const;

/**
 * Creates the settings row on first boot (which starts the trial) and seeds
 * the default contexts at the same moment. Safe to call on every start.
 */
export async function ensureDefaults(db: Db): Promise<void> {
  const inserted = await db.insert(settings).values({ id: 1 }).onConflictDoNothing().returning({ id: settings.id });
  if (inserted.length) await seedDefaultContexts(db);
}

export async function seedDefaultContexts(db: Db): Promise<void> {
  const existing = await db.select({ id: contexts.id }).from(contexts).limit(1);
  if (existing.length) return;
  await db.insert(contexts).values(DEFAULT_CONTEXTS.map((context) => ({ id: newId(), ...context })));
}

export async function getSettingsRow(db: Db): Promise<SettingsRow> {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  if (row) return row;
  await ensureDefaults(db);
  const [created] = await db.select().from(settings).where(eq(settings.id, 1));
  if (!created) throw new Error("settings row missing");
  return created;
}

export async function getSettings(db: Db): Promise<Settings> {
  return toSettings(await getSettingsRow(db));
}

export type SettingsPatch = Partial<
  Pick<Settings, "timezone" | "endOfWorkDay" | "dailySummaryTime" | "remindersEnabled" | "reminderLeadMinutes">
>;
export type PolicyPatch = Partial<Pick<Settings, "trialDays" | "autoCreateThreshold">>;

export async function updateSettings(db: Db, patch: SettingsPatch | PolicyPatch): Promise<Settings> {
  await getSettingsRow(db);
  const [row] = await db
    .update(settings)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(settings.id, 1))
    .returning();
  return toSettings(row!);
}

export function trialEndsAt(value: Settings): Date {
  return new Date(Date.parse(value.trialStartedAt) + value.trialDays * 86_400_000);
}

export function isTrialActive(value: Settings, now = new Date()): boolean {
  return now < trialEndsAt(value);
}

export async function listContextsOrdered(db: Db) {
  return db.select().from(contexts).orderBy(asc(contexts.sortOrder), asc(contexts.name));
}
