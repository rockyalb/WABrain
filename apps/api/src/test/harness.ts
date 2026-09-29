/** Integration-test harness: isolated database, real job queue + worker, and the Hono app. */
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import type { ChangeEvent } from "@wabrain/db";
import { JobQueue, startWorker } from "@wabrain/jobs";
import { createHmac } from "node:crypto";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import type { AppDeps } from "../deps.js";
import { silentLogger, type Logger } from "../logger.js";
import { buildDeps } from "../runtime.js";
import { TokenBucketLimiter, type RateLimiterFactory } from "../security/rate-limit.js";

export const WEBHOOK_SECRET = "t3st-Webhook-Secret-0123456789-abcdefXYZ";
export const PUBLIC_BASE_URL = "https://brain.example.com";

export const unlimited: RateLimiterFactory = () => ({ take: () => ({ allowed: true, retryAfterSeconds: 0 }) });
export const realLimits: RateLimiterFactory = (_name, policy) => new TokenBucketLimiter(policy);

export interface Harness {
  testDb: TestDatabase;
  deps: AppDeps;
  app: ReturnType<typeof createApp>;
  queue: JobQueue;
  notifications: ChangeEvent[];
  request(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  close(): Promise<void>;
}

export async function createHarness(
  options: {
    env?: Record<string, string>;
    rateLimiters?: RateLimiterFactory;
    worker?: boolean;
    logger?: Logger;
    /** Model provider seams: the AI_* environment (default: none) and a mock provider factory. */
    providerEnv?: Record<string, string | undefined>;
    providerFactory?: AppDeps["providerFactory"];
  } = {},
): Promise<Harness> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: testDb.url,
    PUBLIC_BASE_URL,
    OPENWA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SELF_JID: "447690000000@s.whatsapp.net",
    SELF_ALIASES: "Alex",
    NTFY_HOST: "ntfy.internal",
    ...options.env,
  });
  const queue = new JobQueue({ connectionString: testDb.url, logger: silentLogger });
  await queue.start();
  const notifications: ChangeEvent[] = [];
  const deps = buildDeps(config, options.logger ?? silentLogger, testDb.database, queue, {
    rateLimiters: options.rateLimiters ?? unlimited,
    notifier: { notify: (event) => void notifications.push(event) },
    providerEnv: options.providerEnv ?? {},
    ...(options.providerFactory ? { providerFactory: options.providerFactory } : {}),
  });
  const worker =
    options.worker === false
      ? null
      : await startWorker({ database: testDb.database, queue, filter: deps.intakeFilter, logger: silentLogger, analysisDebounceMs: 60_000 });
  const app = createApp(deps);
  return {
    testDb,
    deps,
    app,
    queue,
    notifications,
    request(path, init = {}) {
      const { json, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (json !== undefined) headers.set("content-type", "application/json");
      return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
    },
    async close() {
      await worker?.stop();
      await queue.stop({ graceful: false, timeoutMs: 1000 });
      await testDb.drop();
    },
  };
}

export function sign(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /(__Host-wabrain_session=[^;]+)/.exec(header);
  if (!match) throw new Error("no session cookie");
  return match[1]!;
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Bootstraps the owner, pairs a device, and returns both credentials. */
export async function ownerAndDevice(harness: Harness): Promise<{ cookie: string; token: string; deviceId: string }> {
  const boot = await harness.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } });
  if (boot.status !== 201) throw new Error(`bootstrap failed: ${boot.status}`);
  const cookie = cookieFrom(boot);
  const pairing = await harness.request("/setup/pairing-codes", { method: "POST", headers: { cookie } });
  const { qrPayload } = (await pairing.json()) as { qrPayload: string };
  const code = new URL(qrPayload.replace("wabrain://", "https://x/")).searchParams.get("code")!;
  const paired = await harness.request("/v1/devices/pair", { method: "POST", json: { code, deviceName: "Pixel" } });
  const { token, deviceId } = (await paired.json()) as { token: string; deviceId: string };
  return { cookie, token, deviceId };
}
