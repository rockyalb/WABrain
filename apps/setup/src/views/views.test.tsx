import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../api";
import { ApiContext } from "../components/ui";
import { HistoryImport } from "./HistoryImport";
import { Overview } from "./Overview";
import { Providers } from "./Providers";
import { Usage } from "./Usage";
import { WhatsApp } from "./WhatsApp";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Route = Reply | ((body: unknown) => Reply);

/** A fake setup API: routes are "METHOD /path"; every request is recorded. */
function fakeServer(routes: Record<string, Route>) {
  const requests: Array<{ key: string; body: unknown }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ key, body });
    const route = routes[key];
    const reply = typeof route === "function" ? route(body) : (route ?? { status: 404, body: { error: { code: "not_found", message: `No route ${key}` } } });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers });
  }) as typeof globalThis.fetch;
  return { api: createApi({ fetch }), requests };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
});

async function settle() {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(api: ReturnType<typeof createApi>, view: preact.JSX.Element) {
  await act(async () => {
    render(<ApiContext.Provider value={api}>{view}</ApiContext.Provider>, root);
  });
  await settle();
}

const text = () => root.textContent ?? "";

function input(id: string, value: string) {
  const element = root.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
  element.value = value;
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!found) throw new Error(`No button "${label}" in: ${text()}`);
  return found;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
  await settle();
}

const role = (overrides: Record<string, unknown> = {}) => ({
  source: "db",
  provider: "openai",
  model: "gpt-5",
  baseUrl: null,
  hasApiKey: true,
  apiKeySource: "db",
  dimensions: null,
  structuredOutputs: null,
  dailyTokenLimit: 200000,
  dailyCallLimit: 500,
  storedDailyTokenLimit: 200000,
  storedDailyCallLimit: 500,
  ...overrides,
});

describe("Providers", () => {
  const providers = (encryptionConfigured = true) => ({
    providers: {
      text: role(),
      vision: null,
      transcription: role({
        source: "env",
        apiKeySource: "env",
        model: "whisper-1",
        dailyTokenLimit: null,
        dailyCallLimit: null,
        storedDailyTokenLimit: null,
        storedDailyCallLimit: null,
      }),
      embedding: null,
    },
    encryptionConfigured,
    error: null,
  });

  it("shows where keys come from and saves only the edited role with its loaded limits", async () => {
    const { api, requests } = fakeServer({
      "GET /setup/providers": { body: providers() },
      "PUT /setup/providers": (body) => ({ body: { ...providers(), providers: { ...providers().providers, text: role({ model: (body as { text: { model: string } }).text.model }) } } }),
    });
    await mount(api, <Providers />);
    expect(text()).toContain("Key set · saved encrypted");
    expect(text()).toContain("AI_TRANSCRIPTION_API_KEY");
    expect(text()).toContain("From environment");
    expect(root.querySelector("#text-key")!.getAttribute("placeholder")).toContain("leave empty to keep");

    await act(async () => input("text-model", "gpt-5-mini"));
    await click("Save changes");

    const put = requests.find((request) => request.key === "PUT /setup/providers");
    expect(put?.body).toEqual({
      text: { provider: "openai", model: "gpt-5-mini", baseUrl: null, dimensions: null, structuredOutputs: null, dailyTokenLimit: 200000, dailyCallLimit: 500 },
    });
    expect(text()).toContain("Saved.");
  });

  it("keeps environment limits inherited when a saved role is edited", async () => {
    const inherited = {
      ...providers(),
      providers: { ...providers().providers, text: role({ storedDailyTokenLimit: null, storedDailyCallLimit: null }) },
    };
    const { api, requests } = fakeServer({
      "GET /setup/providers": { body: inherited },
      "PUT /setup/providers": { body: inherited },
    });
    await mount(api, <Providers />);
    expect(text()).toContain("uses AI_TEXT_DAILY_TOKEN_LIMIT (200000)");
    expect(root.querySelector<HTMLInputElement>("#text-tokens")!.value).toBe("");
    expect(root.querySelector<HTMLInputElement>("#text-tokens")!.placeholder).toBe("200000");

    await act(async () => input("text-model", "gpt-5-mini"));
    await click("Save changes");

    const put = requests.find((request) => request.key === "PUT /setup/providers");
    expect(put?.body).toMatchObject({ text: { model: "gpt-5-mini", dailyTokenLimit: null, dailyCallLimit: null } });
  });

  it("warns before a base URL change drops the stored key", async () => {
    const { api } = fakeServer({ "GET /setup/providers": { body: providers() } });
    await mount(api, <Providers />);
    await act(async () => input("text-base", "https://gateway.example/v1"));
    expect(text()).toContain("removes the stored key");
  });

  it("explains a missing APP_ENCRYPTION_KEY and disables key fields", async () => {
    const { api } = fakeServer({ "GET /setup/providers": { body: providers(false) } });
    await mount(api, <Providers />);
    expect(text()).toContain("API keys cannot be saved");
    expect(root.querySelector<HTMLInputElement>("#text-key")!.disabled).toBe(true);
  });

  it("shows provider test results and rate-limit messages", async () => {
    let calls = 0;
    const { api } = fakeServer({
      "GET /setup/providers": { body: providers() },
      "POST /setup/providers/test": () =>
        calls++ === 0
          ? { body: { results: { text: { ok: false, provider: "openai", model: "gpt-5", latencyMs: 80, error: "Incorrect API key" } } } }
          : { status: 429, body: { error: { code: "rate_limited", message: "Too many requests" } }, headers: { "retry-after": "10" } },
    });
    await mount(api, <Providers />);
    await click("Test all saved");
    expect(text()).toContain("Incorrect API key");
    await click("Test all saved");
    expect(text()).toContain("Too many attempts. Try again in 10 s.");
  });
});

