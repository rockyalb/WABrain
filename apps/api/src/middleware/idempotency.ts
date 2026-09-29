/**
 * Idempotency-Key support for mutating requests: the first response for a
 * (principal, method, path, key) is stored for 24 h and replayed; the same
 * key with a different body is a conflict.
 */
import { abortIdempotent, beginIdempotent, completeIdempotent, sha256Hex } from "@wabrain/db";
import type { MiddlewareHandler } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { errorJson } from "../http/errors.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Responses that contain secrets (device tokens, pairing codes, sessions)
 * are never stored, so these routes do not take part. Neither does the read-only POST /v1/ask: it
 * changes nothing, and its answer (message excerpts) should not be kept in the idempotency table.
 */
const EXCLUDED = new Set(["/v1/devices/pair", "/setup/pairing-codes", "/setup/login", "/setup/bootstrap", "/setup/logout", "/v1/ask", "/web/ask"]);

export function idempotency(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (!key || !MUTATING.has(c.req.method) || EXCLUDED.has(c.req.path)) return next();
    if (key.length > 255) return errorJson(c, "validation_failed", "Idempotency-Key is too long");
    const body = await c.req.text();
    const scope = sha256Hex(JSON.stringify([c.get("principal"), c.req.method, c.req.path, key]));
    const requestHash = sha256Hex(`${c.req.url.split("?")[1] ?? ""}\n${body}`);
    const begin = await beginIdempotent(deps.database.db, scope, requestHash, deps.now());
    if (begin.state === "mismatch") return errorJson(c, "conflict", "Idempotency-Key was used with a different request");
    if (begin.state === "in_progress") return errorJson(c, "conflict", "A request with this Idempotency-Key is in progress");
    if (begin.state === "completed") {
      return new Response(begin.status === 204 ? null : begin.body, {
        status: begin.status,
        headers: { "Content-Type": "application/json", "Idempotent-Replayed": "true" },
      });
    }
    try {
      await next();
    } catch (error) {
      await abortIdempotent(deps.database.db, scope);
      throw error;
    }
    if (c.res.status >= 500 || c.res.status === 429) {
      await abortIdempotent(deps.database.db, scope);
    } else {
      await completeIdempotent(deps.database.db, scope, c.res.status, await c.res.clone().text());
    }
  };
}
