import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useState } from "preact/hooks";
import { describeError } from "../api";
import { MenuButton } from "../components/mobile";
import { useApi } from "../components/ui";
import type { Section } from "../sections";
import { workspaceApi } from "./api";
import type { Snapshot } from "./model";
import { TasksView } from "./Tasks";
import { PeopleView } from "./People";
import { ChatsView } from "./Chats";
import { AskView } from "./Ask";
import { SettingsView } from "./Settings";

export interface WorkspaceState {
  data: Snapshot;
  api: ReturnType<typeof workspaceApi>;
  busy: boolean;
  refresh: () => Promise<void>;
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext);
  if (!state) throw new Error("Workspace context missing");
  return state;
}

export function Workspace(props: { section: Section; hash: string }) {
  const ownerApi = useApi();
  const api = useMemo(() => workspaceApi(ownerApi), [ownerApi]);
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await api.snapshot());
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    const checkNotifications = async () => {
      if (!("Notification" in window) || Notification.permission !== "granted" || !("serviceWorker" in navigator)) return;
      try {
        const registration = await navigator.serviceWorker.ready;
        const pending = await api.notifications();
        for (const item of pending.items) registration.active?.postMessage({ type: "workspace:show-notification", payload: item.payload });
      } catch { /* Push will retry; the workspace still works. */ }
    };
    void checkNotifications();
    const notificationTimer = window.setInterval(() => { if (!document.hidden) void checkNotifications(); }, 60_000);
    const onMessage = (event: MessageEvent) => { if (event.data?.type === "workspace:refresh") void refresh(); };
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(notificationTimer);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }, [refresh, api]);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
      return true;
    } catch (caught) {
      setError(describeError(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!data) return <div class="ws-loading">{error ? <ErrorPanel message={error} onRetry={refresh} /> : <p>Loading your workspace…</p>}</div>;
  const state: WorkspaceState = { data, api, busy, refresh, run };
  const View = props.section === "people" ? PeopleView
    : props.section === "chats" ? ChatsView
    : props.section === "ask" ? AskView
    : props.section === "settings" ? SettingsView
    : TasksView;
  return (
    <WorkspaceContext.Provider value={state}>
      {error ? <div class="ws-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div> : null}
      <View hash={props.hash} />
    </WorkspaceContext.Provider>
  );
}

function ErrorPanel(props: { message: string; onRetry: () => Promise<void> }) {
  return <div class="ws-panel"><h2>Could not load the workspace</h2><p>{props.message}</p><button type="button" class="ws-button primary" onClick={() => void props.onRetry()}>Try again</button></div>;
}

/**
 * Page header. On phones it collapses into the Android top bar: logo (top-level
 * screens), title, one subtitle line, the mobile-only trailing controls and the
 * menu button.
 */
export function WorkspaceHeader(props: { eyebrow: string; title: string; description?: string; actions?: ComponentChildren; logo?: boolean; subtitle?: string; trailing?: ComponentChildren }) {
  return <header class={`ws-header ${props.logo ? "top-level" : ""}`}>
    {props.logo ? <img class="ws-header-logo mobile-only" src="/logo.webp" alt="" width={38} height={38} /> : null}
    <div class="ws-header-text"><p class="ws-eyebrow">{props.eyebrow}</p><h1>{props.title}</h1>
      {props.description ? <p class="ws-header-description">{props.description}</p> : null}
      <p class="ws-header-subtitle mobile-only">{props.subtitle ?? props.eyebrow}</p></div>
    <div class="ws-header-actions">{props.actions}{props.trailing}<MenuButton /></div>
  </header>;
}

export function EmptyState(props: { title: string; children?: ComponentChildren }) {
  return <div class="ws-empty"><span aria-hidden="true">✦</span><h2>{props.title}</h2>{props.children ? <p>{props.children}</p> : null}</div>;
}

export function ContextBadge(props: { name: string; color?: string | null }) {
  return <span class="ws-context"><i style={{ backgroundColor: props.color ?? "#a4b8ad" }} />{props.name}</span>;
}

export function Dialog(props: { title: string; children: ComponentChildren; onClose: () => void; wide?: boolean }) {
  return <div class="ws-modal-backdrop">
    <section class={`ws-modal ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.title}>
      <div class="ws-modal-head"><h2>{props.title}</h2><button type="button" class="ws-icon-button" aria-label="Close" onClick={props.onClose}>×</button></div>
      {props.children}
    </section>
  </div>;
}