describe("WhatsApp", () => {
  const session = {
    id: "0b7c7f8e-1111-4c4c-9999-123456789abc",
    name: "main",
    status: "qr_ready",
    phone: null,
    pushName: null,
    connectedAt: null,
    lastActive: null,
    engineLoaded: true,
    lastError: null,
    restriction: null,
  };
  const status = {
    configured: true,
    sessionId: session.id,
    reachable: true,
    paired: false,
    session,
    sessions: [],
    error: null,
    dashboardUrl: "http://127.0.0.1:2785/sessions",
    webhookUrl: "https://brain.example/webhooks/openwa",
  };

  it("links to the dashboard for pairing, with the SSH tunnel hint", async () => {
    const { api, requests } = fakeServer({
      "GET /setup/openwa/status": { body: status },
      "GET /setup/openwa/qr": {
        body: { mode: "dashboard", dashboardUrl: status.dashboardUrl, sessionId: session.id, sessionStatus: "qr_ready", paired: false, message: "Open the OpenWA dashboard, start the session, and scan its QR code." },
      },
    });
    await mount(api, <WhatsApp />);
    expect(requests.map((request) => request.key)).toContain("GET /setup/openwa/qr");
    expect(text()).toContain("Waiting for QR scan");
    expect(root.querySelector<HTMLAnchorElement>('a[href="http://127.0.0.1:2785/sessions"]')).not.toBeNull();
    expect(text()).toContain("ssh -L 2785:127.0.0.1:2785 you@your-server");
    expect(root.querySelector("svg.qr")).toBeNull();
  });

  it("shows test checks including warnings", async () => {
    const { api } = fakeServer({
      "GET /setup/openwa/status": { body: { ...status, paired: true, session: { ...session, status: "ready", pushName: "Alex" } } },
      "POST /setup/openwa/test": {
        body: {
          ok: true,
          checks: [
            { id: "reachable", label: "OpenWA reachable", ok: true, level: "ok", detail: "OpenWA answered" },
            { id: "role", label: "Key cannot send", ok: true, level: "warn", detail: "The key has the operator or admin role and could send messages." },
          ],
        },
      },
    });
    await mount(api, <WhatsApp />);
    expect(text()).toContain("Connected");
    expect(text()).not.toContain("Link WhatsApp in OpenWA");
    await click("Test read access");
    expect(text()).toContain("Read access works, with 1 warning.");
    expect(text()).toContain("could send messages");
  });

  it("explains a status problem and lists sessions to choose from", async () => {
    const { api } = fakeServer({
      "GET /setup/openwa/status": {
        body: {
          ...status,
          sessionId: null,
          session: null,
          sessions: [{ id: "abc-uuid", name: "main", status: "ready" }],
          error: { code: "no_session_id", message: "Set OPENWA_SESSION_ID to the id of the OpenWA session to read" },
        },
      },
    });
    await mount(api, <WhatsApp />);
    expect(text()).toContain("Choose a session");
    expect(text()).toContain("a UUID, not the name");
    expect(text()).toContain("abc-uuid");
    expect(button("Test read access").disabled).toBe(true);
  });

  it("shows the server's reason when the test answers 409", async () => {
    const { api } = fakeServer({
      "GET /setup/openwa/status": { body: status },
      "GET /setup/openwa/qr": { body: { mode: "dashboard", dashboardUrl: null, sessionId: session.id, sessionStatus: null, paired: false, message: "m" } },
      "POST /setup/openwa/test": { status: 409, body: { error: { code: "conflict", message: "OpenWA is not configured: set OPENWA_BASE_URL and OPENWA_READ_API_KEY" } } },
    });
    await mount(api, <WhatsApp />);
    expect(text()).toContain("OPENWA_DASHBOARD_URL");
    await click("Test read access");
    expect(text()).toContain("OpenWA is not configured: set OPENWA_BASE_URL");
  });
});

