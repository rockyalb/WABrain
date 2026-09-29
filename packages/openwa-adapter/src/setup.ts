/**
 * OpenWA connection checks for the setup page: session status and a read-access test.
 *
 * GET-only, like OpenWaReadClient. The routes and roles come from the rmyndharis/OpenWA source
 * (src/modules/session/session.controller.ts, src/modules/auth/guards/api-key.guard.ts):
 *
 * - `GET /api/health` is public.
 * - `GET /api/sessions`, `GET /api/sessions/:id`, `.../chats`, `.../messages` and the stored-media
 *   route need no role beyond a valid key, so a `viewer` key is enough.
 * - A key with `allowedSessions` gets 401 for any other session and only sees its own sessions in
 *   `GET /api/sessions`. A key with `allowedChats` gets 403 on the session-wide message list.
 * - The QR code route of a session needs the `operator` role, which can also send messages, so the
 *   QR code is never fetched here: pairing happens in the OpenWA dashboard.
 * - `GET /api/sessions/:id/webhooks` also needs `operator`. It has no side effect, so the test uses
 *   it to tell whether the configured key is more powerful than it should be.
 */

export type OpenWaSessionState =
  | "created"
  | "initializing"
  | "qr_ready"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "action_required"
  | "failed";

export interface OpenWaSessionInfo {
  id: string;
  name: string | null;
  /** One of OpenWaSessionState, or a newer value passed through as is. */
  status: string;
  phone: string | null;
  pushName: string | null;
  connectedAt: string | null;
  lastActive: string | null;
  engineLoaded: boolean | null;
  /** OpenWA's own reason while the session is failed or needs action. */
  lastError: string | null;
  /** A restriction WhatsApp placed on the account (e.g. `reachout_timelock`), or null. */
  restriction: { kind: string; code: string | null; expiresAt: string | null } | null;
}

export type OpenWaErrorCode =
  | "not_configured"
  | "no_session_id"
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "forbidden"
  | "invalid_session_id"
  | "session_not_found"
  | "rate_limited"
  | "openwa_error";

export interface OpenWaProblem {
  code: OpenWaErrorCode;
  message: string;
}

export interface OpenWaStatusReport {
  reachable: boolean;
  session: OpenWaSessionInfo | null;
  /** Sessions the key can see; only filled when no session id is configured, to help pick one. */
  sessions: { id: string; name: string | null; status: string }[];
  error: OpenWaProblem | null;
}

export interface OpenWaCheck {
  id: "reachable" | "session" | "linked" | "chats" | "messages" | "role" | "session_scope";
  label: string;
  /** False only for a failed check; a warning still counts as passed. */
  ok: boolean;
  level: "ok" | "warn" | "error";
  detail: string;
}

export interface OpenWaTestReport {
  ok: boolean;
  checks: OpenWaCheck[];
}

export interface OpenWaSetupClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout (default 8 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface GetResult {
  status: number;
  body: unknown;
}

/** A request that got no HTTP answer at all. The message never contains the key or the URL. */
export class OpenWaUnreachableError extends Error {
  constructor(readonly code: "unreachable" | "timeout", message: string) {
    super(message);
    this.name = "OpenWaUnreachableError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (value: unknown): string | null => (typeof value === "string" && value.length ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function parseSession(value: unknown): OpenWaSessionInfo | null {
  const data = record(value);
  const id = str(data?.id);
  if (!data || !id) return null;
  const restriction = record(data.restriction);
  return {
    id,
    name: str(data.name),
    status: str(data.status) ?? "unknown",
    phone: str(data.phone),
    pushName: str(data.pushName),
    connectedAt: str(data.connectedAt),
    lastActive: str(data.lastActive),
    engineLoaded: typeof data.engineLoaded === "boolean" ? data.engineLoaded : null,
    lastError: str(data.lastError)?.slice(0, 500) ?? null,
    restriction: restriction
      ? { kind: str(restriction.kind) ?? "unknown", code: str(restriction.code), expiresAt: str(restriction.expiresAt) }
      : null,
  };
}

/** GET-only OpenWA client for the setup checks. HTTP errors are returned, not thrown. */
export class OpenWaSetupClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenWaSetupClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async get(path: string, options: { readBody?: boolean } = {}): Promise<GetResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
        // Never follow a redirect: it could carry the key to another host.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new OpenWaUnreachableError("timeout", `OpenWA did not answer within ${Math.round(this.timeoutMs / 1000)} s`);
      }
      const cause = error instanceof Error ? record(error.cause) : null;
      const code = str(cause?.code);
      throw new OpenWaUnreachableError("unreachable", `Could not connect to OpenWA${code ? ` (${code})` : ""}`);
    }
    if (options.readBody === false) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: null };
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  private session(sessionId: string, suffix = "") {
    return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
  }

  /** Public liveness route; answers without a valid key. */
  health(): Promise<GetResult> {
    return this.get("/api/health");
  }

  /** The sessions this key may see (a session-scoped key sees only its own). */
  listSessions(): Promise<GetResult> {
    return this.get("/api/sessions?limit=50");
  }

  getSession(sessionId: string): Promise<GetResult> {
    return this.get(this.session(sessionId));
  }

  /** One chat, to prove chat discovery works. The chat itself is discarded. */
  probeChats(sessionId: string): Promise<GetResult> {
    return this.get(this.session(sessionId, "/chats?limit=1"));
  }

  /** One stored message without media, to prove the history route works. */
  probeStoredMessages(sessionId: string): Promise<GetResult> {
    return this.get(this.session(sessionId, "/messages?limit=1&inlineMedia=false"));
  }

  /**
   * An operator-only GET with no side effect. A 200 means the key has the operator or admin role
   * (it could send messages); a viewer key gets 403. The body (webhook settings) is never read.
   */
  probeOperatorRole(sessionId: string): Promise<GetResult> {
    return this.get(this.session(sessionId, "/webhooks"), { readBody: false });
  }
}

