/** History import helpers, kept free of UI code so they can be tested. */
import type { CoverageRow, ImportRun } from "./api";

/**
 * GET /setup/import/coverage allows a burst of 3, then one request a minute (a check without an
 * import scans OpenWA's whole stored history). Poll slower than that while an import runs.
 */
export const COVERAGE_POLL_MS = 65_000;

export type Tone = "ok" | "warn" | "error" | "idle";

export const isActive = (run: ImportRun | null | undefined): boolean => run?.status === "queued" || run?.status === "running";

export function runBadge(run: ImportRun | null | undefined): { label: string; tone: Tone } {
  if (!run) return { label: "Not started", tone: "idle" };
  switch (run.status) {
    case "queued":
      return { label: "Queued", tone: "warn" };
    case "running":
      return { label: "Running", tone: "warn" };
    case "completed":
      return { label: "Completed", tone: "ok" };
    case "cancelled":
      return { label: "Cancelled", tone: "idle" };
    case "failed":
      return { label: "Failed", tone: "error" };
    default:
      return { label: run.status, tone: "idle" };
  }
}

/** The start button: a cancelled or failed run resumes where it stopped; a completed one starts over. */
export function startLabel(run: ImportRun | null | undefined): string {
  if (run?.status === "cancelled" || run?.status === "failed") return "Resume import…";
  if (run?.status === "completed") return "Import again…";
  return "Import 90 days…";
}

/** Combines a start/cancel response (a partial run) with what the page already knows. */
export function mergeRun(previous: ImportRun | null, next: ImportRun | null): ImportRun | null {
  if (!next) return previous;
  if (!previous) return next;
  const restarted = next.status === "queued" || next.status === "running";
  return {
    status: next.status,
    startedAt: next.startedAt ?? previous.startedAt,
    finishedAt: restarted ? null : (next.finishedAt ?? previous.finishedAt),
    progress: next.progress ?? (restarted ? null : previous.progress),
    error: restarted ? null : (next.error ?? previous.error),
  };
}

/** 0..100, or null while the total is unknown. */
export function progressPercent(run: ImportRun | null | undefined): number | null {
  if (!run || run.progress === null) return null;
  return Math.max(0, Math.min(100, Math.round(run.progress * 100)));
}

export interface CoverageTotals {
  chats: number;
  messages: number;
  mediaOk: number;
  mediaFailed: number;
  chatsWithGaps: number;
  earliestAt: string | null;
}

export function coverageTotals(items: CoverageRow[]): CoverageTotals {
  let earliestAt: string | null = null;
  const totals = { chats: items.length, messages: 0, mediaOk: 0, mediaFailed: 0, chatsWithGaps: 0 };
  for (const row of items) {
    totals.messages += row.messageCount;
    totals.mediaOk += row.mediaOk;
    totals.mediaFailed += row.mediaFailed;
    if (row.gaps.length) totals.chatsWithGaps += 1;
    if (row.earliestAt && (!earliestAt || row.earliestAt < earliestAt)) earliestAt = row.earliestAt;
  }
  return { ...totals, earliestAt };
}
