import { createContext } from "preact";
import type { ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { describeError } from "../api";
import { MenuButton } from "../components/mobile";
import { useApi } from "../components/ui";
import type { Section } from "../sections";
import { workspaceApi } from "./api";
import type { ReviewItem, Snapshot, Task } from "./model";
import { TasksView } from "./Tasks";
import { PeopleView } from "./People";
import { ChatsView } from "./Chats";
import { AskView } from "./Ask";
import { SettingsView } from "./Settings";
import { applyReviewDecision, createKeyedOperationRunner, createRefreshCoordinator, mergeSyncResponse, upsertSnapshotTask } from "./sync";

export interface WorkspaceState {
  data: Snapshot;
  api: ReturnType<typeof workspaceApi>;
  busy: boolean;
  pending: (key: string) => boolean;
  refresh: () => Promise<void>;
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
  runKeyed: (key: string, operation: () => Promise<unknown>) => Promise<boolean>;
  runTask: (taskId: string, operation: () => Promise<Task>) => Promise<boolean>;
  runReview: (reviewId: string, operation: () => Promise<{ reviewItem: ReviewItem; task?: Task | null }>) => Promise<boolean>;
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
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const cursor = useRef<string | null>(null);
  const taskOverlays = useRef(new Map<string, Task>());
  const decidedReviews = useRef(new Set<string>());
  const coordinator = useMemo(() => createRefreshCoordinator(async () => {
    setSyncing(true);
    try {
      const response = await api.sync(cursor.current);
      setData((current) => {
        let next = mergeSyncResponse(current, response);
        for (const reviewId of decidedReviews.current) next = applyReviewDecision(next, reviewId);
        for (const task of taskOverlays.current.values()) next = upsertSnapshotTask(next, task);
        return next;
      });
      cursor.current = response.cursor;
      setLastSyncedAt(Date.now());
      setOnline(navigator.onLine !== false);
      setSyncFailed(false);
      setError(null);
    } catch (caught) {
      setSyncFailed(true);
      setError(describeError(caught));
      throw caught;
    } finally {
      setSyncing(false);
    }
  }), [api]);
  const refresh = useCallback(async () => {
    try { await coordinator.request(); } catch { /* The banner and freshness status carry the failure. */ }
  }, [coordinator]);

  const operations = useMemo(() => createKeyedOperationRunner({
    afterSuccess: refresh,
    onChange: setPendingKeys,
    onError: (caught) => setError(describeError(caught)),
  }), [refresh]);
  const runKeyed = useCallback((key: string, operation: () => Promise<unknown>) => {
    setError(null);
    return operations.run(key, operation);
  }, [operations]);
  const run = useCallback((operation: () => Promise<unknown>) => runKeyed("workspace", operation), [runKeyed]);
  const runTask = useCallback(async (taskId: string, operation: () => Promise<Task>) => {
    const adopted: { task: Task | null } = { task: null };
    const ok = await runKeyed(`task:${taskId}`, async () => {
      const task = await operation();
      taskOverlays.current.set(taskId, task);
      setData((current) => current ? upsertSnapshotTask(current, task) : current);
      adopted.task = task;
    });
    if (adopted.task && taskOverlays.current.get(taskId) === adopted.task) taskOverlays.current.delete(taskId);
    return ok;
  }, [runKeyed]);
  const runReview = useCallback(async (reviewId: string, operation: () => Promise<{ reviewItem: ReviewItem; task?: Task | null }>) => {
    let adopted = false;
    const adoptedResult: { task: Task | null } = { task: null };
    const ok = await runKeyed(`review:${reviewId}`, async () => {
      const result = await operation();
      decidedReviews.current.add(reviewId);
      if (result.task) {
        adoptedResult.task = result.task;
        taskOverlays.current.set(result.task.id, result.task);
      }
      setData((current) => current ? applyReviewDecision(current, reviewId, result.task) : current);
      adopted = true;
    });
    if (adopted) {
      decidedReviews.current.delete(reviewId);
      const task = adoptedResult.task;
      if (task && taskOverlays.current.get(task.id) === task) taskOverlays.current.delete(task.id);
    }
    return ok;
  }, [runKeyed]);

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
    const onVisible = () => { if (!document.hidden) void refresh(); };
    const onFocus = () => { if (!document.hidden) void refresh(); };
    const onOnline = () => { setOnline(true); void refresh(); };
    const onOffline = () => setOnline(false);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(notificationTimer);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [refresh, api]);

  if (!data) return <div class="ws-loading">{error ? <ErrorPanel message={error} onRetry={refresh} /> : <p>Loading your workspace…</p>}</div>;
  const busy = pendingKeys.has("workspace");
  const state: WorkspaceState = { data, api, busy, pending: (key) => pendingKeys.has(key), refresh, run, runKeyed, runTask, runReview };
  const View = props.section === "people" ? PeopleView
    : props.section === "chats" ? ChatsView
    : props.section === "ask" ? AskView
    : props.section === "settings" ? SettingsView
    : TasksView;
  return (
    <WorkspaceContext.Provider value={state}>
      <SyncStatus online={online} syncing={syncing} failed={syncFailed} lastSyncedAt={lastSyncedAt} onRetry={refresh} />
      {error ? <div class="ws-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError(null)}>Dismiss</button></div> : null}
      <View hash={props.hash} />
    </WorkspaceContext.Provider>
  );
}

function SyncStatus(props: { online: boolean; syncing: boolean; failed: boolean; lastSyncedAt: number | null; onRetry: () => Promise<void> }) {
  const time = props.lastSyncedAt === null ? null : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(props.lastSyncedAt);
  const label = !props.online
    ? `Offline${time ? ` · Last synced ${time}` : ""}`
    : props.syncing
      ? "Updating…"
      : props.failed
        ? `Update failed${time ? ` · Last synced ${time}` : ""}`
      : time
        ? `Synced ${time}`
        : "Connecting…";
  const unhealthy = !props.online || props.failed;
  return <div class={`ws-sync-status ${unhealthy ? "offline" : ""}`} role="status" aria-live="polite">
    <i aria-hidden="true" /><span>{label}</span>{props.online && props.failed && !props.syncing ? <button type="button" onClick={() => void props.onRetry()}>Retry</button> : null}
  </div>;
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