/** Maps an OpenWA HTTP error on a session route to a problem the owner can act on. */
export function describeOpenWaError(status: number, sessionId: string): OpenWaProblem {
  switch (status) {
    case 400:
      return UUID.test(sessionId)
        ? { code: "openwa_error", message: "OpenWA rejected the request (400)" }
        : { code: "invalid_session_id", message: "OPENWA_SESSION_ID must be the session's id (a UUID from the OpenWA dashboard), not its name" };
    case 401:
      return {
        code: "unauthorized",
        message:
          "OpenWA rejected OPENWA_READ_API_KEY: it is wrong, revoked, expired, not allowed from this IP, or not allowed for this session",
      };
    case 403:
      return {
        code: "forbidden",
        message: "OpenWA refused the key for this route. Use a key without a chat allowlist (allowedChats empty)",
      };
    case 404:
      return { code: "session_not_found", message: "OpenWA has no session with the id in OPENWA_SESSION_ID" };
    case 429:
      return { code: "rate_limited", message: "OpenWA is rate-limiting this key; try again shortly" };
    default:
      return { code: "openwa_error", message: `OpenWA answered with an error (${status})` };
  }
}

function unreachableProblem(error: unknown): OpenWaProblem {
  if (error instanceof OpenWaUnreachableError) return { code: error.code, message: error.message };
  return { code: "unreachable", message: "Could not connect to OpenWA" };
}

function listSessionSummaries(body: unknown) {
  const items = Array.isArray(body) ? body : Array.isArray(record(body)?.data) ? (record(body)!.data as unknown[]) : [];
  return items.flatMap((item) => {
    const session = parseSession(item);
    return session ? [{ id: session.id, name: session.name, status: session.status }] : [];
  });
}

/** Whether OpenWA answers, and the configured session's state. Makes at most two GET requests. */
export async function getOpenWaStatus(client: OpenWaSetupClient, sessionId: string | null): Promise<OpenWaStatusReport> {
  try {
    await client.health();
  } catch (error) {
    return { reachable: false, session: null, sessions: [], error: unreachableProblem(error) };
  }
  try {
    if (!sessionId) {
      const listed = await client.listSessions();
      const sessions = listed.status === 200 ? listSessionSummaries(listed.body) : [];
      const error: OpenWaProblem =
        listed.status === 200
          ? { code: "no_session_id", message: "Set OPENWA_SESSION_ID to the id of the OpenWA session to read" }
          : describeOpenWaError(listed.status, "");
      return { reachable: true, session: null, sessions, error };
    }
    const result = await client.getSession(sessionId);
    if (result.status !== 200) return { reachable: true, session: null, sessions: [], error: describeOpenWaError(result.status, sessionId) };
    const session = parseSession(result.body);
    if (!session) return { reachable: true, session: null, sessions: [], error: { code: "openwa_error", message: "OpenWA returned an unexpected session response" } };
    return { reachable: true, session, sessions: [], error: null };
  } catch (error) {
    return { reachable: false, session: null, sessions: [], error: unreachableProblem(error) };
  }
}

const passed = (id: OpenWaCheck["id"], label: string, detail: string): OpenWaCheck => ({ id, label, ok: true, level: "ok", detail });
const failed = (id: OpenWaCheck["id"], label: string, detail: string): OpenWaCheck => ({ id, label, ok: false, level: "error", detail });
const warning = (id: OpenWaCheck["id"], label: string, detail: string): OpenWaCheck => ({ id, label, ok: true, level: "warn", detail });

