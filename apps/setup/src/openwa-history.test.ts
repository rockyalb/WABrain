import { describe, expect, it } from "vitest";
import type { OpenWaStatus } from "./api";
import { coverageTotals, isActive, mergeRun, progressPercent, runBadge, startLabel } from "./history";
import { checkTone, connectionSummary, isLoopbackUrl, problemHint, testSummary, tunnelCommand } from "./openwa";

const status = (overrides: Partial<OpenWaStatus>): OpenWaStatus => ({
  configured: true,
  sessionId: "0b7c7f8e-1111-4c4c-9999-123456789abc",
  reachable: true,
  paired: false,
  session: null,
  sessions: [],
  error: null,
  dashboardUrl: null,
  webhookUrl: "https://brain.example/webhooks/openwa",
  ...overrides,
});

describe("openwa helpers", () => {
  it("summarizes the connection", () => {
    expect(connectionSummary(status({ configured: false }))).toEqual({ label: "Not configured", tone: "warn" });
    expect(connectionSummary(status({ reachable: false }))).toEqual({ label: "Unreachable", tone: "error" });
    const session = { status: "ready", pushName: "Alex", phone: null, connectedAt: null, lastActive: null };
    expect(connectionSummary(status({ session, paired: true }))).toEqual({ label: "Connected", tone: "ok" });
    expect(connectionSummary(status({ session: { ...session, status: "qr_ready" } }))).toEqual({ label: "Waiting for QR scan", tone: "warn" });
    expect(connectionSummary(status({ sessionId: null, error: { code: "no_session_id", message: "Set it" } })).label).toBe("Choose a session");
    expect(connectionSummary(status({ error: { code: "unauthorized", message: "no" } }))).toEqual({ label: "Needs attention", tone: "error" });
  });

  it("explains every problem code", () => {
    for (const code of ["not_configured", "no_session_id", "unreachable", "timeout", "unauthorized", "forbidden", "invalid_session_id", "session_not_found", "rate_limited", "openwa_error"]) {
      expect(problemHint(code), code).toBeTruthy();
    }
    expect(problemHint("invalid_session_id")).toMatch(/UUID/);
    expect(problemHint("something_new")).toBeNull();
  });

  it("recognizes loopback dashboard links and builds the tunnel command", () => {
    expect(isLoopbackUrl("http://127.0.0.1:2785/sessions")).toBe(true);
    expect(isLoopbackUrl("http://localhost:2785/sessions")).toBe(true);
    expect(isLoopbackUrl("https://wa.example.com/sessions")).toBe(false);
    expect(isLoopbackUrl(null)).toBe(false);
    expect(tunnelCommand("http://127.0.0.1:3001/sessions")).toBe("ssh -L 3001:127.0.0.1:3001 you@your-server");
    expect(tunnelCommand(null)).toBe("ssh -L 2785:127.0.0.1:2785 you@your-server");
  });

  it("counts failures before warnings", () => {
    const ok = { id: "reachable", label: "OpenWA reachable", ok: true, level: "ok" as const, detail: "" };
    const warn = { id: "role", label: "Key cannot send", ok: true, level: "warn" as const, detail: "operator" };
    const fail = { id: "linked", label: "WhatsApp linked", ok: false, level: "error" as const, detail: "qr" };
    expect(checkTone(warn)).toBe("warn");
    expect(checkTone({ ...fail, level: undefined })).toBe("error");
    expect(testSummary([ok]).tone).toBe("ok");
    expect(testSummary([ok, warn])).toEqual({ tone: "warn", text: "Read access works, with 1 warning." });
    expect(testSummary([ok, warn, fail])).toEqual({ tone: "error", text: "1 check failed." });
  });
});

describe("history helpers", () => {
  const run = { status: "running", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: null, progress: 0.333, error: null };

  it("labels runs and the start button", () => {
    expect(runBadge(null)).toEqual({ label: "Not started", tone: "idle" });
    expect(runBadge({ ...run, status: "failed" }).tone).toBe("error");
    expect(isActive(run)).toBe(true);
    expect(isActive({ ...run, status: "queued" })).toBe(true);
    expect(isActive({ ...run, status: "completed" })).toBe(false);
    expect(startLabel(null)).toBe("Import 90 days…");
    expect(startLabel({ ...run, status: "cancelled" })).toBe("Resume import…");
    expect(startLabel({ ...run, status: "completed" })).toBe("Import again…");
    expect(progressPercent(run)).toBe(33);
    expect(progressPercent({ ...run, progress: null })).toBeNull();
  });

  it("merges start and cancel responses into the known run", () => {
    const cancelled = mergeRun(run, { status: "cancelled", startedAt: null, finishedAt: "2026-09-24T10:05:00.000Z", progress: null, error: null });
    expect(cancelled).toEqual({ ...run, status: "cancelled", finishedAt: "2026-09-24T10:05:00.000Z" });
    const failed = { ...cancelled!, status: "failed", error: "OpenWA returned 500" };
    const restarted = mergeRun(failed, { status: "queued", startedAt: "2026-09-24T11:00:00.000Z", finishedAt: null, progress: null, error: null });
    expect(restarted).toEqual({ status: "queued", startedAt: "2026-09-24T11:00:00.000Z", finishedAt: null, progress: null, error: null });
    expect(mergeRun(null, null)).toBeNull();
  });

  it("totals the coverage report", () => {
    const totals = coverageTotals([
      { chatId: "a", chatName: null, earliestAt: "2026-07-02T00:00:00.000Z", messageCount: 10, mediaOk: 2, mediaFailed: 1, gaps: ["media pending (1)"] },
      { chatId: "b", chatName: null, earliestAt: "2026-06-27T00:00:00.000Z", messageCount: 5, mediaOk: 0, mediaFailed: 0, gaps: [] },
      { chatId: "c", chatName: null, earliestAt: null, messageCount: 0, mediaOk: 0, mediaFailed: 0, gaps: ["history_page_failed (1)"] },
    ]);
    expect(totals).toEqual({ chats: 3, messages: 15, mediaOk: 2, mediaFailed: 1, chatsWithGaps: 2, earliestAt: "2026-06-27T00:00:00.000Z" });
  });
});
