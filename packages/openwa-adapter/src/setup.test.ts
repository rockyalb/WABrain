import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getOpenWaStatus, OpenWaSetupClient, testOpenWaReadAccess } from "./setup.js";
import { startFakeOpenWa, type FakeOpenWa } from "./testing/fake-openwa.js";

const SESSION = "0a941dac-a965-45e7-b318-74ae8be134f0";
const OTHER = "7b1f7a52-3a53-4f2c-9d43-0d6f5a0c9e11";

let fake: FakeOpenWa;

beforeAll(async () => {
  fake = await startFakeOpenWa({
    storedMessages: 1234,
    keys: {
      viewer: { role: "viewer", allowedSessions: [SESSION] },
      "viewer-unscoped": { role: "viewer" },
      operator: { role: "operator", allowedSessions: [SESSION] },
      "chat-limited": { role: "viewer", allowedSessions: [SESSION], allowedChats: ["447690000001@s.whatsapp.net"] },
      "other-session": { role: "viewer", allowedSessions: [OTHER] },
    },
  });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.sessions = [
    { id: SESSION, name: "brain", status: "ready", phone: "447690000000", pushName: "Alex" },
    { id: OTHER, name: "other-app", status: "ready" },
  ];
  fake.delayMs = 0;
});

const client = (apiKey: string, options: { timeoutMs?: number } = {}) => new OpenWaSetupClient({ baseUrl: `${fake.url}/`, apiKey, ...options });
const byId = <T extends { id: string }>(checks: T[]): Record<string, T | undefined> => Object.fromEntries(checks.map((check) => [check.id, check]));

describe("getOpenWaStatus", () => {
  it("reports a linked session", async () => {
    fake.sessions = [{ id: SESSION, name: "brain", status: "ready", phone: "447690000000", pushName: "Alex" }];
    const report = await getOpenWaStatus(client("viewer"), SESSION);
    expect(report).toMatchObject({
      reachable: true,
      error: null,
      session: { id: SESSION, name: "brain", status: "ready", pushName: "Alex", phone: "447690000000", engineLoaded: true },
    });
  });

  it("reports an unpaired session with its state", async () => {
    fake.sessions = [{ id: SESSION, name: "brain", status: "qr_ready" }];
    const report = await getOpenWaStatus(client("viewer"), SESSION);
    expect(report.session?.status).toBe("qr_ready");
  });

  it("explains key, session id, and connection problems without leaking the key", async () => {
    fake.sessions = [{ id: SESSION, name: "brain", status: "ready" }];
    expect((await getOpenWaStatus(client("wrong-key-value"), SESSION)).error?.code).toBe("unauthorized");
    expect((await getOpenWaStatus(client("other-session"), SESSION)).error?.code).toBe("unauthorized");
    expect((await getOpenWaStatus(client("viewer-unscoped"), "brain")).error?.code).toBe("invalid_session_id");
    expect((await getOpenWaStatus(client("viewer-unscoped"), OTHER)).error?.code).toBe("session_not_found");

    const down = await getOpenWaStatus(new OpenWaSetupClient({ baseUrl: "http://127.0.0.1:1", apiKey: "viewer" }), SESSION);
    expect(down).toMatchObject({ reachable: false, session: null, error: { code: "unreachable" } });
    expect(JSON.stringify(down)).not.toContain("viewer");
  });

  it("times out instead of hanging", async () => {
    fake.delayMs = 500;
    const report = await getOpenWaStatus(client("viewer", { timeoutMs: 100 }), SESSION);
    expect(report).toMatchObject({ reachable: false, error: { code: "timeout" } });
  });

  it("lists the sessions the key can see when no session id is configured", async () => {
    const report = await getOpenWaStatus(client("viewer"), null);
    expect(report.error?.code).toBe("no_session_id");
    expect(report.sessions).toEqual([{ id: SESSION, name: "brain", status: "ready" }]);
  });
});

describe("testOpenWaReadAccess", () => {
  it("passes every check for a session-scoped viewer key", async () => {
    const report = await testOpenWaReadAccess(client("viewer"), SESSION);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => [check.id, check.level])).toEqual([
      ["reachable", "ok"],
      ["session", "ok"],
      ["linked", "ok"],
      ["chats", "ok"],
      ["messages", "ok"],
      ["role", "ok"],
      ["session_scope", "ok"],
    ]);
    expect(byId(report.checks).messages!.detail).toContain("1234");
    // Nothing from OpenWA's bodies (message text, webhook secrets) is passed through.
    expect(JSON.stringify(report)).not.toMatch(/private message body|whsec/);
  });

  it("warns about an operator key and a key that sees other sessions", async () => {
    const operator = byId((await testOpenWaReadAccess(client("operator"), SESSION)).checks);
    expect(operator.role).toMatchObject({ ok: true, level: "warn" });
    expect(operator.role!.detail).toMatch(/could send messages/);

    const unscoped = await testOpenWaReadAccess(client("viewer-unscoped"), SESSION);
    expect(unscoped.ok).toBe(true);
    expect(byId(unscoped.checks).session_scope).toMatchObject({ level: "warn" });
    expect(byId(unscoped.checks).session_scope!.detail).toMatch(/1 other session/);
  });

  it("fails the history check for a chat-limited key", async () => {
    const report = await testOpenWaReadAccess(client("chat-limited"), SESSION);
    expect(report.ok).toBe(false);
    expect(byId(report.checks).messages).toMatchObject({ ok: false, level: "error" });
    expect(byId(report.checks).messages!.detail).toMatch(/chat allowlist/);
  });

  it("fails when WhatsApp is not linked yet", async () => {
    fake.sessions = [{ id: SESSION, name: "brain", status: "qr_ready" }];
    const report = byId((await testOpenWaReadAccess(client("viewer"), SESSION)).checks);
    expect(report.linked).toMatchObject({ ok: false });
    expect(report.linked!.detail).toMatch(/QR code/);
    expect(report.chats).toMatchObject({ ok: false });
    expect(report.chats!.detail).toMatch(/not ready/);
  });

  it("stops at the first failing prerequisite", async () => {
    const wrongKey = await testOpenWaReadAccess(client("nope"), SESSION);
    expect(wrongKey.checks.map((check) => check.id)).toEqual(["reachable", "session"]);
    expect(wrongKey.ok).toBe(false);

    const down = await testOpenWaReadAccess(new OpenWaSetupClient({ baseUrl: "http://127.0.0.1:1", apiKey: "viewer" }), SESSION);
    expect(down.checks.map((check) => check.id)).toEqual(["reachable"]);
  });

  it("only ever issues GET requests and never asks for the QR code", async () => {
    fake.requests.length = 0;
    await getOpenWaStatus(client("operator"), SESSION);
    await getOpenWaStatus(client("operator"), null);
    await testOpenWaReadAccess(client("operator"), SESSION);
    expect(fake.requests.length).toBeGreaterThan(5);
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
    expect(fake.requests.some((request) => request.path.includes("/qr"))).toBe(false);
  });
});

describe("OpenWaSetupClient", () => {
  it("exposes no WhatsApp write operation", () => {
    const methods = Object.getOwnPropertyNames(OpenWaSetupClient.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(["get", "getSession", "health", "listSessions", "probeChats", "probeOperatorRole", "probeStoredMessages", "session"]);
    const source = readFileSync(fileURLToPath(new URL("./setup.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i);
    expect(source).not.toMatch(/\/(send|react|edit|delete|read|seen|presence|typing|groups?|qr|pairing-code|start|stop|logout)\b/i);
  });
});
