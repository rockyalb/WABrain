import {
  acknowledgeNotifications,
  createContext,
  deleteContext,
  deletePushEndpoint,
  getAutoCreateStatus,
  getSettings,
  isTrialActive,
  isValidTimeZone,
  listContexts,
  listDeviceNotifications,
  readSync,
  revokeDevice,
  updateContext,
  updateSettings,
  upsertPushEndpoint,
} from "@wabrain/db";
import { NotificationAckSchema } from "@wabrain/contracts";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { audit, notifySync } from "../http/audit.js";
import { HttpError } from "../http/errors.js";
import {
  CreateContextRequestSchema,
  DeleteContextQuerySchema,
  PushEndpointRequestSchema,
  SyncQuerySchema,
  UpdateContextRequestSchema,
  UpdateSettingsRequestSchema,
} from "../http/schemas.js";
import { jsonBody, queryParams } from "../http/validate.js";
import { assertSafePushEndpoint, UnsafeUrlError } from "../security/ssrf.js";

/** Sync, contexts, settings, push endpoints, device self-unpair. */
export function miscRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { database } = deps;

  app.get("/sync", async (c) => {
    const { since } = queryParams(c, SyncQuerySchema);
    return c.json(await readSync(database, since ?? null, deps.now()));
  });

  // Fallback for missed pushes: the same durable notifications, per device, until acknowledged.
  app.get("/notifications", async (c) =>
    c.json({ items: await listDeviceNotifications(database.db, c.get("deviceId")!, deps.now()) }),
  );

  app.post("/notifications/ack", async (c) => {
    const { ids } = await jsonBody(c, NotificationAckSchema);
    await acknowledgeNotifications(database.db, c.get("deviceId")!, ids, deps.now());
    return c.json({ ok: true });
  });

  app.get("/contexts", async (c) => c.json(await listContexts(database.db)));

  app.post("/contexts", async (c) => {
    const context = await createContext(database.db, await jsonBody(c, CreateContextRequestSchema));
    await notifySync(deps);
    return c.json(context, 201);
  });

  app.patch("/contexts/:id", async (c) => {
    const context = await updateContext(database.db, c.req.param("id"), await jsonBody(c, UpdateContextRequestSchema));
    await notifySync(deps);
    return c.json(context);
  });

  app.delete("/contexts/:id", async (c) => {
    const { reassignTo } = queryParams(c, DeleteContextQuerySchema);
    const id = c.req.param("id");
    await database.transaction(async ({ db }) => {
      await deleteContext(db, id, reassignTo ?? null);
      await audit(deps, c, { action: "context.deleted", targetType: "context", targetId: id, details: { reassignTo: reassignTo ?? null } }, db);
    });
    await notifySync(deps);
    return c.body(null, 204);
  });

  // Settings plus why creates are (not) automatic yet: trial, calibrating the current model/prompt, or active.
  app.get("/settings", async (c) => {
    const settings = await getSettings(database.db);
    const autoCreate = await getAutoCreateStatus(database.db, {
      inTrial: isTrialActive(settings, deps.now()),
      autoCreateThreshold: settings.autoCreateThreshold,
    });
    return c.json({ ...settings, autoCreate });
  });

  app.patch("/settings", async (c) => {
    const patch = await jsonBody(c, UpdateSettingsRequestSchema);
    if (patch.timezone && !isValidTimeZone(patch.timezone)) throw new HttpError("validation_failed", "timezone: unknown IANA timezone");
    const settings = await updateSettings(database.db, patch);
    await audit(deps, c, { action: "settings.changed", details: { fields: Object.keys(patch) } });
    await notifySync(deps);
    return c.json(settings);
  });

  app.post("/push-endpoints", async (c) => {
    const body = await jsonBody(c, PushEndpointRequestSchema);
    try {
      await assertSafePushEndpoint(body.endpoint, { allowHost: deps.config.ntfyHost });
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw new HttpError("validation_failed", `endpoint: ${error.message}`);
      throw error;
    }
    await upsertPushEndpoint(database.db, c.get("deviceId")!, body);
    return c.body(null, 204);
  });

  app.delete("/push-endpoints", async (c) => {
    await deletePushEndpoint(database.db, c.get("deviceId")!);
    return c.body(null, 204);
  });

  app.delete("/devices/self", async (c) => {
    const deviceId = c.get("deviceId")!;
    await database.transaction(async ({ db }) => {
      await revokeDevice(db, deviceId, deps.now());
      await audit(deps, c, { action: "device.unpaired", targetType: "device", targetId: deviceId }, db);
    });
    return c.body(null, 204);
  });

  return app;
}
