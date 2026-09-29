import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieFrom, createHarness, PUBLIC_BASE_URL, realLimits, type Harness } from "./test/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ worker: false });
});
afterAll(async () => {
  await h.close();
});

describe("owner and device authentication", () => {
  let cookie = "";
  let token = "";
  let deviceId = "";
  let code = "";

  it("keeps /health public and everything else closed", async () => {
    expect(await (await h.request("/health")).json()).toEqual({ ok: true });
    expect(await (await h.request("/setup/session")).json()).toEqual({
      ownerExists: false,
      authenticated: false,
      bootstrapTokenRequired: false,
    });
    for (const path of ["/v1/tasks", "/v1/sync", "/v1/chats", "/v1/people", "/v1/chats/x/messages", "/v1/nope"]) {
      const response = await h.request(path);
      expect(response.status, path).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
    expect((await h.request("/v1/tasks", { headers: { authorization: "Bearer not-a-real-token-at-all-000" } })).status).toBe(401);
    expect((await h.request("/setup/status")).status).toBe(401);
  });

  it("bootstraps the owner exactly once", async () => {
    expect((await h.request("/setup/login", { method: "POST", json: { password: "whatever-password" } })).status).toBe(409);
    expect((await h.request("/setup/bootstrap", { method: "POST", json: { password: "short" } })).status).toBe(400);
    const boot = await h.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } });
    expect(boot.status).toBe(201);
    const setCookie = boot.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect((await h.request("/setup/bootstrap", { method: "POST", json: { password: "another long password" } })).status).toBe(409);
  });

  it("logs in with the password and rejects a wrong one", async () => {
    expect((await h.request("/setup/login", { method: "POST", json: { password: "wrong password!!" } })).status).toBe(401);
    const login = await h.request("/setup/login", { method: "POST", json: { password: "correct horse battery staple" } });
    expect(login.status).toBe(200);
    cookie = cookieFrom(login);
    const status = await h.request("/setup/status", { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      database: { ok: true },
      trial: { active: true, days: 7 },
      autoCreate: { state: "trial", calibration: { ready: false } },
      devices: { count: 0 },
    });
    expect(await (await h.request("/setup/session", { headers: { cookie } })).json()).toMatchObject({
      ownerExists: true,
      authenticated: true,
    });
  });

  it("issues a one-time pairing QR payload in the documented format", async () => {
    const response = await h.request("/setup/pairing-codes", { method: "POST", headers: { cookie } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { qrPayload: string; expiresAt: string };
    expect(body.qrPayload).toMatch(/^wabrain:\/\/pair\?server=https%3A%2F%2Fbrain\.example\.com&code=[A-Za-z0-9_-]{32,}$/);
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    code = new URL(body.qrPayload.replace("wabrain://", "https://x/")).searchParams.get("code")!;
    expect(decodeURIComponent(body.qrPayload.split("server=")[1]!.split("&")[0]!)).toBe(PUBLIC_BASE_URL);
  });

  it("pairs a device, authorizes it, and refuses code reuse", async () => {
    const paired = await h.request("/v1/devices/pair", { method: "POST", json: { code, deviceName: "Pixel 9" } });
    expect(paired.status).toBe(201);
    ({ token, deviceId } = (await paired.json()) as { token: string; deviceId: string });
    const sync = await h.request("/v1/sync", { headers: { authorization: `Bearer ${token}` } });
    expect(sync.status).toBe(200);
    expect(await sync.json()).toMatchObject({ full: true, tasks: [], settings: { timezone: "UTC" } });

    const reuse = await h.request("/v1/devices/pair", { method: "POST", json: { code, deviceName: "Attacker" } });
    expect(reuse.status).toBe(401);

    const devices = await h.request("/setup/devices", { headers: { cookie } });
    expect(((await devices.json()) as { items: { id: string; lastSeenAt: string | null }[] }).items).toEqual([
      expect.objectContaining({ id: deviceId, name: "Pixel 9" }),
    ]);
  });

  it("rejects a revoked device token", async () => {
    expect((await h.request(`/setup/devices/${deviceId}`, { method: "DELETE", headers: { cookie } })).status).toBe(204);
    expect((await h.request("/v1/sync", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("lets a device unpair itself", async () => {
    const pairing = await h.request("/setup/pairing-codes", { method: "POST", headers: { cookie } });
    const qr = ((await pairing.json()) as { qrPayload: string }).qrPayload;
    const second = await h.request("/v1/devices/pair", {
      method: "POST",
      json: { code: new URL(qr.replace("wabrain://", "https://x/")).searchParams.get("code"), deviceName: "Tablet" },
    });
    const { token: tabletToken } = (await second.json()) as { token: string };
    const auth = { authorization: `Bearer ${tabletToken}` };
    expect((await h.request("/v1/devices/self", { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await h.request("/v1/tasks", { headers: auth })).status).toBe(401);
  });

  it("rejects cross-origin setup requests and only allows the setup origin in CORS", async () => {
    const evil = await h.request("/setup/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      json: { password: "correct horse battery staple" },
    });
    expect(evil.status).toBe(403);
    const preflight = await h.request("/setup/login", {
      method: "OPTIONS",
      headers: { origin: PUBLIC_BASE_URL, "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(PUBLIC_BASE_URL);
    const other = await h.request("/setup/login", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const v1 = await h.request("/v1/sync", { method: "OPTIONS", headers: { origin: PUBLIC_BASE_URL } });
    expect(v1.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets security headers and requires an OpenWA session for import", async () => {
    const response = await h.request("/health");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await h.request("/setup/import/coverage", { headers: { cookie } })).status).toBe(409);
    expect((await h.request("/setup/import", { method: "POST", headers: { cookie } })).status).toBe(409);
  });

  it("logs out", async () => {
    expect((await h.request("/setup/logout", { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await h.request("/setup/status", { headers: { cookie } })).status).toBe(401);
    expect(await (await h.request("/setup/session", { headers: { cookie } })).json()).toMatchObject({
      ownerExists: true,
      authenticated: false,
    });
  });
});

describe("rate limiting", () => {
  it("limits login attempts per client", async () => {
    const limited = await createHarness({ worker: false, rateLimiters: realLimits });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        statuses.push((await limited.request("/setup/login", { method: "POST", json: { password: "nope-nope-nope" } })).status);
      }
      expect(statuses.slice(0, 5).every((status) => status !== 429)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it("requires the bootstrap token when one is configured", async () => {
    const guarded = await createHarness({ worker: false, env: { SETUP_BOOTSTRAP_TOKEN: "Bootstrap-Token-For-Tests-0123456789abc" } });
    try {
      const body = { password: "correct horse battery staple" };
      expect((await guarded.request("/setup/bootstrap", { method: "POST", json: body })).status).toBe(401);
      const ok = await guarded.request("/setup/bootstrap", {
        method: "POST",
        headers: { "x-setup-token": "Bootstrap-Token-For-Tests-0123456789abc" },
        json: body,
      });
      expect(ok.status).toBe(201);
    } finally {
      await guarded.close();
    }
  });
});
