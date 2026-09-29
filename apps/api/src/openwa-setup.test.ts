/**
 * OpenWA setup: GET /setup/openwa/status, POST /setup/openwa/test, GET /setup/openwa/qr, run
 * against a fake OpenWA server. Only GET requests may reach OpenWA, and the read key never leaves
 * the server.
 */
import { startFakeOpenWa, type FakeOpenWa } from "@wabrain/openwa-adapter/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { cookieFrom, createHarness, PUBLIC_BASE_URL, type Harness } from "./test/harness.js";

const SESSION = "0a941dac-a965-45e7-b318-74ae8be134f0";
const OTHER = "7b1f7a52-3a53-4f2c-9d43-0d6f5a0c9e11";
const READ_KEY = "owa-viewer-Key-0123456789abcdefXYZ";
const OPERATOR_KEY = "owa-operator-Key-0123456789abcdefXYZ";

const logLines: string[] = [];
let fake: FakeOpenWa;
const harnesses: Harness[] = [];

beforeAll(async () => {
  fake = await startFakeOpenWa({
    storedMessages: 42,
    keys: {
      [READ_KEY]: { role: "viewer", allowedSessions: [SESSION] },
      [OPERATOR_KEY]: { role: "operator", allowedSessions: [SESSION] },
    },
  });
});
afterAll(async () => {
  await Promise.all(harnesses.map((harness) => harness.close()));
  await fake.close();
});
beforeEach(() => {
  fake.sessions = [
    { id: SESSION, name: "brain", status: "ready", phone: "447690000000", pushName: "Alex" },
    { id: OTHER, name: "other-app", status: "ready" },
  ];
});

/** A harness with the given OpenWA environment and a logged-in owner. */
async function owner(env: Record<string, string>) {
  const h = await createHarness({ worker: false, env, logger: createLogger("debug", (line) => logLines.push(line)) });
  harnesses.push(h);
  const boot = await h.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } });
  const cookie = cookieFrom(boot);
  return {
    h,
    get: (path: string) => h.request(path, { headers: { cookie } }),
    post: (path: string) => h.request(path, { method: "POST", headers: { cookie } }),
  };
}

const openwaEnv = (key = READ_KEY, extra: Record<string, string> = {}) => ({
  OPENWA_BASE_URL: fake.url,
  OPENWA_READ_API_KEY: key,
  OPENWA_SESSION_ID: SESSION,
  ...extra,
});

describe("OpenWA setup endpoints", () => {
  let configured: Awaited<ReturnType<typeof owner>>;

  beforeAll(async () => {
    configured = await owner(openwaEnv(READ_KEY, { OPENWA_DASHBOARD_URL: "https://openwa.example.com/" }));
  });

  it("requires the owner session", async () => {
    const { h } = configured;
    expect((await h.request("/setup/openwa/status")).status).toBe(401);
    expect((await h.request("/setup/openwa/test", { method: "POST" })).status).toBe(401);
    expect((await h.request("/setup/openwa/qr")).status).toBe(401);
  });

  it("reports the linked session", async () => {
    const response = await configured.get("/setup/openwa/status");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      configured: true,
      sessionId: SESSION,
      reachable: true,
      paired: true,
      error: null,
      session: { id: SESSION, status: "ready", pushName: "Alex", phone: "447690000000" },
      dashboardUrl: "https://openwa.example.com/sessions",
      webhookUrl: `${PUBLIC_BASE_URL}/webhooks/openwa`,
    });
  });

  it("reports a session waiting for its QR code, and links to the dashboard for it", async () => {
    fake.sessions = [{ id: SESSION, name: "brain", status: "qr_ready" }];
    const status = await (await configured.get("/setup/openwa/status")).json();
    expect(status).toMatchObject({ reachable: true, paired: false, session: { status: "qr_ready" } });

    const qr = await configured.get("/setup/openwa/qr");
    expect(qr.status).toBe(200);
    expect(await qr.json()).toEqual({
      mode: "dashboard",
      dashboardUrl: "https://openwa.example.com/sessions",
      sessionId: SESSION,
      sessionStatus: "qr_ready",
      paired: false,
      message: expect.stringContaining("scan its QR code"),
    });
  });

  it("says no QR code is needed once WhatsApp is linked", async () => {
    expect(await (await configured.get("/setup/openwa/qr")).json()).toMatchObject({ paired: true, sessionStatus: "ready" });
  });

  it("tests read access with GET requests only and audits the outcome", async () => {
    fake.requests.length = 0;
    const response = await configured.post("/setup/openwa/test");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; checks: { id: string; level: string; detail: string }[] };
    expect(body.ok).toBe(true);
    expect(body.checks.map((check) => check.id)).toEqual(["reachable", "session", "linked", "chats", "messages", "role", "session_scope"]);
    expect(body.checks.every((check) => check.level === "ok")).toBe(true);

    expect(fake.requests.length).toBeGreaterThan(0);
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fake.requests.every((request) => request.apiKey === READ_KEY)).toBe(true);
    expect(fake.requests.some((request) => /\/qr\b/.test(request.path))).toBe(false);

    const [audit] = await configured.h.testDb.database.sql<{ details: unknown }[]>`
      select details from audit_events where action = 'openwa.tested' order by at desc limit 1`;
    expect(audit?.details).toMatchObject({ ok: true, checks: { role: "ok", messages: "ok" } });
  });

  it("never returns or logs the read key", async () => {
    for (const path of ["/setup/openwa/status", "/setup/openwa/qr"]) {
      expect(await (await configured.get(path)).text()).not.toContain(READ_KEY);
    }
    expect(await (await configured.post("/setup/openwa/test")).text()).not.toContain(READ_KEY);
    expect(logLines.join("\n")).not.toContain(READ_KEY);
    const rows = await configured.h.testDb.database.sql`select details::text as details from audit_events`;
    expect(rows.map((row) => String(row.details)).join("\n")).not.toContain(READ_KEY);
  });
});

