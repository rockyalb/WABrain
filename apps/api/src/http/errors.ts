import { DomainError } from "@wabrain/db";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Logger } from "../logger.js";

export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "budget_exceeded"
  | "payload_too_large"
  | "not_implemented"
  | "unavailable"
  | "internal";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  rate_limited: 429,
  budget_exceeded: 429,
  payload_too_large: 413,
  not_implemented: 501,
  unavailable: 503,
  internal: 500,
};

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
  get status() {
    return STATUS[this.code];
  }
}

export const ErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export function errorJson(c: Context, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
  for (const [name, value] of Object.entries(headers)) c.header(name, value);
  return c.json({ error: { code, message } }, STATUS[code]);
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export function handleError(logger: Logger) {
  return (error: Error, c: Context) => {
    if (error instanceof HttpError) return errorJson(c, error.code, error.message, error.headers);
    if (error instanceof DomainError) return errorJson(c, error.code, error.message);
    if (error instanceof z.ZodError) return errorJson(c, "validation_failed", zodMessage(error));
    logger.error("unhandled error", { error, path: c.req.path, method: c.req.method });
    return errorJson(c, "internal", "Internal server error");
  };
}
