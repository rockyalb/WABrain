/**
 * Typed client for the owner setup API. The source of truth for the shapes is
 * `apps/api/src/routes/setup.ts` and `apps/api/src/http/schemas.ts`.
 *
 * Every call is same-origin with the HttpOnly session cookie. Errors are always
 * thrown as ApiError with the server's `{ error: { code, message } }` when present,
 * so screens can branch on the status (401 → login, 409 → server configuration
 * missing, 429 → wait, 501 → feature not on this server yet).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The route exists in the contract but this server build does not implement it yet. */
export const isNotImplemented = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 501 || error.code === "not_implemented");

export const isUnauthorized = (error: unknown): boolean => error instanceof ApiError && error.status === 401;

/** The server needs configuration (or state) before this action works: HTTP 409. */
export const isConflict = (error: unknown): boolean => error instanceof ApiError && error.status === 409;

export const isRateLimited = (error: unknown): boolean => error instanceof ApiError && error.status === 429;

/** "45 s", "2 min". */
export function formatWait(seconds: number): string {
  return seconds < 90 ? `${Math.ceil(seconds)} s` : `${Math.ceil(seconds / 60)} min`;
}

/** A human sentence for any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return error.retryAfterSeconds
        ? `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}.`
        : "Too many attempts. Try again shortly.";
    }
    if (error.status === 401) return "Your session ended. Sign in again.";
    if (isNotImplemented(error)) return "This server version does not support this yet. Update the server to use it.";
    // A 409 carries the server's explanation (e.g. "Set OPENWA_SESSION_ID ..."), which is the useful part.
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

const FALLBACK_CODES: Record<number, string> = {
  400: "validation_failed",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
  501: "not_implemented",
};

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  let code = FALLBACK_CODES[response.status] ?? (response.status >= 500 ? "server_error" : "http_error");
  let message = `The server answered ${response.status}.`;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (body?.error && typeof body.error.code === "string") code = body.error.code;
    if (body?.error && typeof body.error.message === "string" && body.error.message) message = body.error.message;
  } catch {
    // Not JSON (e.g. a reverse proxy error page): keep the generic message.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      message = "The server is not reachable right now.";
    }
  }
  return new ApiError(response.status, code, message, retryAfterSeconds);
}

// ---------------------------------------------------------------------------
// Response shapes. Fields added by later server versions are optional here so
// the page keeps working against older and newer APIs.
// ---------------------------------------------------------------------------

export interface SessionInfo {
  authenticated: boolean;
  ownerExists: boolean;
  bootstrapTokenRequired: boolean;
}

/** Mirrors AutoCreateStatusSchema in packages/contracts. */
export interface AutoCreateStatus {
  state: "trial" | "calibrating" | "active";
  profile: { provider: string; model: string; promptVersion: string } | null;
  calibration: {
    ready: boolean;
    reason: "insufficient_labels" | "no_reliable_threshold" | null;
    threshold: number | null;
    effectiveThreshold: number | null;
    decisions: number;
    accepted: number;
    rejected: number;
    calibratedAt: string | null;
  };
  required: { decisions: number; accepted: number; rejected: number; uneditedAcceptedAtThreshold: number; precision: number };
}

