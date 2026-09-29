import { invalid } from "./errors.js";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageRequest {
  cursor?: string | null;
  limit?: number | null;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export function clampLimit(limit?: number | null): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit)));
}

type CursorPart = string | number | null;

export function encodeCursor(parts: CursorPart[]): string {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

export function decodeCursor(cursor: string, length: number): CursorPart[] {
  try {
    const parts = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(parts) &&
      parts.length === length &&
      parts.every((part) => part === null || typeof part === "string" || typeof part === "number")
    ) {
      return parts as CursorPart[];
    }
  } catch {
    // fall through
  }
  throw invalid("Invalid cursor");
}

/** Given limit+1 fetched rows, returns the page and the cursor of its last row. */
export function toPage<R, T>(rows: R[], limit: number, map: (row: R) => T, cursorOf: (row: R) => CursorPart[]): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(map),
    nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
  };
}
