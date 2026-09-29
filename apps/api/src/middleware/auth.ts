import { ensureWebDevice, findActiveDeviceByTokenHash, findOwnerSession, sha256Hex, touchDevice, webDeviceId } from "@wabrain/db";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppDeps, AppEnv } from "../deps.js";
import { errorJson } from "../http/errors.js";

export const SESSION_COOKIE = "__Host-wabrain_session";
const TOUCH_INTERVAL_MS = 60_000;

/** Requires `Authorization: Bearer <device token>` for an unrevoked device. */
export function deviceAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(c.req.header("authorization") ?? "");
    if (!match) return errorJson(c, "unauthorized", "Missing or invalid device token");
    const device = await findActiveDeviceByTokenHash(deps.database.db, sha256Hex(match[1]!));
    if (!device) return errorJson(c, "unauthorized", "Missing or invalid device token");
    c.set("deviceId", device.id);
    c.set("principal", `device:${device.id}`);
    const now = deps.now();
    if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await touchDevice(deps.database.db, device.id, now);
    }
    await next();
  };
}

/** Requires a valid owner session cookie. */
export function ownerAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await findOwnerSession(deps.database.db, sha256Hex(token), deps.now()) : null;
    if (!session) return errorJson(c, "unauthorized", "Owner session required");
    c.set("principal", "owner");
    await next();
  };
}

/** Owner cookie auth for the browser app, with a session-scoped push device. */
export function ownerWebAuth(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const sessionHash = token ? sha256Hex(token) : null;
    const session = sessionHash ? await findOwnerSession(deps.database.db, sessionHash, deps.now()) : null;
    if (!session || !sessionHash) return errorJson(c, "unauthorized", "Owner session required");
    if (!(await ensureWebDevice(deps.database.db, sessionHash))) return errorJson(c, "unauthorized", "Browser device revoked");
    const deviceId = webDeviceId(sessionHash);
    c.set("deviceId", deviceId);
    c.set("principal", `owner-web:${deviceId}`);
    await next();
  };
}

/**
 * Cookie-authenticated routes: reject cross-origin unsafe requests. Browsers
 * always send Origin on cross-origin POST/PATCH/PUT/DELETE.
 */
export function sameOrigin(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (origin && origin !== deps.config.setupOrigin) return errorJson(c, "forbidden", "Cross-origin request rejected");
      if (c.req.header("sec-fetch-site") === "cross-site") return errorJson(c, "forbidden", "Cross-origin request rejected");
    }
    await next();
  };
}
