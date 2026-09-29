/**
 * Model provider configuration: owner-stored settings per role (packages/db provider_settings, API
 * key encrypted with APP_ENCRYPTION_KEY) with environment variables as the fallback for roles the
 * owner has not configured. The registry rebuilds the AI SDK models whenever the stored settings
 * change, so the worker picks up new keys without a restart.
 */
import {
  ProvidersConfigSchema,
  createProviders,
  embedTexts,
  providersConfigFromEnv,
  roleConfigFromEnv,
  type Providers,
  type ProvidersConfig,
} from "@wabrain/agent";
import {
  EMBEDDING_DIMENSIONS,
  PROVIDER_ROLES,
  decryptSecret,
  listProviderSettings,
  providerApiKeyAad,
  type Database,
  type ProviderRole,
  type ProviderSettingsRow,
} from "@wabrain/db";
import { generateText, NoTranscriptGeneratedError, transcribe } from "ai";

type Env = Record<string, string | undefined>;

export interface RoleLimits {
  dailyTokenLimit: number | null;
  dailyCallLimit: number | null;
}

/** What the setup page may see about a role: never the API key itself. */
export interface PublicRoleSettings {
  source: "db" | "env";
  provider: string;
  model: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  /**
   * Where the key in use comes from. A stored role without its own key uses the environment's key
   * for the same role when the provider and base URL match (so saving a model change on the setup
   * page does not drop an env-configured key).
   */
  apiKeySource: "db" | "env" | null;
  dimensions: number | null;
  structuredOutputs: boolean | null;
  /** Nullable persisted override. Null inherits the environment value. */
  storedDailyTokenLimit: number | null;
  storedDailyCallLimit: number | null;
  /** Effective values after applying environment fallbacks. */
  dailyTokenLimit: number | null;
  dailyCallLimit: number | null;
}

export interface ResolvedProviders {
  /** Null when the configuration is incomplete or invalid (see error). */
  config: ProvidersConfig | null;
  error: string | null;
  roles: Record<ProviderRole, PublicRoleSettings | null>;
  limits: Record<ProviderRole, RoleLimits>;
}

export const apiKeyAad = providerApiKeyAad;

const intOrNull = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

function envLimits(env: Env, role: ProviderRole): RoleLimits {
  const prefix = `AI_${role.toUpperCase()}`;
  return {
    dailyTokenLimit: intOrNull(env[`${prefix}_DAILY_TOKEN_LIMIT`]),
    dailyCallLimit: intOrNull(env[`${prefix}_DAILY_CALL_LIMIT`]),
  };
}

/**
 * Merges stored rows with the environment. Decrypts stored API keys with `encryptionKey`; a stored
 * key without an encryption key is a configuration error, never a silent fallback.
 */