describe("HistoryImport", () => {
  const row = { chatId: "447691234567@c.us", chatName: "Ana", earliestAt: "2026-06-27T08:00:00.000Z", messageCount: 120, mediaOk: 0, mediaFailed: 0, gaps: [] };

  it("reports OpenWA's coverage, then starts a 90-day import and cancels it", async () => {
    let started = false;
    const { api, requests } = fakeServer({
      "GET /setup/import/coverage": () =>
        started
          ? { body: { items: [{ ...row, messageCount: 40, mediaOk: 3, mediaFailed: 1, gaps: ["media pending (2)"] }], run: { status: "running", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: null, progress: 0.4, error: null } } }
          : { body: { items: [row], run: null } },
      "POST /setup/import": () => {
        started = true;
        return { status: 202, body: { run: { status: "queued", startedAt: "2026-09-24T10:00:00.000Z" } } };
      },
      "DELETE /setup/import": { body: { run: { status: "cancelled", finishedAt: "2026-09-24T10:05:00.000Z" } } },
    });
    await mount(api, <HistoryImport />);
    expect(text()).toContain("never proposes tasks");
    expect(text()).toContain("What OpenWA holds for the last 90 days");
    expect(text()).toContain("Ana");
    expect(text()).not.toContain("Media ok / failed");

    await click("Import 90 days…");
    await click("Start import (model calls cost money)");
    expect(requests.find((request) => request.key === "POST /setup/import")?.body).toEqual({ days: 90 });
    expect(text()).toContain("Running");
    expect(text()).toContain("40%");
    expect(text()).toContain("imported history plus messages received live");
    expect(text()).toContain("media pending (2)");

    await click("Cancel import");
    expect(text()).toContain("Cancelled");
    expect(text()).toContain("Resume import…");
  });

  it("keeps the last report when a refresh is rate-limited", async () => {
    let calls = 0;
    const { api } = fakeServer({
      "GET /setup/import/coverage": () =>
        calls++ === 0 ? { body: { items: [row], run: null } } : { status: 429, body: { error: { code: "rate_limited", message: "Too many requests" } }, headers: { "retry-after": "55" } },
    });
    await mount(api, <HistoryImport />);
    await click("Refresh");
    expect(text()).toContain("Ana");
    expect(text()).toContain("about once a minute");
    expect(text()).toContain("55 s");
  });

  it("explains a missing OPENWA_SESSION_ID", async () => {
    const { api } = fakeServer({
      "GET /setup/import/coverage": { status: 409, body: { error: { code: "conflict", message: "Set OPENWA_SESSION_ID before checking history coverage" } } },
    });
    await mount(api, <HistoryImport />);
    expect(text()).toContain("The server needs configuration first");
    expect(text()).toContain("Set OPENWA_SESSION_ID");
  });
});