export interface SetupStatus {
  database: { ok: boolean };
  worker: { ok: boolean; lastSeenAt: string | null };
  /** The server reports only `configured`; the live session state comes from GET /setup/openwa/status. */
  openwa: { configured: boolean; status?: string | null; ok?: boolean };
  providers: { configured: string[] } & Record<string, unknown>;
  trial: { active: boolean; startedAt: string; endsAt: string; days: number };
  /** Why creates are (not) automatic; older servers omit it. */
  autoCreate?: AutoCreateStatus;
  devices: { count: number };
  policy?: { trialDays: number; autoCreateThreshold: number };
  spending?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export type OpenWaSessionState =
  | "created"
  | "initializing"
  | "qr_ready"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "action_required"
  | "failed"
  | string;

export interface OpenWaSession {
  id?: string;
  name?: string | null;
  status: OpenWaSessionState;
  pushName: string | null;
  phone: string | null;
  connectedAt: string | null;
  lastActive: string | null;
  engineLoaded?: boolean | null;
  lastError?: string | null;
  restriction?: { kind: string; code: string | null; expiresAt: string | null } | null;
}

/**
 * GET /setup/openwa/status. `error.code` is one of not_configured, no_session_id, unreachable,
 * timeout, unauthorized, forbidden, invalid_session_id, session_not_found, rate_limited, openwa_error.
 */
export interface OpenWaStatus {
  /** OPENWA_BASE_URL and OPENWA_READ_API_KEY are set. */
  configured: boolean;
  sessionId: string | null;
  reachable: boolean;
  /** The session is `ready`, i.e. WhatsApp is linked. */
  paired?: boolean;
  session: OpenWaSession | null;
  /** Sessions the read key can see; only filled when OPENWA_SESSION_ID is not set. */
  sessions?: { id: string; name: string | null; status: string }[];
  error: { code: string; message: string } | null;
  dashboardUrl: string | null;
  webhookUrl: string;
}

export interface OpenWaCheck {
  id: string;
  label: string;
  /** False only for a failed check; a warning counts as passed. */
  ok: boolean;
  /** "warn" marks a check that passed but needs attention (e.g. an over-privileged key). */
  level?: "ok" | "warn" | "error";
  detail: string;
}

export interface OpenWaTestResult {
  ok: boolean;
  checks: OpenWaCheck[];
}

/** GET /setup/openwa/qr: always a link to the OpenWA dashboard, never a QR image (see docs/OPENWA_SETUP.md). */
export interface OpenWaPairing {
  mode: "dashboard";
  dashboardUrl: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  paired: boolean;
  message: string;
}

export interface PairingCode {
  qrPayload: string;
  expiresAt: string;
}

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
}

export type ProviderRole = "text" | "vision" | "transcription" | "embedding";
export const PROVIDER_ROLES: ProviderRole[] = ["text", "vision", "transcription", "embedding"];

/** One role as GET/PUT /setup/providers reports it. The key itself is never returned. */
export interface ProviderRoleView {
  /** "db": saved on this page; "env": from the AI_<ROLE>_* variables. */
  source: "db" | "env";
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  hasApiKey: boolean;
  apiKeySource: "db" | "env" | null;
  dimensions: number | null;
  structuredOutputs: boolean | null;
  /** Effective limits: the saved value, else the AI_<ROLE>_DAILY_* variable, else null (no limit). */
  dailyTokenLimit: number | null;
  dailyCallLimit: number | null;
  /** Only what is saved on this page; null inherits the environment's limit. */
  storedDailyTokenLimit: number | null;
  storedDailyCallLimit: number | null;
}

export type ProvidersView = Record<ProviderRole, ProviderRoleView | null>;

export interface ProvidersState {
  roles: ProvidersView;
  /** APP_ENCRYPTION_KEY is set, so API keys can be saved. */
  encryptionConfigured: boolean;
  /** Why the worker cannot use the current configuration, or null. */
  error: string | null;
}

/**
 * One role in the PUT body. PUT replaces every field of a role it names except the key, so a
 * field that is left out is reset to null: always send the loaded values back.
 */
export interface ProviderRoleInput {
  provider: string;
  model: string;
  baseUrl: string | null;
  /** Omitted keeps the stored key; null clears it; a string replaces it. */
  apiKey?: string | null;
  dimensions: number | null;
  structuredOutputs: boolean | null;
  dailyTokenLimit: number | null;
  dailyCallLimit: number | null;
}

/** Per role: settings to store, null to remove them (the role falls back to the environment), or omitted to leave it alone. */
export type ProvidersInput = Partial<Record<ProviderRole, ProviderRoleInput | null>>;

export interface ProviderTestResult {
  role: ProviderRole;
  ok: boolean;
  provider: string | null;
  model: string | null;
  message: string;
  latencyMs: number | null;
}

export interface Policy {
  trialDays: number;
  autoCreateThreshold: number;
}

export interface CoverageRow {
  chatId: string;
  chatName: string | null;
  earliestAt: string | null;
  messageCount: number;
  mediaOk: number;
  mediaFailed: number;
  gaps: string[];
}

export type ImportRunStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | string;

export interface ImportRun {
  status: ImportRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** 0..1, or null while the total is unknown. */
  progress: number | null;
  error: string | null;
}

