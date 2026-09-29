/** GET /v1/notifications and POST /v1/notifications/ack: the device's fallback for missed pushes. */
import { NotificationsResponseSchema } from "@wabrain/contracts";
import { enqueueNotification, listDeviceNotifications, revokeDevice, schema } from "@wabrain/db";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHarness, ownerAndDevice, type Harness } from "./test/harness.js";

let h: Harness;
let token: string;
let deviceId: string;
beforeAll(async () => {
  h = await createHarness({ worker: false });
  ({ token, deviceId } = await ownerAndDevice(h));
});
afterAll(async () => {
  await h.close();
});

it("lists and acknowledges only the calling device's notifications", async () => {
  expect((await h.request("/v1/notifications")).status).toBe(401);
  expect((await h.request("/v1/notifications/ack", { method: "POST", json: { ids: [] } })).status).toBe(401);
  await h.deps.database.db.insert(schema.devices).values({ id: "other-device", name: "Other", tokenHash: "other-hash" });
  const now = new Date();
  const id = await h.deps.database.transaction(({ db }) =>
    enqueueNotification(db, {
      key: "api-summary",
      payload: { type: "summary", open: 1, dueToday: 1, overdue: 0, review: 0 },
      at: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    }),
  );
  const headers = { authorization: `Bearer ${token}` };
  const response = await h.request("/v1/notifications", { headers });
  expect(response.status).toBe(200);
  const body = NotificationsResponseSchema.parse(await response.json());
  expect(body.items).toEqual([
    { id, createdAt: now.toISOString(), payload: { type: "summary", notificationId: id, open: 1, dueToday: 1, overdue: 0, review: 0 } },
  ]);

  // Unknown ids are ignored; acknowledging twice is harmless.
  for (let i = 0; i < 2; i++) {
    const ack = await h.request("/v1/notifications/ack", { method: "POST", headers, json: { ids: [id, "unknown"] } });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ ok: true });
  }
  expect(await (await h.request("/v1/notifications", { headers })).json()).toEqual({ items: [] });
  expect(await listDeviceNotifications(h.deps.database.db, deviceId)).toEqual([]);
  expect(await listDeviceNotifications(h.deps.database.db, "other-device")).toHaveLength(1);
  expect((await h.request("/v1/notifications/ack", { method: "POST", headers, json: { ids: Array(101).fill(id) } })).status).toBe(400);
});

it("rejects a revoked device", async () => {
  await revokeDevice(h.deps.database.db, deviceId);
  expect((await h.request("/v1/notifications", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
});

it("documents both routes as device-authenticated in the OpenAPI document", async () => {
  const doc = (await (await h.request("/v1/openapi.json")).json()) as {
    paths: Record<string, Record<string, { security: unknown[] }>>;
    components: { schemas: Record<string, unknown> };
  };
  expect(doc.paths["/v1/notifications"]!.get!.security).toEqual([{ deviceToken: [] }]);
  expect(doc.paths["/v1/notifications/ack"]!.post!.security).toEqual([{ deviceToken: [] }]);
  expect(Object.keys(doc.components.schemas)).toEqual(
    expect.arrayContaining(["NotificationEvent", "NotificationsResponse", "NotificationAckRequest"]),
  );
});
