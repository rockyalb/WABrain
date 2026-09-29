import { consumePairingCode, createDevice, newId, randomSecret, sha256Hex, writeAudit } from "@wabrain/db";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { audit } from "../http/audit.js";
import { HttpError } from "../http/errors.js";
import { PairRequestSchema } from "../http/schemas.js";
import { jsonBody } from "../http/validate.js";

/** POST /v1/devices/pair: exchanges a one-time pairing code for a device token. */
export function pairDevice(deps: AppDeps) {
  return async (c: Context<AppEnv>) => {
    const { code, deviceName } = await jsonBody(c, PairRequestSchema);
    const deviceId = newId();
    const token = randomSecret(32);
    const paired = await deps.database.transaction(async ({ db }) => {
      if (!(await consumePairingCode(db, sha256Hex(code), deviceId, deps.now()))) return false;
      await createDevice(db, { id: deviceId, name: deviceName, tokenHash: sha256Hex(token) });
      await writeAudit(db, {
        actor: `device:${deviceId}`,
        action: "device.paired",
        targetType: "device",
        targetId: deviceId,
        ip: c.get("clientIp"),
      });
      return true;
    });
    if (!paired) {
      await audit(deps, c, { action: "device.pair_failed" });
      throw new HttpError("unauthorized", "Invalid or expired pairing code");
    }
    return c.json({ deviceId, token }, 201);
  };
}