export interface ImportState {
  items: CoverageRow[];
  run: ImportRun | null;
  /**
   * "openwa": no import has run yet, so the rows describe what OpenWA holds for the last 90 days.
   * "local": what WABrain has stored (imported history plus live messages).
   */
  source: "openwa" | "local";
}

// ---------------------------------------------------------------------------
// Normalizers: tolerate small shape differences between server versions.
// ---------------------------------------------------------------------------

const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const keySource = (value: unknown): "db" | "env" | null => (value === "db" || value === "env" ? value : null);

export function normalizeProviders(input: unknown): ProvidersState {
  const root = obj(input) ?? {};
  const source = obj(root.providers) ?? obj(root.roles) ?? root;
  const roles = {} as ProvidersView;
  for (const role of PROVIDER_ROLES) {
    const entry = obj(source[role]);
    if (!entry) {
      roles[role] = null;
      continue;
    }
    const keyFlag = entry.hasApiKey ?? entry.apiKeySet ?? entry.apiKeyConfigured;
    const hasApiKey = keyFlag === true || keyFlag === "set";
    roles[role] = {
      source: entry.source === "env" ? "env" : "db",
      provider: str(entry.provider),
      model: str(entry.model),
      baseUrl: str(entry.baseUrl),
      hasApiKey,
      apiKeySource: hasApiKey ? (keySource(entry.apiKeySource) ?? "db") : null,
      dimensions: num(entry.dimensions),
      structuredOutputs: bool(entry.structuredOutputs),
      dailyTokenLimit: num(entry.dailyTokenLimit),
      dailyCallLimit: num(entry.dailyCallLimit),
      storedDailyTokenLimit: num(entry.storedDailyTokenLimit),
      storedDailyCallLimit: num(entry.storedDailyCallLimit),
    };
  }
  return {
    roles,
    // Older servers did not report it; assume keys can be saved and let a 409 explain otherwise.
    encryptionConfigured: bool(root.encryptionConfigured) ?? true,
    error: str(root.error),
  };
}

export function normalizeProviderTest(input: unknown): ProviderTestResult[] {
  const root = obj(input) ?? {};
  const results = root.results ?? root.items ?? root;
  const rows: ProviderTestResult[] = [];
  const push = (role: string, value: unknown) => {
    if (!PROVIDER_ROLES.includes(role as ProviderRole)) return;
    const entry = obj(value);
    if (!entry) return;
    const ok = entry.ok === true;
    rows.push({
      role: role as ProviderRole,
      ok,
      provider: str(entry.provider),
      model: str(entry.model),
      message: str(entry.error) ?? str(obj(entry.error)?.message) ?? str(entry.message) ?? (ok ? "Works" : "Failed"),
      latencyMs: num(entry.latencyMs),
    });
  };
  if (Array.isArray(results)) {
    for (const entry of results) push(String(obj(entry)?.role ?? ""), entry);
  } else if (obj(results)) {
    for (const [role, entry] of Object.entries(obj(results)!)) push(role, entry);
  }
  return rows;
}

export function normalizeRun(input: unknown): ImportRun | null {
  const run = obj(input);
  if (!run) return null;
  return {
    status: str(run.status) ?? "unknown",
    startedAt: str(run.startedAt),
    finishedAt: str(run.finishedAt),
    progress: num(run.progress),
    error: str(run.error),
  };
}

export function normalizeImport(input: unknown): ImportState {
  const root = obj(input) ?? {};
  const items = Array.isArray(root.items) ? root.items : Array.isArray(root.chats) ? root.chats : [];
  const run = normalizeRun(root.run ?? root.import);
  return {
    items: items.map((raw) => {
      const row = obj(raw) ?? {};
      const media = obj(row.media);
      return {
        chatId: str(row.chatId) ?? str(row.id) ?? "",
        chatName: str(row.chatName) ?? str(row.name),
        earliestAt: str(row.earliestAt) ?? str(row.earliestTimestamp),
        messageCount: num(row.messageCount) ?? 0,
        mediaOk: num(row.mediaOk) ?? num(media?.ok) ?? num(row.mediaSucceeded) ?? 0,
        mediaFailed: num(row.mediaFailed) ?? num(media?.failed) ?? 0,
        gaps: Array.isArray(row.gaps) ? row.gaps.map((gap) => (typeof gap === "string" ? gap : JSON.stringify(gap))) : [],
      };
    }),
    run,
    source: run ? "local" : "openwa",
  };
}