const STATE_HINTS: Record<string, string> = {
  created: "The session exists but is not started. Start it in the OpenWA dashboard",
  initializing: "The session is starting",
  qr_ready: "The session is waiting for the QR code to be scanned in the OpenWA dashboard",
  authenticating: "The session is authenticating",
  disconnected: "The session is disconnected",
  action_required: "OpenWA says the session needs attention",
  failed: "The session failed",
};

async function routeCheck(
  id: OpenWaCheck["id"],
  label: string,
  sessionId: string,
  run: () => Promise<GetResult>,
  onOk: (body: unknown) => string,
): Promise<OpenWaCheck> {
  try {
    const result = await run();
    if (result.status === 200) return passed(id, label, onOk(result.body));
    if (result.status === 409 || (result.status === 400 && UUID.test(sessionId))) {
      return failed(id, label, "OpenWA says the session is not ready; link WhatsApp first");
    }
    return failed(id, label, describeOpenWaError(result.status, sessionId).message);
  } catch (error) {
    return failed(id, label, unreachableProblem(error).message);
  }
}

async function roleCheck(client: OpenWaSetupClient, sessionId: string): Promise<OpenWaCheck> {
  const label = "Key cannot send";
  try {
    const { status } = await client.probeOperatorRole(sessionId);
    if (status === 403) return passed("role", label, "The key has the viewer role: it can read but not send or change anything");
    if (status === 200) {
      return warning("role", label, "The key has the operator or admin role and could send messages. Replace it with a viewer key");
    }
    return warning("role", label, `Could not determine the key's role (${status})`);
  } catch (error) {
    return warning("role", label, `Could not determine the key's role: ${unreachableProblem(error).message}`);
  }
}

async function scopeCheck(client: OpenWaSetupClient, sessionId: string): Promise<OpenWaCheck> {
  const label = "Key limited to this session";
  try {
    const { status, body } = await client.listSessions();
    if (status !== 200) return warning("session_scope", label, `Could not list the sessions the key can see (${status})`);
    const others = listSessionSummaries(body).filter((session) => session.id !== sessionId);
    if (others.length) {
      return warning(
        "session_scope",
        label,
        `The key can also see ${others.length} other session${others.length === 1 ? "" : "s"}. Limit it to this session (allowedSessions)`,
      );
    }
    return passed("session_scope", label, "The key sees only this session");
  } catch (error) {
    return warning("session_scope", label, `Could not list sessions: ${unreachableProblem(error).message}`);
  }
}

/**
 * Checks that the read key works for everything WABrain reads, and warns when it can do more.
 * Every request is a GET; nothing is sent to WhatsApp and nothing in OpenWA changes. The role check
 * does leave one "insufficient permissions" entry in OpenWA's audit log when the key is (correctly)
 * a viewer key.
 */
export async function testOpenWaReadAccess(client: OpenWaSetupClient, sessionId: string): Promise<OpenWaTestReport> {
  const checks: OpenWaCheck[] = [];
  const finish = () => ({ ok: checks.every((check) => check.ok), checks });

  try {
    await client.health();
    checks.push(passed("reachable", "OpenWA reachable", "OpenWA answered"));
  } catch (error) {
    checks.push(failed("reachable", "OpenWA reachable", unreachableProblem(error).message));
    return finish();
  }

  const sessionLabel = "Read key accepted for the session";
  let session: OpenWaSessionInfo | null = null;
  try {
    const result = await client.getSession(sessionId);
    session = result.status === 200 ? parseSession(result.body) : null;
    if (session) {
      checks.push(passed("session", sessionLabel, `Session ${session.name ? `"${session.name}"` : session.id} found`));
    } else {
      const problem = result.status === 200 ? "OpenWA returned an unexpected session response" : describeOpenWaError(result.status, sessionId).message;
      checks.push(failed("session", sessionLabel, problem));
      return finish();
    }
  } catch (error) {
    checks.push(failed("session", sessionLabel, unreachableProblem(error).message));
    return finish();
  }

  const linkedLabel = "WhatsApp linked";
  if (session.status === "ready") {
    checks.push(passed("linked", linkedLabel, session.pushName ? `Connected as ${session.pushName}` : "Connected"));
  } else {
    const hint = STATE_HINTS[session.status] ?? `The session state is "${session.status}"`;
    checks.push(failed("linked", linkedLabel, session.lastError ? `${hint}: ${session.lastError}` : hint));
  }

  const results = await Promise.all([
    routeCheck("chats", "Can list chats", sessionId, () => client.probeChats(sessionId), () => "Chat list readable"),
    routeCheck("messages", "Can read stored messages", sessionId, () => client.probeStoredMessages(sessionId), (body) => {
      const total = record(body)?.total;
      return typeof total === "number" ? `Stored history readable (${total} messages stored)` : "Stored history readable";
    }),
    roleCheck(client, sessionId),
    scopeCheck(client, sessionId),
  ]);
  checks.push(...results);
  return finish();
}
