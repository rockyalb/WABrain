/**
 * JSON-lines logger with redaction. Secrets, message content, tokens, and
 * URLs are never written to logs.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /pass|secret|token|authorization|cookie|body|text|content|raw|code|p256dh|^auth$|key$|url|endpoint|title|description|summary|caption|filename|payload|data$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : redact(item, depth + 1),
      ]),
    );
  }
  return typeof value === "string" ? redactString(value) : value;
}

/** Strips URL queries and bearer tokens from free text. */
export function redactString(value: string): string {
  return value
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]")
    .replace(/bearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 2000);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  level: LogLevel = "info",
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const log = (at: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: at, msg: message, ...(redact(fields ?? {}) as object) }));
  };
  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
