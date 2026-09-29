/**
 * A small fake OpenWA HTTP server for tests. It mimics the routes WABrain reads and the
 * API-key rules of rmyndharis/OpenWA's ApiKeyGuard: roles (viewer < operator < admin),
 * `allowedSessions` (401 for another session), and `allowedChats` (403 on routes that are not
 * chat-scoped). Every request is recorded so tests can assert that only GETs were made.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRole = "viewer" | "operator" | "admin";

export interface FakeKey {
  role: FakeRole;
  allowedSessions?: string[];
  allowedChats?: string[];
}

export interface FakeSession {
  id: string;
  name: string;
  status: string;
  phone?: string | null;
  pushName?: string | null;
  lastError?: string | null;
}

export interface FakeOpenWa {
  url: string;
  requests: { method: string; path: string; apiKey: string | null }[];
  sessions: FakeSession[];
  keys: Record<string, FakeKey>;
  storedMessages: number;
  historyRows: Record<string, unknown>[];
  /** Delay every answer (ms), to exercise timeouts. */
  delayMs: number;
  close(): Promise<void>;
}

const RANK: Record<FakeRole, number> = { viewer: 1, operator: 2, admin: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeOpenWa(
  options: { sessions?: FakeSession[]; keys?: Record<string, FakeKey>; storedMessages?: number; historyRows?: Record<string, unknown>[] } = {},
): Promise<FakeOpenWa> {
  const state = {
    requests: [] as FakeOpenWa["requests"],
    sessions: options.sessions ?? [],
    keys: options.keys ?? {},
    storedMessages: options.storedMessages ?? 0,
    historyRows: options.historyRows ?? [],
    delayMs: 0,
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const apiKey = (req.headers["x-api-key"] as string | undefined) ?? null;
    state.requests.push({ method: req.method ?? "", path: `${url.pathname}${url.search}`, apiKey });

    if (req.method !== "GET") return json(res, 405, { message: "the fake only serves GET" });
    if (url.pathname === "/api/health") return json(res, 200, { status: "ok", timestamp: new Date().toISOString() });

    const key = apiKey ? state.keys[apiKey] : undefined;
    if (!key) return json(res, 401, { message: "Invalid API key" });
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "api" || parts[1] !== "sessions") return json(res, 404, { message: "Not found" });

    const visible = (id: string) => !key.allowedSessions?.length || key.allowedSessions.includes(id);
    const view = (session: FakeSession) => ({
      id: session.id,
      name: session.name,
      status: session.status,
      phone: session.phone ?? null,
      pushName: session.pushName ?? null,
      connectedAt: session.status === "ready" ? "2026-09-01T08:00:00.000Z" : null,
      lastActive: "2026-09-23T08:00:00.000Z",
      createdAt: "2026-08-01T08:00:00.000Z",
      updatedAt: "2026-09-23T08:00:00.000Z",
      lastError: session.lastError ?? null,
      restriction: null,
      engineLoaded: session.status !== "created",
    });

    if (parts.length === 2) {
      if (key.allowedChats?.length) return json(res, 403, { message: "API key is restricted to selected chats" });
      return json(res, 200, state.sessions.filter((session) => visible(session.id)).map(view));
    }

    const sessionId = parts[2]!;
    if (!visible(sessionId)) return json(res, 401, { message: "API key not authorized for this session" });
    const route = parts.slice(3).join("/");
    const operatorOnly = route === "qr" || route === "webhooks";
    if (operatorOnly && RANK[key.role] < RANK.operator) return json(res, 403, { message: "Insufficient permissions. Required: operator" });
    // Only the session lookup and the chat list are chat-scoped routes; the message list is not.
    if (key.allowedChats?.length && !["", "chats"].includes(route)) {
      return json(res, 403, { message: "API key is restricted to selected chats" });
    }
    if (!UUID.test(sessionId)) return json(res, 400, { message: "Validation failed (uuid is expected)" });
    const session = state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return json(res, 404, { message: "Session not found" });

    switch (route) {
      case "":
        return json(res, 200, view(session));
      case "chats":
        if (session.status !== "ready") return json(res, 409, { message: "Session engine is not ready" });
        return json(res, 200, [{ id: "447690000001@s.whatsapp.net", name: "Private chat", unreadCount: 0 }]);
      case "messages":
        {
          const after = url.searchParams.get("after");
          const start = after ? state.historyRows.findIndex((row) => row.id === after) + 1 : 0;
          if (after && start === 0) return json(res, 400, { message: "Unknown cursor" });
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));
          const rows = state.historyRows.filter((row) => !url.searchParams.get("chatId") || row.chatId === url.searchParams.get("chatId"));
          return json(res, 200, { messages: rows.slice(start, start + limit), total: state.historyRows.length || state.storedMessages });
        }
      case "webhooks":
        return json(res, 200, [{ id: "w1", url: "https://brain.example.com/webhooks/openwa", secret: "whsec-never-read" }]);
      case "qr":
        return json(res, 200, { qrCode: "data:image/png;base64,AAAA", status: session.status });
      default:
        return json(res, 404, { message: "Not found" });
    }
  };

  const server = createServer((req, res) => {
    const run = () => handle(req, res);
    if (state.delayMs > 0) setTimeout(run, state.delayMs);
    else run();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const fake: FakeOpenWa = Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });
  return fake;
}
