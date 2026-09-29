import { getConnInfo } from "@hono/node-server/conninfo";
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { errorJson } from "../http/errors.js";
import type { RateLimitPolicy } from "../security/rate-limit.js";

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Request id, client IP, no-store caching, and a redacted access log line. */
export function requestContext(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    c.set("requestId", randomUUID());
    c.set("principal", "anonymous");
    c.set("deviceId", undefined);
    c.set("clientIp", clientIp(c, deps.config.trustProxy));
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Request-Id", c.get("requestId"));
    deps.logger.info("request", {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      principal: c.get("principal"),
    });
  };
}

export function rateLimit(
  deps: AppDeps,
  name: string,
  policy: RateLimitPolicy,
  key: (c: Context<AppEnv>) => string = (c) => c.get("clientIp"),
): MiddlewareHandler<AppEnv> {
  const limiter = deps.rateLimiters(name, policy);
  return async (c, next) => {
    const result = await limiter.take(`${name}:${key(c)}`);
    if (!result.allowed) {
      return errorJson(c, "rate_limited", "Too many requests", { "Retry-After": String(result.retryAfterSeconds) });
    }
    await next();
  };
}
