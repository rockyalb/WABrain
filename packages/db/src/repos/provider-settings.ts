/** Owner-configured model providers per role. API keys are stored encrypted (see crypto.ts). */
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { providerSettings } from "../schema.js";

export const PROVIDER_ROLES = ["text", "vision", "transcription", "embedding"] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];
export type ProviderSettingsRow = typeof providerSettings.$inferSelect;

export async function listProviderSettings(db: Db): Promise<ProviderSettingsRow[]> {
  return db.select().from(providerSettings).orderBy(asc(providerSettings.role));
}

export interface ProviderSettingsInput {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Ciphertext; undefined keeps the stored key, null clears it. */
  apiKeyEncrypted?: string | null;
  dimensions: number | null;
  structuredOutputs: boolean | null;
  dailyTokenLimit: number | null;
  dailyCallLimit: number | null;
}

export async function upsertProviderSettings(db: Db, role: ProviderRole, input: ProviderSettingsInput): Promise<void> {
  const { apiKeyEncrypted, ...rest } = input;
  const values = { ...rest, ...(apiKeyEncrypted !== undefined ? { apiKeyEncrypted } : {}) };
  await db
    .insert(providerSettings)
    .values({ role, ...values })
    .onConflictDoUpdate({ target: providerSettings.role, set: { ...values, updatedAt: sql`now()` } });
}

export async function deleteProviderSettings(db: Db, role: ProviderRole): Promise<void> {
  await db.delete(providerSettings).where(eq(providerSettings.role, role));
}
