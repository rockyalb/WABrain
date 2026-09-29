import {
  countActiveDevices,
  dailyModelUsage,
  createOwner,
  createOwnerSession,
  createPairingCode,
  deleteOwnerSession,
  findOwnerSession,
  getAutoCreateStatus,
  getOwner,
  getSettings,
  historyImportCoverage,
  isTrialActive,
  latestHeartbeat,
  listActiveDevices,
  listProviderSettings,
  cancelHistoryImport,
  randomSecret,
  revokeDevice,
  saveProviderSettings,
  startHistoryImport,
  sha256Hex,
  trialEndsAt,
  updateSettings,
  wipeAllData,
  type Db,
} from "@wabrain/db";
import { configSecrets, listFailedJobs, resolveProviders, testProviderRoles, type ResolvedProviders } from "@wabrain/jobs";
import {
  getOpenWaStatus,
  OpenWaRateLimitedError,
  OpenWaReadClient,
  OpenWaSetupClient,
  scanStoredHistoryCoverage,
  testOpenWaReadAccess,
} from "@wabrain/openwa-adapter";
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDeps, AppEnv } from "../deps.js";
import { audit, notifySync } from "../http/audit.js";
import { HttpError } from "../http/errors.js";
import {
  BootstrapRequestSchema,
  FailedJobsQuerySchema,
  PasswordRequestSchema,
  UsageQuerySchema,
  ProviderTestRequestSchema,
  UpdatePolicyRequestSchema,
  UpdateProvidersRequestSchema,
  WipeRequestSchema,
} from "../http/schemas.js";
import { jsonBody, queryParams } from "../http/validate.js";
import { fetchOpenAiCosts } from "../openai-costs.js";
import { ownerAuth, SESSION_COOKIE } from "../middleware/auth.js";
import { rateLimit } from "../middleware/common.js";
import { idempotency } from "../middleware/idempotency.js";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../security/passwords.js";
import { RATE_LIMITS } from "../security/rate-limit.js";

export const PAIRING_CODE_TTL_MS = 10 * 60_000;
const WORKER_STALE_MS = 2 * 60_000;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(sha256Hex(a));
  const right = Buffer.from(sha256Hex(b));
  return timingSafeEqual(left, right);
}

async function startSession(deps: AppDeps, c: Context<AppEnv>) {
  const token = randomSecret(32);
  const expiresAt = new Date(deps.now().getTime() + deps.config.sessionTtlMs);
  await createOwnerSession(deps.database.db, sha256Hex(token), expiresAt);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    expires: expiresAt,
  });
}

/** A provider test makes real (billed) model calls: a small burst, then one every 10 s. */
const PROVIDER_TEST_LIMIT = { capacity: 6, refillPerSecond: 1 / 10 };
const PROVIDER_TEST_TIMEOUT_MS = 20_000;

/** Stored settings merged with the environment, exactly as the worker's provider registry sees them. */
async function resolveProviderSettings(deps: AppDeps, db: Db = deps.database.db): Promise<ResolvedProviders> {
  return resolveProviders(await listProviderSettings(db), deps.providerEnv, deps.config.encryptionKey);
}

/** The GET/PUT /setup/providers body. Never contains API keys: `roles` only carries `hasApiKey`. */
function providersView(deps: AppDeps, resolved: ResolvedProviders) {
  return { providers: resolved.roles, encryptionConfigured: deps.config.encryptionKey !== null, error: resolved.error };
}

/** Each OpenWA test makes a handful of GET requests to OpenWA: a small burst, then one every 5 s. */
const OPENWA_TEST_LIMIT = { capacity: 6, refillPerSecond: 1 / 5 };
const OPENWA_STATUS_LIMIT = { capacity: 30, refillPerSecond: 1 };
const HISTORY_COVERAGE_LIMIT = { capacity: 3, refillPerSecond: 1 / 60 };
const HISTORY_START_LIMIT = { capacity: 2, refillPerSecond: 1 / 60 };
const OPENWA_NOT_CONFIGURED = "OpenWA is not configured: set OPENWA_BASE_URL and OPENWA_READ_API_KEY";

/** The GET-only OpenWA client with the read key, or null when OpenWA is not configured. */
function openWaClient(deps: AppDeps): OpenWaSetupClient | null {
  const { openwaBaseUrl, openwaReadApiKey } = deps.config;
  return openwaBaseUrl && openwaReadApiKey ? new OpenWaSetupClient({ baseUrl: openwaBaseUrl, apiKey: openwaReadApiKey }) : null;
}