export function resolveProviders(rows: readonly ProviderSettingsRow[], env: Env, encryptionKey: Buffer | null): ResolvedProviders {
  const byRole = new Map(rows.map((row) => [row.role, row]));
  const config: Record<string, unknown> = {};
  const roles = {} as ResolvedProviders["roles"];
  const limits = {} as ResolvedProviders["limits"];
  const errors: string[] = [];

  for (const role of PROVIDER_ROLES) {
    const row = byRole.get(role);
    const fromEnvLimits = envLimits(env, role);
    if (row) {
      let apiKey: string | undefined;
      let apiKeySource: PublicRoleSettings["apiKeySource"] = null;
      if (row.apiKeyEncrypted) {
        apiKeySource = "db";
        if (!encryptionKey) errors.push(`${role}: a stored API key needs APP_ENCRYPTION_KEY`);
        else {
          try {
            apiKey = decryptSecret(encryptionKey, row.apiKeyEncrypted, apiKeyAad(role));
          } catch (error) {
            errors.push(`${role}: ${(error as Error).message}`);
          }
        }
      } else {
        const fromEnv = roleConfigFromEnv(env, role);
        const envBaseUrl = typeof fromEnv?.baseUrl === "string" ? fromEnv.baseUrl : null;
        if (fromEnv?.provider === row.provider && envBaseUrl === row.baseUrl && typeof fromEnv.apiKey === "string") {
          apiKey = fromEnv.apiKey;
          apiKeySource = "env";
        }
      }
      config[role] = {
        provider: row.provider,
        model: row.model,
        ...(apiKey ? { apiKey } : {}),
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(row.dimensions != null ? { dimensions: row.dimensions } : {}),
        ...(row.structuredOutputs != null ? { structuredOutputs: row.structuredOutputs } : {}),
      };
      limits[role] = {
        dailyTokenLimit: row.dailyTokenLimit ?? fromEnvLimits.dailyTokenLimit,
        dailyCallLimit: row.dailyCallLimit ?? fromEnvLimits.dailyCallLimit,
      };
      roles[role] = {
        source: "db",
        provider: row.provider,
        model: row.model,
        baseUrl: row.baseUrl,
        hasApiKey: apiKeySource !== null,
        apiKeySource,
        dimensions: row.dimensions,
        structuredOutputs: row.structuredOutputs,
        storedDailyTokenLimit: row.dailyTokenLimit,
        storedDailyCallLimit: row.dailyCallLimit,
        ...limits[role],
      };
      continue;
    }
    const fromEnv = roleConfigFromEnv(env, role);
    limits[role] = fromEnvLimits;
    if (fromEnv) config[role] = fromEnv;
    roles[role] = fromEnv
      ? {
          source: "env",
          provider: String(fromEnv.provider ?? ""),
          model: String(fromEnv.model ?? ""),
          baseUrl: typeof fromEnv.baseUrl === "string" ? fromEnv.baseUrl : null,
          hasApiKey: Boolean(fromEnv.apiKey),
          apiKeySource: fromEnv.apiKey ? "env" : null,
          dimensions: typeof fromEnv.dimensions === "number" ? fromEnv.dimensions : null,
          structuredOutputs: typeof fromEnv.structuredOutputs === "boolean" ? fromEnv.structuredOutputs : null,
          storedDailyTokenLimit: null,
          storedDailyCallLimit: null,
          ...fromEnvLimits,
        }
      : null;
  }

  if (errors.length) return { config: null, error: errors.join("; "), roles, limits };
  if (!config.text) return { config: null, error: "No text provider is configured", roles, limits };
  // Env-only installs go through the agent's own env reader.
  const parsed = rows.length === 0 ? providersConfigFromEnv(env) : ProvidersConfigSchema.safeParse(config);
  if (!parsed.success) {
    // Paths and messages only: never values (they may contain keys).
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    return { config: null, error: `Invalid provider configuration: ${issues.join("; ")}`, roles, limits };
  }
  return { config: parsed.data as ProvidersConfig, error: null, roles, limits };
}

export interface ProvidersState {
  providers: Providers | null;
  error: string | null;
  roles: ResolvedProviders["roles"];
  limits: ResolvedProviders["limits"];
}

export interface ProviderSource {
  load(): Promise<ProvidersState>;
}

export interface ProviderRegistryOptions {
  database: Database;
  env?: Env;
  encryptionKey: Buffer | null;
  /** Builds the models (tests inject mock providers). Default: the agent's createProviders. */
  factory?: (config: ProvidersConfig) => Providers;
}

/** Loads the provider configuration per job; models are rebuilt only when the settings changed. */
export class ProviderRegistry implements ProviderSource {
  private cached: { signature: string; state: ProvidersState } | null = null;

  constructor(private readonly options: ProviderRegistryOptions) {}

  async load(): Promise<ProvidersState> {
    const rows = await listProviderSettings(this.options.database.db);
    // Whole rows: any change (including a re-encrypted key, whose IV is fresh) rebuilds the models.
    const signature = JSON.stringify(rows);
    if (this.cached?.signature === signature) return this.cached.state;
    const resolved = resolveProviders(rows, this.options.env ?? process.env, this.options.encryptionKey);
    let providers: Providers | null = null;
    let error = resolved.error;
    if (resolved.config) {
      try {
        providers = (this.options.factory ?? createProviders)(resolved.config);
      } catch (cause) {
        error = `Could not create providers: ${(cause as Error).message}`;
      }
    }
    const state: ProvidersState = { providers, error, roles: resolved.roles, limits: resolved.limits };
    this.cached = { signature, state };
    return state;
  }

  /** Drops the cache (after PUT /setup/providers in the same process). */
  invalidate(): void {
    this.cached = null;
  }
}

// ---------------------------------------------------------------------------
// Connection test (POST /setup/providers/test)
// ---------------------------------------------------------------------------

