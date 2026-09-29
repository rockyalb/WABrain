/** Model call accounting for daily spending limits. Stores counts only, never prompts or outputs. */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { modelUsage } from "../schema.js";
import type { ProviderRole } from "./provider-settings.js";

export interface ModelUsageInput {
  role: ProviderRole;
  purpose: string;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  refId?: string | null;
  at?: Date;
}

export async function recordModelUsage(db: Db, input: ModelUsageInput): Promise<void> {
  await db.insert(modelUsage).values({ id: newId(), ...input, at: input.at ?? new Date() });
}

export async function usageSince(db: Db, role: ProviderRole, since: Date): Promise<{ calls: number; tokens: number }> {
  const [row] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum(coalesce(${modelUsage.inputTokens}, 0) + coalesce(${modelUsage.outputTokens}, 0)), 0)::int`,
    })
    .from(modelUsage)
    .where(and(eq(modelUsage.role, role), gte(modelUsage.at, since)));
  return { calls: row?.calls ?? 0, tokens: row?.tokens ?? 0 };
}

export interface DailyModelUsage {
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  role: ProviderRole;
  provider: string | null;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Seconds of audio transcribed (voice notes' recorded duration); 0 for other roles. */
  audioSeconds: number;
}

/** Calls, tokens and audio seconds per UTC day, role and model since `since`, oldest day first. */
export async function dailyModelUsage(db: Db, since: Date): Promise<DailyModelUsage[]> {
  const rows = await db.execute<{
    day: string;
    role: ProviderRole;
    provider: string | null;
    model: string | null;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    audio_seconds: number;
  }>(sql`
    select to_char(u.at at time zone 'UTC', 'YYYY-MM-DD') as day, u.role, u.provider, u.model,
      count(*)::int as calls,
      coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
      coalesce(sum(u.output_tokens), 0)::bigint as output_tokens,
      coalesce(sum(case when u.role = 'transcription' then mo.duration_seconds end), 0)::float8 as audio_seconds
    from model_usage u
    left join media_objects mo on mo.id = u.ref_id and u.role = 'transcription'
    where u.at >= ${since.toISOString()}::timestamptz
    group by 1, 2, 3, 4
    order by 1, 2, 4`);
  return rows.map((row) => ({
    day: row.day,
    role: row.role,
    provider: row.provider,
    model: row.model,
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    audioSeconds: Number(row.audio_seconds),
  }));
}