// ---------------------------------------------------------------------------

export interface ApiOptions {
  fetch?: typeof fetch;
  /** Called when an authenticated call answers 401 (session expired or revoked). */
  onUnauthorized?: () => void;
  baseUrl?: string;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function idempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The history import always reaches back this far (docs/SPEC.md, "History import"). */
export const IMPORT_DAYS = 90;

/** GET /setup/usage: recorded model usage per UTC day, and OpenAI's billed costs when configured. */
export interface UsageReport {
  since: string;
  days: number;
  usage: Array<{
    day: string;
    role: ProviderRole;
    provider: string | null;
    model: string | null;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    audioSeconds: number;
  }>;
  costs:
    | { status: "ok"; projectId: string | null; days: Array<{ day: string; items: Array<{ lineItem: string; usd: number }> }> }
    | { status: "not_configured" }
    | { status: "error"; message: string };
}

export function createApi(options: ApiOptions = {}) {
  const fetchImpl = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const base = options.baseUrl ?? "";

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extra: { headers?: Record<string, string>; public?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...extra.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (MUTATING.has(method)) headers["idempotency-key"] = idempotencyKey();
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection.");
    }
    if (!response.ok) {
      const error = await toApiError(response);
      if (error.status === 401 && !extra.public) options.onUnauthorized?.();
      throw error;
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(response.status, "invalid_response", "The server sent an unexpected response.");
    }
  }

  return {
    request,
    session: () => request<SessionInfo>("GET", "/setup/session", undefined, { public: true }),
    bootstrap: (password: string, setupToken?: string) =>
      request<{ ok: boolean }>("POST", "/setup/bootstrap", { password }, {
        public: true,
        headers: setupToken ? { "x-setup-token": setupToken } : {},
      }),
    login: (password: string) => request<{ ok: boolean }>("POST", "/setup/login", { password }, { public: true }),
    logout: () => request<{ ok: boolean }>("POST", "/setup/logout"),
    status: () => request<SetupStatus>("GET", "/setup/status"),

    openWaStatus: () => request<OpenWaStatus>("GET", "/setup/openwa/status"),
    openWaTest: () => request<OpenWaTestResult>("POST", "/setup/openwa/test"),
    openWaPairing: () => request<OpenWaPairing>("GET", "/setup/openwa/qr"),

    providers: async () => normalizeProviders(await request<unknown>("GET", "/setup/providers")),
    saveProviders: async (input: ProvidersInput) => normalizeProviders(await request<unknown>("PUT", "/setup/providers", input)),
    testProviders: async (roles?: ProviderRole[]) =>
      normalizeProviderTest(await request<unknown>("POST", "/setup/providers/test", roles ? { roles } : {})),

    usage: (days = 30) => request<UsageReport>("GET", `/setup/usage?days=${days}`),

    updatePolicy: (patch: Partial<Policy>) => request<Policy & Record<string, unknown>>("PATCH", "/setup/policy", patch),

    devices: () => request<{ items: Device[] }>("GET", "/setup/devices"),
    revokeDevice: (id: string) => request<void>("DELETE", `/setup/devices/${encodeURIComponent(id)}`),
    createPairingCode: () => request<PairingCode>("POST", "/setup/pairing-codes"),

    importCoverage: async () => normalizeImport(await request<unknown>("GET", "/setup/import/coverage")),
    /** 202 `{ run: { status, startedAt } }`. A cancelled or failed run with the same days resumes at its cursor. */
    startImport: async (days = IMPORT_DAYS) =>
      normalizeRun((await request<{ run?: unknown } | undefined>("POST", "/setup/import", { days }))?.run),
    /** `{ run: { status, finishedAt } | null }`. */
    cancelImport: async () => normalizeRun((await request<{ run?: unknown } | undefined>("DELETE", "/setup/import"))?.run),

    wipe: (confirm: string) => request<{ ok: boolean }>("POST", "/setup/wipe", { confirm }),
  };
}

export type Api = ReturnType<typeof createApi>;
