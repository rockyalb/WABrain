/**
 * Daily spending limits per model role (tokens and calls), counted from model_usage since local
 * midnight in the settings timezone. When a role is over budget its jobs are deferred to the next
 * local midnight — never dropped.
 */
import { getAppState, getSettings, setAppState, usageSince, type Database, type ProviderRole } from "@wabrain/db";
import type { RoleLimits } from "../providers.js";
import { localDay } from "./time.js";

export interface BudgetCheck {
  role: ProviderRole;
  exceeded: boolean;
  usedTokens: number;
  usedCalls: number;
  tokenLimit: number | null;
  callLimit: number | null;
  /** Next local midnight: when the budget resets. */
  resetAt: Date;
}

export async function checkBudget(database: Database, role: ProviderRole, limits: RoleLimits, now: Date): Promise<BudgetCheck> {
  const settings = await getSettings(database.db);
  const day = localDay(now, settings.timezone);
  const usage = await usageSince(database.db, role, day.start);
  const exceeded =
    (limits.dailyTokenLimit !== null && usage.tokens >= limits.dailyTokenLimit) ||
    (limits.dailyCallLimit !== null && usage.calls >= limits.dailyCallLimit);
  return {
    role,
    exceeded,
    usedTokens: usage.tokens,
    usedCalls: usage.calls,
    tokenLimit: limits.dailyTokenLimit,
    callLimit: limits.dailyCallLimit,
    resetAt: day.end,
  };
}

const DEFERRAL_KEY = "pipeline.deferrals";

export interface Deferral {
  role: ProviderRole;
  reason: "budget" | "provider";
  at: string;
  until: string;
}

/** Remembers the latest deferral per role for /setup/status. */
export async function recordDeferral(database: Database, deferral: Deferral): Promise<void> {
  const current = (await getAppState<Record<string, Deferral>>(database.db, DEFERRAL_KEY)) ?? {};
  await setAppState(database.db, DEFERRAL_KEY, { ...current, [deferral.role]: deferral });
}

export async function listDeferrals(database: Database, now: Date): Promise<Deferral[]> {
  const current = (await getAppState<Record<string, Deferral>>(database.db, DEFERRAL_KEY)) ?? {};
  return Object.values(current).filter((deferral) => Date.parse(deferral.until) > now.getTime());
}