describe("Overview", () => {
  it("takes the WhatsApp state from the OpenWA status route", async () => {
    const { api } = fakeServer({
      "GET /setup/status": {
        body: {
          database: { ok: true },
          worker: { ok: true, lastSeenAt: new Date().toISOString() },
          openwa: { configured: true },
          providers: { configured: ["text"] },
          trial: { active: true, startedAt: "2026-09-20T00:00:00.000Z", endsAt: "2026-09-27T00:00:00.000Z", days: 7 },
          devices: { count: 0 },
        },
      },
      "GET /setup/openwa/status": {
        body: {
          configured: true,
          sessionId: "s",
          reachable: true,
          paired: true,
          session: { id: "s", name: null, status: "ready", phone: null, pushName: "Alex", connectedAt: null, lastActive: null, engineLoaded: true, lastError: null, restriction: null },
          sessions: [],
          error: null,
          dashboardUrl: null,
          webhookUrl: "https://brain.example/webhooks/openwa",
        },
      },
    });
    await mount(api, <Overview />);
    expect(text()).toContain("Connected");
    expect(text()).toContain("Linked as Alex");
  });
});

describe("Usage", () => {
  const usage = [
    { day: "2026-09-24", role: "text", provider: "openai", model: "gpt-6-luna", calls: 3, inputTokens: 1500, outputTokens: 70, audioSeconds: 0 },
    { day: "2026-09-25", role: "transcription", provider: "openai", model: "gpt-transcribe", calls: 1, inputTokens: 0, outputTokens: 0, audioSeconds: 90 },
  ];

  it("shows OpenAI's daily costs as a chart and tables, and usage per model", async () => {
    const { api } = fakeServer({
      "GET /setup/usage?days=30": {
        body: {
          since: "2026-08-27T00:00:00.000Z",
          days: 30,
          usage,
          costs: {
            status: "ok",
            projectId: null,
            days: [{ day: "2026-09-24", items: [{ lineItem: "gpt-6-luna, input", usd: 0.42 }, { lineItem: "gpt-6-luna, output", usd: 0.08 }] }],
          },
        },
      },
    });
    await mount(api, <Usage />);
    expect(text()).toContain("$0.50");
    expect(text()).toContain("whole OpenAI organization");
    expect(root.querySelectorAll(".usage-chart svg rect[rx]")).toHaveLength(2);
    expect([...root.querySelectorAll(".usage-legend li")].map((li) => li.textContent?.trim())).toEqual(["gpt-6-luna, input", "gpt-6-luna, output"]);
    expect(text()).toContain("gpt-transcribe");
    expect(text()).toContain("1.5 min");
    expect(text()).toContain("1,500");
  });

  it("explains how to enable costs without an admin key, and still shows usage", async () => {
    const { api } = fakeServer({
      "GET /setup/usage?days=30": { body: { since: "2026-08-27T00:00:00.000Z", days: 30, usage, costs: { status: "not_configured" } } },
    });
    await mount(api, <Usage />);
    expect(text()).toContain("OPENAI_ADMIN_KEY");
    expect(root.querySelector(".usage-chart")).toBeNull();
    expect(text()).toContain("gpt-6-luna");
  });
});