export interface RoleTestResult {
  ok: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  error?: string;
}

/** A 1×1 transparent PNG. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** 0.25 s of 16 kHz mono silence as a WAV file. */
function silentWav(): Uint8Array {
  const samples = 4000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

function sanitizeError(message: string): string {
  return message
    .replace(/(sk|pk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]")
    .slice(0, 300);
}

/** The API keys in a configuration, so test errors can be scrubbed of them verbatim. */
export function configSecrets(config: ProvidersConfig): string[] {
  return PROVIDER_ROLES.map((role) => config[role]?.apiKey).filter((key): key is string => typeof key === "string" && key.length > 0);
}

export interface TestProviderRolesOptions {
  timeoutMs?: number;
  /** Only test these roles (default: every configured role). */
  roles?: readonly ProviderRole[];
  /** Strings removed from error messages (the configured API keys). */
  secrets?: readonly string[];
}

/** Makes one tiny call per configured role. Never throws; reports per-role success and latency. */
export async function testProviderRoles(
  providers: Providers,
  options: TestProviderRolesOptions = {},
): Promise<Partial<Record<ProviderRole, RoleTestResult>>> {
  const timeout = () => AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const wanted = (role: ProviderRole) => !options.roles || options.roles.includes(role);
  const scrub = (message: string) =>
    (options.secrets ?? []).reduce((text, secret) => (secret.length >= 4 ? text.split(secret).join("[redacted]") : text), message);
  const run = async (role: { provider: string; modelId: string }, call: () => Promise<unknown>): Promise<RoleTestResult> => {
    const started = performance.now();
    try {
      await call();
      return { ok: true, provider: role.provider, model: role.modelId, latencyMs: Math.round(performance.now() - started) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        provider: role.provider,
        model: role.modelId,
        latencyMs: Math.round(performance.now() - started),
        error: sanitizeError(scrub(message)),
      };
    }
  };
  const results: Partial<Record<ProviderRole, RoleTestResult>> = {};
  const jobs: Promise<void>[] = [];
  const add = (name: ProviderRole, test: Promise<RoleTestResult>) => {
    jobs.push(
      test.then((result) => {
        results[name] = result;
      }),
    );
  };
  if (wanted("text")) {
    add(
      "text",
      run(providers.text, () =>
        generateText({ model: providers.text.model, prompt: "Reply with the single word OK.", maxOutputTokens: 16, maxRetries: 0, abortSignal: timeout() }),
      ),
    );
  }
  if (wanted("vision")) {
    add(
      "vision",
      run(providers.vision, () =>
        generateText({
          model: providers.vision.model,
          messages: [{ role: "user", content: [{ type: "text", text: "What color is this pixel? One word." }, { type: "file", data: TINY_PNG, mediaType: "image/png" }] }],
          maxOutputTokens: 16,
          maxRetries: 0,
          abortSignal: timeout(),
        }),
      ),
    );
  }
  const transcription = providers.transcription;
  if (transcription && wanted("transcription")) {
    // The sample is silence, so an empty transcript is the correct answer, not a failure.
    const call = () =>
      transcribe({ model: transcription.model, audio: silentWav(), maxRetries: 0, abortSignal: timeout() }).catch((error: unknown) => {
        if (!NoTranscriptGeneratedError.isInstance(error)) throw error;
      });
    add("transcription", run(transcription, call));
  }
  const embedding = providers.embedding;
  if (embedding && wanted("embedding")) {
    // The indexing helper, dimension request and checks, so a passing test means indexing accepts
    // the vectors: configured dimensions must be honored and fit the 1536-wide column.
    add(
      "embedding",
      run(embedding, async () => {
        if (embedding.dimensions && embedding.dimensions > EMBEDDING_DIMENSIONS) {
          throw new Error(`Embedding configuration requests ${embedding.dimensions} dimensions; the index supports at most ${EMBEDDING_DIMENSIONS}`);
        }
        const result = await embedTexts(providers, ["test"], { batchSize: 1, maxRetries: 0, abortSignal: timeout() });
        if (result.dimensions > EMBEDDING_DIMENSIONS) {
          throw new Error(`Embedding model returned ${result.dimensions} dimensions; the index supports at most ${EMBEDDING_DIMENSIONS}`);
        }
      }),
    );
  }
  await Promise.all(jobs);
  return results;
}
