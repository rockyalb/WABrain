/**
 * Startup configuration, validated with Zod. The API refuses to start with
 * missing or weak secrets (fail closed).
 */
import { EncryptionKeyError, parseEncryptionKey } from "@wabrain/db";
import { z } from "zod";

const WEAK_MARKERS = /(replace|change[-_]?me|example|secret123|password|default)/i;

/** A secret of at least `min` characters that does not look like a placeholder. */
export const strongSecret = (min = 32) =>
  z
    .string()
    .min(min, `must be at least ${min} characters`)
    .refine((value) => !WEAK_MARKERS.test(value), "looks like a placeholder")
    .refine((value) => new Set(value).size >= 12, "has too little variety to be random");

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .optional()
    .transform((value) => (value === undefined ? fallback : ["true", "1", "yes"].includes(value)));

const csv = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).optional(),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    /** Public HTTPS base URL of this API; goes into the device pairing QR code. */
    PUBLIC_BASE_URL: z.url(),
    /** Origin of the setup page, the only origin allowed by CORS. Defaults to PUBLIC_BASE_URL's origin. */
    SETUP_ORIGIN: z.url().optional(),
    OPENWA_WEBHOOK_SECRET: strongSecret(32),
    /** When set, webhooks for any other OpenWA session are rejected. */
    OPENWA_SESSION_ID: z.string().min(1).optional(),
    OPENWA_BASE_URL: z.url().optional(),
    OPENWA_READ_API_KEY: z.string().min(1).optional(),
    /**
     * Browser address of the OpenWA dashboard, where the owner scans the WhatsApp QR code. Defaults
     * to OPENWA_BASE_URL when that is https (an internal http address is not reachable from a browser).
     */
    OPENWA_DASHBOARD_URL: z.url({ protocol: /^https?$/ }).optional(),
    /** Owner JIDs (comma-separated) used by the default intake filter to detect mentions. */
    SELF_JID: csv,
    SELF_ALIASES: csv,
    /** Optional extra secret required by POST /setup/bootstrap (header X-Setup-Token). */
    SETUP_BOOTSTRAP_TOKEN: strongSecret(32).optional(),
    /** Hostname of a self-hosted ntfy server; exempt from the push SSRF private-address check. */
    NTFY_HOST: z.string().min(1).optional(),
    /**
     * 32 random bytes (base64 or hex) that encrypt the model provider API keys stored from the
     * setup page. Optional for env-only installs; without it the API refuses to store keys.
     */
    APP_ENCRYPTION_KEY: z.string().optional(),
    /**
     * Optional OpenAI Admin key (read-only "Usage" scope is enough) for the setup page's daily cost
     * breakdown from OpenAI's Costs API. It is never returned by the API.
     */
    OPENAI_ADMIN_KEY: z.string().min(1).optional(),
    /** Limits that breakdown to one OpenAI project (e.g. a project only WABrain uses). */
    OPENAI_COSTS_PROJECT_ID: z.string().min(1).optional(),
    /** Trust X-Forwarded-For for client IPs (behind Railway or a reverse proxy). */
    TRUST_PROXY: bool(false),
    RUN_MIGRATIONS: bool(true),
    /** Run the job worker inside the API process (small installs). */
    EMBEDDED_WORKER: bool(false),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((env, ctx) => {
    const url = new URL(env.PUBLIC_BASE_URL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && local)) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must be https (http only for localhost in development)" });
    }
    if (env.APP_ENCRYPTION_KEY !== undefined) {
      try {
        parseEncryptionKey(env.APP_ENCRYPTION_KEY);
      } catch (error) {
        if (!(error instanceof EncryptionKeyError)) throw error;
        ctx.addIssue({ code: "custom", path: ["APP_ENCRYPTION_KEY"], message: error.message.replace(/^APP_ENCRYPTION_KEY /, "") });
      }
    }
  });

export interface AppConfig {
  env: "development" | "production" | "test";
  host: string;
  port: number;
  databaseUrl: string;
  publicBaseUrl: string;
  setupOrigin: string;
  webhookSecret: string;
  openwaSessionId: string | null;
  openwaConfigured: boolean;
  /** OPENWA_BASE_URL without a trailing slash, or null. */
  openwaBaseUrl: string | null;
  /** The session-scoped, read-only (viewer) OpenWA key. Never returned or logged. */
  openwaReadApiKey: string | null;
  /** Where the owner opens the OpenWA dashboard to pair WhatsApp, or null when unknown. */
  openwaDashboardUrl: string | null;
  selfJids: string[];
  selfAliases: string[];
  bootstrapToken: string | null;
  ntfyHost: string | null;
  /** Parsed APP_ENCRYPTION_KEY, or null when unset (provider API keys then cannot be stored). */
  encryptionKey: Buffer | null;
  trustProxy: boolean;
  runMigrations: boolean;
  embeddedWorker: boolean;
  sessionTtlMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
  /** OpenAI Costs API access for the usage page; null when no admin key is set. */
  openaiCosts: { adminKey: string; projectId: string | null } | null;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Empty values (e.g. "OPENWA_SESSION_ID=" in an env file) count as unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    // Never echo values: only variable names and reasons.
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`));
  }
  const value = parsed.data;
  const publicBaseUrl = value.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const openwaBaseUrl = value.OPENWA_BASE_URL?.replace(/\/+$/, "") ?? null;
  const openwaDashboardUrl =
    value.OPENWA_DASHBOARD_URL?.replace(/\/+$/, "") ?? (openwaBaseUrl?.startsWith("https://") ? openwaBaseUrl : null);
  return {
    env: value.NODE_ENV,
    host: value.HOST,
    port: value.API_PORT ?? value.PORT ?? 8787,
    databaseUrl: value.DATABASE_URL,
    publicBaseUrl,
    setupOrigin: new URL(value.SETUP_ORIGIN ?? publicBaseUrl).origin,
    webhookSecret: value.OPENWA_WEBHOOK_SECRET,
    openwaSessionId: value.OPENWA_SESSION_ID ?? null,
    openwaConfigured: Boolean(value.OPENWA_BASE_URL && value.OPENWA_READ_API_KEY),
    openwaBaseUrl,
    openwaReadApiKey: value.OPENWA_READ_API_KEY ?? null,
    openwaDashboardUrl,
    selfJids: value.SELF_JID,
    selfAliases: value.SELF_ALIASES,
    bootstrapToken: value.SETUP_BOOTSTRAP_TOKEN ?? null,
    ntfyHost: value.NTFY_HOST?.toLowerCase() ?? null,
    encryptionKey: value.APP_ENCRYPTION_KEY ? parseEncryptionKey(value.APP_ENCRYPTION_KEY) : null,
    trustProxy: value.TRUST_PROXY,
    runMigrations: value.RUN_MIGRATIONS,
    embeddedWorker: value.EMBEDDED_WORKER,
    sessionTtlMs: value.SESSION_TTL_HOURS * 3_600_000,
    logLevel: value.LOG_LEVEL,
    openaiCosts: value.OPENAI_ADMIN_KEY ? { adminKey: value.OPENAI_ADMIN_KEY, projectId: value.OPENAI_COSTS_PROJECT_ID ?? null } : null,
  };
}
