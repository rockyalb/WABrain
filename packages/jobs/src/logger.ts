/**
 * JSON-lines logger for the worker with redaction: message bodies, derived text, titles, keys,
 * tokens, endpoints, and media URLs never reach the logs. Mirrors apps/api's logger.
 */
import type { JobLogger } from "./queue.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /pass|secret|token|authorization|cookie|body|text|content|raw|code|p256dh|^auth$|key$|url|endpoint|title|description|summary|caption|filename|payload|data$|prompt|ocr|transcript|derived/i;

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(item, depth + 1)]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
}

/** Strips URLs' paths and queries, bearer tokens, and API-key-looking strings from free text. */
export function redactText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/gi, (url) => {
      try {
        return `${new URL(url).origin}/[redacted]`;
      } catch {
        return "[url]";
      }
    })
    .replace(/bearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .slice(0, 1000);
}

export interface WorkerLogger extends JobLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
}

export function createWorkerLogger(level: LogLevel = "info", write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): WorkerLogger {
  const log = (at: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: at, msg: message, ...(redactValue(fields ?? {}) as object) }));
  };
  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}
