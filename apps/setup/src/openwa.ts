/** Wording for the WhatsApp (OpenWA) screen, kept free of UI code so it can be tested. */
import type { OpenWaCheck, OpenWaStatus } from "./api";

export type Tone = "ok" | "warn" | "error" | "idle";

const STATE_TEXT: Record<string, { label: string; tone: Tone }> = {
  ready: { label: "Connected", tone: "ok" },
  qr_ready: { label: "Waiting for QR scan", tone: "warn" },
  authenticating: { label: "Authenticating", tone: "warn" },
  initializing: { label: "Starting", tone: "warn" },
  created: { label: "Not started", tone: "warn" },
  disconnected: { label: "Disconnected", tone: "error" },
  action_required: { label: "Action required", tone: "error" },
  failed: { label: "Failed", tone: "error" },
};

export function describeState(state: string | null | undefined): { label: string; tone: Tone } {
  return (state && STATE_TEXT[state]) || { label: state ?? "Unknown", tone: "idle" };
}

/** One summary of the connection for the WhatsApp screen and the Overview tile. */
export function connectionSummary(status: OpenWaStatus): { label: string; tone: Tone } {
  if (!status.configured) return { label: "Not configured", tone: "warn" };
  if (!status.reachable) return { label: "Unreachable", tone: "error" };
  if (status.session) return describeState(status.session.status);
  if (status.error?.code === "no_session_id") return { label: "Choose a session", tone: "warn" };
  return { label: "Needs attention", tone: "error" };
}

/** What the owner can do about each problem code of GET /setup/openwa/status. */
const PROBLEM_HINTS: Record<string, string> = {
  not_configured:
    "Set OPENWA_BASE_URL, OPENWA_SESSION_ID, and a read-only OPENWA_READ_API_KEY (a viewer key scoped to the session) for the API and the worker, then restart them.",
  no_session_id: "Set OPENWA_SESSION_ID to the id (a UUID, not the name) of the session to read, then restart the API and the worker.",
  unreachable:
    "Check OPENWA_BASE_URL and that OpenWA is running. In the compose bundle it is http://openwa:2785; on Railway use OpenWA's private address.",
  timeout: "OpenWA did not answer in time. Check that it is running and not overloaded, then refresh.",
  unauthorized: "OpenWA rejected the read key. It may be wrong, revoked, or expired: create a new viewer key and set OPENWA_READ_API_KEY.",
  forbidden: "The read key may not read this session. Give the key the session in allowedSessions, with no allowedChats.",
  invalid_session_id: "OPENWA_SESSION_ID looks like the session's name. OpenWA needs the session's UUID.",
  session_not_found: "OpenWA has no session with this id. Check OPENWA_SESSION_ID against the OpenWA dashboard.",
  rate_limited: "OpenWA is rate-limiting requests. Wait a minute, then refresh.",
  openwa_error: "OpenWA answered with an error. Check the OpenWA logs.",
};

export function problemHint(code: string | null | undefined): string | null {
  return (code && PROBLEM_HINTS[code]) || null;
}

/** The dashboard link points at the server's loopback address, which needs an SSH tunnel to open. */
export function isLoopbackUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);
  } catch {
    return false;
  }
}

/** The SSH tunnel command for a loopback dashboard URL (docs/DEPLOY.md, B.5). */
export function tunnelCommand(url: string | null | undefined): string {
  let port = "2785";
  try {
    if (url) port = new URL(url).port || port;
  } catch {
    // Keep the default port.
  }
  return `ssh -L ${port}:127.0.0.1:${port} you@your-server`;
}

export function checkTone(check: OpenWaCheck): Tone {
  if (check.level === "warn") return "warn";
  if (check.level === "error" || !check.ok) return "error";
  return "ok";
}

/** A test result's headline: failures first, then warnings. */
export function testSummary(checks: OpenWaCheck[]): { tone: "ok" | "warn" | "error"; text: string } {
  const failed = checks.filter((check) => checkTone(check) === "error").length;
  const warned = checks.filter((check) => checkTone(check) === "warn").length;
  if (failed) return { tone: "error", text: failed === 1 ? "1 check failed." : `${failed} checks failed.` };
  if (warned) return { tone: "warn", text: warned === 1 ? "Read access works, with 1 warning." : `Read access works, with ${warned} warnings.` };
  return { tone: "ok", text: "Read access works. Nothing was sent to WhatsApp." };
}