describe("OpenWA setup edge cases", () => {
  it("reports an unconfigured OpenWA without calling it", async () => {
    const { get, post } = await owner({});
    fake.requests.length = 0;
    expect(await (await get("/setup/openwa/status")).json()).toMatchObject({
      configured: false,
      reachable: false,
      session: null,
      dashboardUrl: null,
      error: { code: "not_configured" },
    });
    const test = await post("/setup/openwa/test");
    expect(test.status).toBe(409);
    expect(await (await get("/setup/openwa/qr")).json()).toMatchObject({ mode: "dashboard", dashboardUrl: null, sessionStatus: null, paired: false });
    expect(fake.requests).toHaveLength(0);
  });

  it("needs OPENWA_SESSION_ID for the test and lists the sessions the key can see", async () => {
    const { get, post } = await owner({ OPENWA_BASE_URL: fake.url, OPENWA_READ_API_KEY: READ_KEY });
    expect(await (await get("/setup/openwa/status")).json()).toMatchObject({
      configured: true,
      sessionId: null,
      error: { code: "no_session_id" },
      sessions: [{ id: SESSION, name: "brain", status: "ready" }],
    });
    expect((await post("/setup/openwa/test")).status).toBe(409);
  });

  it("warns when the key could send messages", async () => {
    const { post } = await owner(openwaEnv(OPERATOR_KEY));
    const body = (await (await post("/setup/openwa/test")).json()) as { ok: boolean; checks: { id: string; level: string }[] };
    expect(body.checks.find((check) => check.id === "role")).toMatchObject({ level: "warn" });
  });

  it("explains a rejected key and an unreachable OpenWA", async () => {
    const wrongKey = await owner(openwaEnv("owa-wrong-Key-0123456789abcdefXYZ"));
    expect(await (await wrongKey.get("/setup/openwa/status")).json()).toMatchObject({ reachable: true, error: { code: "unauthorized" } });
    const test = (await (await wrongKey.post("/setup/openwa/test")).json()) as { ok: boolean };
    expect(test.ok).toBe(false);

    const down = await owner({ ...openwaEnv(), OPENWA_BASE_URL: "http://127.0.0.1:1" });
    expect(await (await down.get("/setup/openwa/status")).json()).toMatchObject({ reachable: false, error: { code: "unreachable" } });
  });

  it("only links to an https OpenWA base URL as the dashboard", async () => {
    const internal = await owner(openwaEnv());
    expect(await (await internal.get("/setup/openwa/status")).json()).toMatchObject({ dashboardUrl: null });
  });
});