/** The OpenWA dashboard's sessions page, where the owner starts the session and scans the QR code. */
function openWaDashboardUrl(deps: AppDeps): string | null {
  return deps.config.openwaDashboardUrl ? `${deps.config.openwaDashboardUrl}/sessions` : null;
}

/** Owner setup API: login, pairing codes, devices, policy, wipe. */
export function setupRoutes(deps: AppDeps) {
  const coverageScanLimiter = deps.rateLimiters("history-coverage", HISTORY_COVERAGE_LIMIT);
  const app = new Hono<AppEnv>();
  const { database } = deps;

  app.post("/bootstrap", rateLimit(deps, "login", RATE_LIMITS.login), async (c) => {
    if (deps.config.bootstrapToken) {
      const supplied = c.req.header("x-setup-token") ?? "";
      if (!safeEqual(supplied, deps.config.bootstrapToken)) throw new HttpError("unauthorized", "Invalid setup token");
    }
    const { password } = await jsonBody(c, BootstrapRequestSchema);
    const created = await createOwner(database.db, await hashPassword(password));
    if (!created) throw new HttpError("conflict", "The owner account already exists");
    c.set("principal", "owner");
    await audit(deps, c, { action: "owner.bootstrap" });
    await startSession(deps, c);
    return c.json({ ok: true }, 201);
  });

  app.post("/login", rateLimit(deps, "login", RATE_LIMITS.login), async (c) => {
    const { password } = await jsonBody(c, PasswordRequestSchema);
    const owner = await getOwner(database.db);
    const valid = await verifyPassword(password, owner?.passwordHash ?? (await DUMMY_HASH_PROMISE));
    if (!owner) throw new HttpError("conflict", "No owner account yet; call /setup/bootstrap first");
    if (!valid) {
      await audit(deps, c, { action: "owner.login_failed" });
      throw new HttpError("unauthorized", "Invalid password");
    }
    c.set("principal", "owner");
    await startSession(deps, c);
    await audit(deps, c, { action: "owner.login" });
    return c.json({ ok: true });
  });

  app.get("/session", async (c) => {
    const owner = await getOwner(database.db);
    const token = getCookie(c, SESSION_COOKIE);
    const session = owner && token ? await findOwnerSession(database.db, sha256Hex(token), deps.now()) : null;
    return c.json({
      ownerExists: Boolean(owner),
      authenticated: Boolean(session),
      bootstrapTokenRequired: Boolean(deps.config.bootstrapToken),
    });
  });

  // Everything below requires the owner session.
  app.use("*", ownerAuth(deps), idempotency(deps));

  app.post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteOwnerSession(database.db, sha256Hex(token));
    deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
    await audit(deps, c, { action: "owner.logout" });
    return c.json({ ok: true });
  });

  app.get("/status", async (c) => {
    const databaseOk = await database.sql`select 1`.then(
      () => true,
      () => false,
    );
    const [settings, heartbeat, devices, providers] = await Promise.all([
      getSettings(database.db),
      latestHeartbeat(database.db),
      countActiveDevices(database.db),
      resolveProviderSettings(deps),
    ]);
    const now = deps.now();
    const autoCreate = await getAutoCreateStatus(database.db, {
      inTrial: isTrialActive(settings, now),
      autoCreateThreshold: settings.autoCreateThreshold,
    });
    return c.json({
      database: { ok: databaseOk },
      worker: {
        ok: Boolean(heartbeat && now.getTime() - heartbeat.getTime() < WORKER_STALE_MS),
        lastSeenAt: heartbeat?.toISOString() ?? null,
      },
      openwa: { configured: deps.config.openwaConfigured },
      providers: { configured: Object.entries(providers.roles).flatMap(([role, view]) => (view ? [role] : [])) },
      trial: {
        active: isTrialActive(settings, now),
        startedAt: settings.trialStartedAt,
        endsAt: trialEndsAt(settings).toISOString(),
        days: settings.trialDays,
      },
      autoCreate,
      devices: { count: devices },
    });
  });

  app.post("/pairing-codes", async (c) => {
    const code = randomSecret(32);
    const expiresAt = new Date(deps.now().getTime() + PAIRING_CODE_TTL_MS);
    await createPairingCode(database.db, sha256Hex(code), expiresAt);
    await audit(deps, c, { action: "pairing.code_created" });
    const qrPayload = `wabrain://pair?server=${encodeURIComponent(deps.config.publicBaseUrl)}&code=${code}`;
    return c.json({ qrPayload, expiresAt: expiresAt.toISOString() }, 201);
  });

  app.get("/devices", async (c) => {
    const devices = await listActiveDevices(database.db);
    return c.json({
      items: devices.map((device) => ({
        id: device.id,
        name: device.name,
        createdAt: device.createdAt.toISOString(),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      })),
    });
  });

  app.delete("/devices/:id", async (c) => {
    const id = c.req.param("id");
    await database.transaction(async ({ db }) => {
      await revokeDevice(db, id, deps.now());
      await audit(deps, c, { action: "device.revoked", targetType: "device", targetId: id }, db);
    });
    return c.body(null, 204);
  });

  app.patch("/policy", async (c) => {
    const patch = await jsonBody(c, UpdatePolicyRequestSchema);
    const settings = await updateSettings(database.db, patch);
    await audit(deps, c, { action: "policy.changed", details: patch });
    await notifySync(deps);
    return c.json(settings);
  });

  app.post("/wipe", async (c) => {
    await jsonBody(c, WipeRequestSchema);
    const { keptOffChats } = await wipeAllData(database);
    await audit(deps, c, { action: "data.wiped", details: { keptOffChats } });
    await notifySync(deps);
    return c.json({ ok: true });
  });

  // Model providers. API keys are write-only: accepted by PUT, encrypted at rest, never returned.
  // Read-only failure inspection; retrying stays a deliberate operator command (docs/OPERATIONS.md).
  app.get("/jobs/failures", async (c) => c.json(await listFailedJobs(database, queryParams(c, FailedJobsQuerySchema))));

  app.get("/providers", async (c) => c.json(providersView(deps, await resolveProviderSettings(deps))));

  // Usage per model and day, with OpenAI's own daily costs when an admin key is configured.
  app.get("/usage", async (c) => {
    const days = queryParams(c, UsageQuerySchema).days ?? 30;
    const today = new Date(Date.UTC(deps.now().getUTCFullYear(), deps.now().getUTCMonth(), deps.now().getUTCDate()));
    const since = new Date(today.getTime() - (days - 1) * 86_400_000);
    const [usage, costs] = await Promise.all([
      dailyModelUsage(database.db, since),
      fetchOpenAiCosts({ access: deps.config.openaiCosts, since, days }),
    ]);
    return c.json({ since: since.toISOString(), days, usage, costs });
  });

  app.put("/providers", async (c) => {
    const changes = await jsonBody(c, UpdateProvidersRequestSchema);
    const resolved = await database.transaction(async ({ db }) => {
      const summary = await saveProviderSettings(db, deps.config.encryptionKey, changes);
      // What changed, never the key: `apiKey` is "set" | "cleared" | "kept" | "none".
      await audit(deps, c, { action: "providers.changed", details: { changes: summary } }, db);
      return resolveProviderSettings(deps, db);
    });
    // The worker's provider registry notices the changed rows on its next job; no restart needed.
    return c.json(providersView(deps, resolved));
  });

  app.post("/providers/test", rateLimit(deps, "provider-test", PROVIDER_TEST_LIMIT), async (c) => {
    const { roles } = await jsonBody(c, ProviderTestRequestSchema);
    const resolved = await resolveProviderSettings(deps);
    if (!resolved.config) throw new HttpError("conflict", resolved.error ?? "No providers are configured");
    let providers;
    try {
      providers = deps.providerFactory(resolved.config);
    } catch {
      throw new HttpError("conflict", "Could not create the configured providers");
    }
    const results = await testProviderRoles(providers, {
      roles,
      timeoutMs: PROVIDER_TEST_TIMEOUT_MS,
      secrets: configSecrets(resolved.config),
    });
    await audit(deps, c, {
      action: "providers.tested",
      details: { results: Object.fromEntries(Object.entries(results).map(([role, result]) => [role, result.ok])) },
    });
    return c.json({ results });
  });

  // OpenWA connection. Only GET requests with the read-only key; nothing is sent to WhatsApp.
  const openWaStatusLimit = rateLimit(deps, "openwa-status", OPENWA_STATUS_LIMIT);

  app.get("/openwa/status", openWaStatusLimit, async (c) => {
    const client = openWaClient(deps);
    const sessionId = deps.config.openwaSessionId;
    const base = {
      configured: client !== null,
      sessionId,
      dashboardUrl: openWaDashboardUrl(deps),
      webhookUrl: `${deps.config.publicBaseUrl}/webhooks/openwa`,
    };
    if (!client) {
      return c.json({
        ...base,
        reachable: false,
        paired: false,
        session: null,
        sessions: [],
        error: { code: "not_configured", message: OPENWA_NOT_CONFIGURED },
      });
    }
    const report = await getOpenWaStatus(client, sessionId);
    return c.json({ ...base, ...report, paired: report.session?.status === "ready" });
  });

  app.post("/openwa/test", rateLimit(deps, "openwa-test", OPENWA_TEST_LIMIT), async (c) => {
    const client = openWaClient(deps);
    if (!client) throw new HttpError("conflict", OPENWA_NOT_CONFIGURED);
    const sessionId = deps.config.openwaSessionId;
    if (!sessionId) throw new HttpError("conflict", "Set OPENWA_SESSION_ID to the id of the OpenWA session to read");
    const report = await testOpenWaReadAccess(client, sessionId);
    await audit(deps, c, {
      action: "openwa.tested",
      details: { ok: report.ok, checks: Object.fromEntries(report.checks.map((check) => [check.id, check.level])) },
    });
    return c.json(report);
  });

  // OpenWA serves the QR code only to operator keys, which can also send messages. WABrain
  // holds a viewer key, so this route points at the OpenWA dashboard instead of proxying the code.
  app.get("/openwa/qr", openWaStatusLimit, async (c) => {
    const client = openWaClient(deps);
    const sessionId = deps.config.openwaSessionId;
    const status = client && sessionId ? ((await getOpenWaStatus(client, sessionId)).session?.status ?? null) : null;
    const dashboardUrl = openWaDashboardUrl(deps);
    const paired = status === "ready";
    const message = paired
      ? "WhatsApp is already linked; no QR code is needed."
      : dashboardUrl
        ? "Open the OpenWA dashboard, start the session, and scan its QR code with WhatsApp (Settings, Linked devices, Link a device)."
        : "Open the OpenWA dashboard (set OPENWA_DASHBOARD_URL to link to it here), start the session, and scan its QR code with WhatsApp.";
    return c.json({ mode: "dashboard" as const, dashboardUrl, sessionId, sessionStatus: status, paired, message });
  });

  app.get("/import/coverage", async (c) => {
    const sessionId = deps.config.openwaSessionId;
    if (!sessionId) throw new HttpError("conflict", "Set OPENWA_SESSION_ID before checking history coverage");
    const local = await historyImportCoverage(database.db, sessionId);
    if (local.run || !deps.config.openwaBaseUrl || !deps.config.openwaReadApiKey) return c.json(local);
    // Only the OpenWA scan is throttled; the local report above is a cheap database read.
    const allowed = await coverageScanLimiter.take(`history-coverage:${c.get("clientIp")}`);
    if (!allowed.allowed) throw new HttpError("rate_limited", "Wait before scanning OpenWA history again", { "Retry-After": String(allowed.retryAfterSeconds) });
    // An interactive request: wait out only short throttling, then tell the page when to retry.
    const source = new OpenWaReadClient(deps.config.openwaBaseUrl, deps.config.openwaReadApiKey, { maxWaitMs: 5_000 });
    try {
      const items = await scanStoredHistoryCoverage(source, sessionId, new Date(deps.now().getTime() - 90 * 86_400_000));
      return c.json({ items, run: null });
    } catch (error) {
      if (!(error instanceof OpenWaRateLimitedError)) throw error;
      throw new HttpError("rate_limited", "OpenWA is rate limiting history reads; try again shortly", { "Retry-After": String(error.retryAfterSeconds) });
    }
  });

  app.post("/import", rateLimit(deps, "history-start", HISTORY_START_LIMIT), async (c) => {
    const sessionId = deps.config.openwaSessionId;
    if (!openWaClient(deps) || !sessionId) throw new HttpError("conflict", "OpenWA read access and OPENWA_SESSION_ID are required for import");
    const { days } = await jsonBody(c, z.object({ days: z.number().int().min(1).max(90) }));
    const run = await database.transaction(async ({ db, sql }) => {
      const started = await startHistoryImport(db, sessionId, days, deps.now());
      await deps.queue.enqueue("import-history", { sessionId }, { singletonKey: sessionId, tx: sql });
      return started;
    });
    await audit(deps, c, { action: "history_import.started", details: { days } });
    return c.json({ run: { status: run.status, startedAt: run.startedAt.toISOString() } }, 202);
  });

  app.delete("/import", async (c) => {
    const sessionId = deps.config.openwaSessionId;
    if (!sessionId) throw new HttpError("conflict", "Set OPENWA_SESSION_ID before cancelling import");
    const run = await cancelHistoryImport(database.db, sessionId);
    await audit(deps, c, { action: "history_import.cancelled", details: { active: run?.status === "cancelled" } });
    return c.json({ run: run ? { status: run.status, finishedAt: run.finishedAt?.toISOString() ?? null } : null });
  });

  return app;
}
