/** GET /setup/jobs/failures: owner-only, read-only, redacted view of dead-lettered jobs. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieFrom, createHarness, type Harness } from "./test/harness.js";

const CHAT_ID = "0b6f4d1e-2c3a-4f5b-8e9d-1a2b3c4d5e6f";
let h: Harness;
let cookie = "";

beforeAll(async () => {
  h = await createHarness({ worker: false });
  cookie = cookieFrom(await h.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } }));
  const { sql } = h.testDb.database;
  await sql`
    insert into pgboss.job (name, data, source_name, output) values
      ('dead.embed-chat', ${JSON.stringify({ chatId: CHAT_ID })}::jsonb, 'embed-chat', ${JSON.stringify({ message: "401 invalid key sk-live-abcdef0123456789" })}::jsonb),
      ('dead.process-media', ${JSON.stringify({ mediaObjectId: "447690000000@c.us" })}::jsonb, 'process-media', ${JSON.stringify({ message: "timed out reading private.pdf" })}::jsonb)`;
});
afterAll(async () => {
  await h.close();
});

describe("failed job inspection", () => {
  it("requires the owner session", async () => {
    expect((await h.request("/setup/jobs/failures")).status).toBe(401);
  });

  it("lists failures without payload text or exception messages", async () => {
    const response = await h.request("/setup/jobs/failures", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.counts).toEqual({ "embed-chat": 1, "process-media": 1 });
    expect(body.items).toHaveLength(2);
    expect(body.items).toContainEqual(expect.objectContaining({ queue: "embed-chat", subject: { chatId: CHAT_ID } }));
    expect(body.items).toContainEqual(expect.objectContaining({ queue: "process-media", subject: { mediaObjectId: "[redacted]" } }));
    const text = JSON.stringify(body);
    for (const leak of ["sk-live", "private.pdf", "447690000000"]) expect(text).not.toContain(leak);
  });

  it("filters and bounds the list", async () => {
    const filtered = await (await h.request("/setup/jobs/failures?queue=embed-chat&limit=1", { headers: { cookie } })).json();
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].queue).toBe("embed-chat");
    expect((await h.request("/setup/jobs/failures?queue=dead.embed-chat", { headers: { cookie } })).status).toBe(400);
    expect((await h.request("/setup/jobs/failures?limit=5000", { headers: { cookie } })).status).toBe(400);
  });
});
