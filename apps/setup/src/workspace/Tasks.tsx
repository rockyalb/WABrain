import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError } from "../api";
import { Icon } from "../components/mobile";
import type { CreateTaskAction, TaskSort } from "@wabrain/contracts";
import { Combobox } from "./Combobox";
import { ContextBadge, Dialog, EmptyState, useWorkspace, WorkspaceHeader } from "./Workspace";
import type { LinkInput, NewTask, TaskPatch } from "./api";
import { chatLabel, closedRecently, contextName, dateKey, displayDate, displayTime, effectiveContext, linkLabel, reviewLabel, reviewTitle, taskActivityToday, timeKey, todayKey, zonedDateTime } from "./model";
import { jidPhone } from "./model";
import type { MessageView, ReviewItem, Task, TaskDetail as Detail, TaskLink } from "./model";
import { reviewTargetFromHash } from "./review-target";
import { savedTaskSort, sortTasks, TASK_SORT_KEY, TASK_SORT_OPTIONS } from "./task-sort";

type TaskTab = "today" | "upcoming" | "waiting" | "review" | "closed";
type ReviewTargetState = "loading" | "pending" | "accepted" | "rejected" | "missing" | "unavailable";
const TABS: Array<{ id: TaskTab; label: string }> = [
  { id: "today", label: "Today" }, { id: "upcoming", label: "Upcoming" }, { id: "waiting", label: "Waiting on" },
  { id: "review", label: "Review" }, { id: "closed", label: "Closed" },
];

export function TasksView(props: { hash: string }) {
  const { data, api, run, runTask, runReview, pending, refresh } = useWorkspace();
  const [context, setContext] = useState<string>("all");
  const [sort, setSort] = useState<TaskSort>(savedTaskSort);
  useEffect(() => {
    try { window.localStorage.setItem(TASK_SORT_KEY, sort); } catch { /* Sorting still works when storage is unavailable. */ }
  }, [sort]);
  const [editor, setEditor] = useState<"new" | ReviewItem | null>(null);
  const [contact, setContact] = useState("");
  const [targetResult, setTargetResult] = useState<{ id: string; state: ReviewTargetState; taskId: string | null } | null>(null);
  const [targetAttempt, setTargetAttempt] = useState(0);
  const segments = props.hash.replace(/^#\/?/, "").split("?")[0]!.split("/");
  const sub = segments[1];
  const tab: TaskTab = TABS.some((item) => item.id === sub) ? sub as TaskTab : "today";
  const detailId = sub && !TABS.some((item) => item.id === sub) ? decodeURIComponent(sub) : null;
  const reviewTarget = tab === "review" ? reviewTargetFromHash(props.hash) : null;
  const targetVisible = reviewTarget ? data.reviewItems.some((item) => item.id === reviewTarget) : false;
  // Searching by contact reaches closed tasks older than the synced week; opening a task and coming back reloads it.
  const closedSearch = useClosedSearch(tab === "closed" ? contact : "", detailId, sort);
  const contactOptions = useMemo(() => [...data.people]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((person) => ({ value: person.id, label: person.displayName, detail: person.jids.map(jidPhone).find(Boolean) ?? undefined })), [data.people]);
  useEffect(() => {
    let cancelled = false;
    setTargetResult(null);
    if (!reviewTarget || targetVisible) return () => { cancelled = true; };
    setTargetResult({ id: reviewTarget, state: "loading", taskId: null });
    void api.review(reviewTarget).then(async (result) => {
      if (cancelled) return;
      if (result.reviewItem?.state === "pending") {
        await refresh();
        if (!cancelled) setTargetResult({ id: reviewTarget, state: "pending", taskId: result.task?.id ?? null });
        return;
      }
      setTargetResult({ id: reviewTarget, state: result.reviewItem?.state ?? "missing", taskId: result.task?.id ?? null });
    }, (error: unknown) => {
      if (!cancelled) setTargetResult({ id: reviewTarget, state: error instanceof ApiError && error.status === 404 ? "missing" : "unavailable", taskId: null });
    });
    return () => { cancelled = true; };
  }, [api, refresh, reviewTarget, targetVisible, targetAttempt]);
  if (detailId) return <TaskDetailView id={detailId} />;

  const currentDate = todayKey(data.settings);
  const contextMatches = (task: Task) => context === "all" || effectiveContext(task, data) === context;
  const searching = tab === "closed" && contact !== "";
  const tasks = sortTasks((searching ? closedSearch.tasks : data.tasks).filter((task) => {
    if (!contextMatches(task)) return false;
    if (tab === "closed") return searching || (task.status !== "open" && closedRecently(task, data.settings));
    if (task.status !== "open") return false;
    if (tab === "waiting") return task.kind === "waiting_on";
    if (task.kind !== "todo") return false;
    const due = dateKey(task.dueAt, data.settings);
    return tab === "today" ? due !== null && due <= currentDate : due === null || due > currentDate;
  }), sort, tab === "closed");
  const review = data.reviewItems.filter((item) => {
    if (item.id === reviewTarget) return true;
    if (context === "all") return true;
    const task = item.taskId ? data.tasks.find((candidate) => candidate.id === item.taskId) : null;
    const candidate = task ?? { contextId: item.action.type === "create" ? item.action.contextId : null, chatId: item.chatId, personId: item.personId };
    return effectiveContext(candidate, data) === context;
  });

  const accept = async (item: ReviewItem, edits?: TaskPatch) => {
    if (await runReview(item.id, () => api.decide(item.id, true, edits))) setEditor(null);
  };

  const openToday = data.tasks.filter((task) => task.status === "open" && task.kind === "todo" && (dateKey(task.dueAt, data.settings) ?? "9999") <= currentDate).length;
  const activity = taskActivityToday(data.tasks, data.settings);
  const headerDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", ...(data.settings.timezone ? { timeZone: data.settings.timezone } : {}) }).format(new Date());

  return <>
    <WorkspaceHeader eyebrow="Your day, in focus" title="Tasks" description="Everything captured from your conversations, ready when you are." logo
      subtitle={`${headerDate} · ${openToday} open`}
      trailing={<><ProgressRing completed={activity.completed} created={activity.created} /><RefreshButton onRefresh={refresh} /></>}
      actions={<button class="ws-button primary desktop-only" type="button" onClick={() => setEditor("new")}>＋ New task</button>} />
    <a class="m-ask-bar mobile-only" href="#/ask"><Icon name="sparkle" size={21} /><span>Ask your chats…</span><b>AI</b></a>
    <div class="ws-toolbar">
      <nav class="ws-tabs" aria-label="Task views">{TABS.map((item) => <a key={item.id} href={`#/tasks/${item.id}`} class={tab === item.id ? "active" : ""}>
        {item.label}{item.id === "review" && data.reviewItems.length ? <b>{data.reviewItems.length}</b> : null}
      </a>)}</nav>
      <div class="ws-task-filters"><label class="ws-filter desktop-only">Context <select value={context} onChange={(event) => setContext(event.currentTarget.value)}>
        <option value="all">All contexts</option>{data.contexts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
      {tab !== "review" ? <label class="ws-filter ws-task-sort">Sort by <select value={sort} onChange={(event) => setSort(event.currentTarget.value as TaskSort)}>
        {TASK_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label> : null}</div>
    </div>
    {tab !== "review" ? <div class="m-chips mobile-only" role="group" aria-label="Context">
      <button type="button" class={context === "all" ? "active" : ""} aria-pressed={context === "all"} onClick={() => setContext("all")}>All</button>
      {data.contexts.map((item) => <button type="button" key={item.id} class={context === item.id ? "active" : ""} aria-pressed={context === item.id} onClick={() => setContext(item.id)}>
        <i style={{ backgroundColor: item.color ?? "#a4b8ad" }} />{item.name}</button>)}
    </div> : null}
    {tab === "closed" ? <div class="ws-closed-filter">
      <Combobox label="Contact" value={contact} options={contactOptions} onChange={setContact} emptyLabel="Today & yesterday" placeholder="Type a name or number" />
      <p class="ws-muted">{searching ? "Every closed task for this contact, in your selected order." : "Showing tasks closed today and yesterday. Pick a contact to search all closed tasks."}</p>
    </div> : null}
    {tab === "review" && reviewTarget && !targetVisible && targetResult?.id === reviewTarget ? <ReviewTargetNotice state={targetResult.state} taskId={targetResult.taskId} onRetry={() => setTargetAttempt((value) => value + 1)} /> : null}
    {tab === "review" ? (review.length ? <div class="ws-card-list">{review.map((item) => {
      const disabled = pending(`review:${item.id}`);
      return <ReviewCard key={item.id} item={item} targeted={item.id === reviewTarget} onAccept={() => void accept(item)} onClose={(status) => void runReview(item.id, () => api.decide(item.id, true, undefined, status))} onEdit={() => setEditor(item)} onReject={() => void runReview(item.id, () => api.decide(item.id, false))} disabled={disabled} />;
    })}</div>
      : !reviewTarget ? <EmptyState title="Review is clear">New proposals and possible changes will appear here.</EmptyState> : null)
      : tasks.length ? <div class="ws-card-list">{tasks.map((task) => <TaskRow key={task.id} task={task} onComplete={() => runTask(task.id, () => api.taskStatus(task.id, "complete"))} disabled={pending(`task:${task.id}`)} />)}</div>
      : searching && closedSearch.loading ? <p class="ws-muted">Loading closed tasks…</p>
      : <EmptyState title={searching ? "No closed tasks for this contact" : tab === "today" ? "Nothing due today" : tab === "closed" ? "Nothing closed today or yesterday" : "No tasks here"}>{tab === "closed" ? "Pick a contact to search older closed tasks." : "Change the context filter or add a task to get started."}</EmptyState>}
    {searching && closedSearch.error ? <p class="ws-muted" role="alert">{closedSearch.error}</p> : null}
    {searching && closedSearch.next ? <button type="button" class="ws-button ws-load-more" disabled={closedSearch.loading} onClick={() => void closedSearch.more()}>{closedSearch.loading ? "Loading…" : "Load more"}</button> : null}
    <button type="button" class="m-fab mobile-only" aria-label="New task" onClick={() => setEditor("new")}><Icon name="plus" size={26} width={2.4} /></button>
    {editor === "new" ? <TaskEditor title="New task" onClose={() => setEditor(null)} onSave={(draft) => void run(() => api.createTask(draft)).then((ok) => { if (ok) setEditor(null); })} /> : null}
    {editor && editor !== "new" && editor.action.type === "create" ? <TaskEditor title="Edit and accept" initial={editor.action} disabled={pending(`review:${editor.id}`)} onClose={() => setEditor(null)} onSave={(draft) => void accept(editor, draft)} /> : null}
  </>;
}

function ReviewTargetNotice(props: { state: ReviewTargetState; taskId: string | null; onRetry: () => void }) {
  if (props.state === "loading") return <div class="ws-target-notice" role="status"><span class="spinner" /> Finding this review item…</div>;
  const text = props.state === "accepted" ? "This review item was already accepted."
    : props.state === "rejected" ? "This review item was already rejected."
    : props.state === "pending" ? "This item is still pending, but the list could not be refreshed."
    : props.state === "unavailable" ? "This review item could not be checked right now."
    : "This review item is no longer available. It may already have been handled.";
  return <div class="ws-target-notice" role="status"><span>{text}</span><span class="ws-actions">
    {props.taskId ? <a class="ws-button" href={`#/tasks/${encodeURIComponent(props.taskId)}`}>Open task</a> : null}
    {props.state === "pending" || props.state === "unavailable" ? <button type="button" class="ws-button subtle" onClick={props.onRetry}>Try again</button> : null}</span></div>;
}

/** Closed tasks for one contact in the selected order, reaching past the synced week. */
function useClosedSearch(personId: string, refetchKey: string | null, sort: TaskSort) {
  const { api } = useWorkspace();
  const [state, setState] = useState<{ key: string; tasks: Task[]; next: string | null; loading: boolean; error: string | null }>({ key: "", tasks: [], next: null, loading: false, error: null });
  const key = JSON.stringify([personId, sort, refetchKey]);
  const current = useRef(key);
  const request = useRef(0);
  current.current = key;
  useEffect(() => () => { request.current += 1; }, []);
  const load = async (target: string, cursor: string | null) => {
    const attempt = ++request.current;
    setState((prev) => ({ ...prev, key, loading: true, error: null, ...(cursor ? {} : { tasks: [], next: null }) }));
    try {
      const page = await api.closedTasks(target, cursor, sort);
      if (current.current !== key || request.current !== attempt) return;
      setState((prev) => ({ key, tasks: cursor ? [...prev.tasks, ...page.items.filter((item) => !prev.tasks.some((task) => task.id === item.id))] : page.items, next: page.nextCursor, loading: false, error: null }));
    } catch {
      if (current.current === key && request.current === attempt) setState((prev) => ({ ...prev, loading: false, error: "Closed tasks could not be loaded." }));
    }
  };
  useEffect(() => {
    if (personId && !refetchKey) void load(personId, null);
  }, [personId, refetchKey, sort]);
  const fresh = state.key === key;
  return { tasks: fresh ? state.tasks : [], next: fresh ? state.next : null, loading: !fresh || state.loading, error: fresh ? state.error : null, more: () => (fresh && !state.loading && state.next ? load(personId, state.next) : Promise.resolve()) };
}

/** Completed-today vs created-today ring, as in the Android Tasks header. */
function ProgressRing(props: { completed: number; created: number }) {
  if (props.completed === 0 && props.created === 0) return null;
  const circumference = 2 * Math.PI * 17;
  // Tasks completed today may have been created earlier, so the ring can fill before today's count is reached.
  const fraction = props.created === 0 ? 1 : Math.min(props.completed / props.created, 1);
  return <span class="m-ring mobile-only" role="img" aria-label={`${props.completed} completed today, ${props.created} created today`}>
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="17" /><circle cx="22" cy="22" r="17" class="m-ring-value"
      style={{ strokeDasharray: circumference, strokeDashoffset: circumference * (1 - fraction) }} /></svg>
    <b>{props.completed}/{props.created}</b>
  </span>;
}

function RefreshButton(props: { onRefresh: () => Promise<void> }) {
  const [spinning, setSpinning] = useState(false);
  const click = async () => {
    setSpinning(true);
    try { await props.onRefresh(); } finally { setSpinning(false); }
  };
  return <button type="button" class={`m-icon-button mobile-only ${spinning ? "spinning" : ""}`} aria-label="Refresh" disabled={spinning} onClick={() => void click()}><Icon name="refresh" /></button>;
}

const BURST_ANGLES = [0, 60, 120, 180, 240, 300];

/**
 * Ticking the circle fills it, strikes the title through, bursts sparkles and
 * slides the card away, as on Android. The request runs alongside the motion;
 * if the change is refused, the card comes back.
 */
async function playCompletion(card: HTMLElement): Promise<void> {
  if (!card.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const slide = card.animate(
    [{ transform: "none", opacity: 1 }, { transform: "translateX(55%) scale(.96)", opacity: 0 }],
    { duration: 420, delay: 620, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" },
  );
  await slide.finished;
  const style = getComputedStyle(card);
  card.style.overflow = "hidden";
  card.style.minHeight = "0";
  const collapse = card.animate(
    [
      { height: `${card.offsetHeight}px`, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, marginBottom: "0px" },
      { height: "0px", paddingTop: "0px", paddingBottom: "0px", marginBottom: "-.85rem" },
    ],
    { duration: 260, easing: "ease-in-out", fill: "forwards" },
  );
  await collapse.finished;
}

function TaskRow(props: { task: Task; onComplete: () => Promise<boolean>; disabled: boolean }) {
  const { data } = useWorkspace();
  const card = useRef<HTMLElement>(null);
  const [closing, setClosing] = useState(false);
  const complete = async () => {
    if (closing || !card.current) return;
    const element = card.current;
    setClosing(true);
    const animation = playCompletion(element).catch(() => {});
    const succeeded = await props.onComplete();
    if (succeeded) {
      await animation;
      return;
    }
    for (const animation of element.getAnimations()) animation.cancel();
    element.style.overflow = "";
    element.style.minHeight = "";
    setClosing(false);
  };
  const contextId = effectiveContext(props.task, data);
  const context = data.contexts.find((item) => item.id === contextId);
  const linked = data.chats.find((chat) => chat.id === props.task.chatId)?.name ?? data.people.find((person) => person.id === props.task.personId)?.displayName;
  const links = linkLabel(props.task.links, data);
  const unconfirmed = props.task.links?.some((link) => !link.chatId);
  const checked = closing || props.task.status !== "open";
  const href = `#/tasks/${encodeURIComponent(props.task.id)}`;
  // The whole card opens the task; the check, links and selected text keep their own behaviour.
  const open = (event: JSX.TargetedMouseEvent<HTMLElement>) => {
    if (closing || (event.target as Element).closest("a, button") || window.getSelection()?.toString()) return;
    location.hash = href;
  };
  // biome-ignore lint/a11y/useKeyWithClickEvents: the title link is the keyboard route; the card click only widens the pointer target.
  return <article ref={card} class={`ws-task-card ${closing ? "closing" : ""}`} onClick={open}>
    <button type="button" class={`ws-check ${checked ? "checked" : ""}`} aria-label={`Complete ${props.task.title}`} disabled={closing || props.disabled || props.task.status !== "open"} onClick={() => void complete()}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      {closing ? <span class="ws-burst" aria-hidden="true">{BURST_ANGLES.map((angle) => <i key={angle} style={{ "--a": `${angle}deg` }} />)}</span> : null}
    </button>
    <div class="ws-task-content"><a class="ws-task-title" href={href}>{props.task.title}</a>
      {props.task.description ? <p>{props.task.description}</p> : null}
      <div class="ws-task-meta"><span class={`ws-due-date ${props.task.dueAt && new Date(props.task.dueAt) < new Date() && props.task.status === "open" ? "overdue" : ""}`}>{props.task.dueAt ? (props.task.dueHasTime ? displayTime(props.task.dueAt, data.settings) : displayDate(props.task.dueAt, data.settings)) : "No due date"}
          {props.task.status === "open" && props.task.createdBy === "ai" ? <span class="ws-ai-mark" role="img" aria-label="Created by AI" title="Created by AI"><Icon name="sparkle" size={15} /></span> : null}
        </span>
        {context ? <ContextBadge name={context.name} color={context.color} /> : null}
        {linked ? <span>↗ {linked}</span> : null}
        {links ? <span class={unconfirmed ? "ws-link-unconfirmed" : ""} title={unconfirmed ? "Open the task to say who this is" : "These chats can also close this task"}>{links}</span> : null}{props.task.kind === "waiting_on" ? <span>Waiting on</span> : null}
        {props.task.status !== "open" ? <span class="ws-closed-date">{props.task.status === "done" ? "Done" : "Cancelled"} {displayDate(props.task.closedAt ?? props.task.updatedAt, data.settings)}
          {props.task.closedBy === "ai" ? <span class="ws-ai-mark" role="img" aria-label="Closed by AI" title="Closed by AI"><Icon name="sparkle" size={15} /></span> : null}
        </span> : null}
      </div>
    </div><a class="ws-row-arrow desktop-only" href={href} aria-label={`Open ${props.task.title}`}>↗</a>
  </article>;
}

function ReviewCard(props: { item: ReviewItem; targeted: boolean; onAccept: () => void; onClose: (status: "done" | "cancelled") => void; onEdit: () => void; onReject: () => void; disabled: boolean }) {
  const { data } = useWorkspace();
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.targeted || !card.current) return;
    const frame = requestAnimationFrame(() => {
      card.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      card.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.targeted, props.item.id]);
  const chat = data.chats.find((candidate) => candidate.id === props.item.chatId);
  const person = data.people.find((candidate) => candidate.id === props.item.personId);
  const confirmation = props.item.type === "possibly_done" || props.item.type === "possibly_cancelled";
  // "Confirm contact": the contacts a task created on its own was linked to (already active).
  const linkAction = props.item.action.type === "link" ? props.item.action : null;
  const linkedTask = linkAction ? data.tasks.find((candidate) => candidate.id === linkAction.taskId) : undefined;
  const links = linkAction ? linkLabel(linkedTask?.links ?? linkAction.links, data) : props.item.action.type === "create" ? linkLabel(props.item.action.links, data) : null;
  const firstEvidence = props.item.action.evidenceMessageIds[0];
  // A later message suggests this proposal was already dealt with before it was reviewed.
  const handled = props.item.type === "create" ? props.item.handled : null;
  const handledEvidence = handled?.evidenceMessageIds[0];
  return <article ref={card} tabIndex={props.targeted ? -1 : undefined} class={`ws-review-card ${props.targeted ? "targeted" : ""}`}>
    <div class="ws-review-top"><span class="ws-review-kind">{reviewLabel(props.item)}</span><span class="ws-muted">{displayDate(props.item.createdAt)}</span></div>
    <h2>{linkAction ? linkedTask?.title ?? props.item.summary : reviewTitle(props.item)}</h2>
    {linkAction ? <p>Messages in these chats can mark the task done. Open the task to add or pick contacts.</p>
      : props.item.summary && props.item.summary !== reviewTitle(props.item) ? <p>{props.item.summary}</p> : null}
    <div class="ws-task-meta">{chat ? <span>{chat.name ?? "Chat"}</span> : null}{person ? <span>{person.displayName}</span> : null}
      {links ? <span>{links}</span> : null}
      {props.item.taskId ? <a href={`#/tasks/${encodeURIComponent(props.item.taskId)}`}>Open task</a> : null}
      {chat && firstEvidence ? <a href={`#/chats/${encodeURIComponent(chat.id)}?around=${encodeURIComponent(firstEvidence)}`}>View source</a> : null}
    </div>
    {handled ? <div class="ws-review-hint" role="note">
      <strong>{handled.status === "done" ? "May already be done" : "May no longer be needed"}</strong>
      {handled.excerpt ? <q>{handled.excerpt}</q> : null}
      <span class="ws-muted">{handled.fromOwner ? "You" : (person?.displayName ?? chat?.name ?? "Contact")}{chat && handledEvidence ? <> · <a href={`#/chats/${encodeURIComponent(chat.id)}?around=${encodeURIComponent(handledEvidence)}`}>View message</a></> : null}</span>
    </div> : null}
    {handled ? <div class="ws-actions"><button class="ws-button primary" type="button" disabled={props.disabled} onClick={() => props.onClose(handled.status)}>{handled.status === "done" ? "Already done" : "No longer needed"}</button>
      <button class="ws-button" type="button" disabled={props.disabled} onClick={props.onAccept}>Keep as open task</button>
      <button class="ws-button subtle" type="button" disabled={props.disabled} onClick={props.onReject}>Reject</button></div>
    : linkAction ? <div class="ws-actions"><button class="ws-button primary" type="button" disabled={props.disabled} onClick={props.onAccept}>Accept</button>
      <button class="ws-button subtle" type="button" disabled={props.disabled} onClick={props.onReject}>Remove</button></div>
    : <div class="ws-actions"><button class="ws-button primary" type="button" disabled={props.disabled} onClick={props.onAccept}>{confirmation ? "Done" : "Accept"}</button>
      {props.item.action.type === "create" ? <button class="ws-button" type="button" disabled={props.disabled} onClick={props.onEdit}>Edit & accept</button> : null}
      <button class="ws-button subtle" type="button" disabled={props.disabled} onClick={props.onReject}>{confirmation ? "Not yet" : "Reject"}</button></div>}
  </article>;
}

function TaskDetailView(props: { id: string }) {
  const { api, data, runTask, pending } = useWorkspace();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const load = async () => { try { setDetail(await api.task(props.id)); setError(null); } catch { setError("This task could not be loaded."); } };
  useEffect(() => { void load(); }, [props.id]);
  const operationKey = `task:${props.id}`;
  const busy = pending(operationKey);
  const change = async (operation: () => Promise<Task>) => { const ok = await runTask(props.id, operation); if (ok) void load(); return ok; };
  if (!detail) return <><a class="ws-back" href="#/tasks">← Tasks</a><div class="ws-panel">{error ?? "Loading task…"}</div></>;
  const task = detail.task;
  const contextId = effectiveContext(task, data);
  const context = data.contexts.find((item) => item.id === contextId);
  const chat = data.chats.find((item) => item.id === task.chatId);
  const person = data.people.find((item) => item.id === task.personId);
  return <>
    <a class="ws-back" href="#/tasks">← Tasks</a>
    <WorkspaceHeader eyebrow={task.status === "open" ? task.kind === "waiting_on" ? "Waiting on" : "Open task" : task.status} title={task.title}
      actions={<div class="ws-actions"><button class="ws-button" type="button" onClick={() => setEditing(true)}>Edit</button>
        {task.status === "open" ? <><button type="button" class="ws-button primary" disabled={busy} onClick={() => void change(() => api.taskStatus(task.id, "complete"))}>Mark done</button><button type="button" class="ws-button subtle" disabled={busy} onClick={() => void change(() => api.taskStatus(task.id, "cancel"))}>Cancel</button></>
          : <button type="button" class="ws-button primary" disabled={busy} onClick={() => void change(() => api.taskStatus(task.id, "reopen"))}>Reopen</button>}</div>} />
    <div class="ws-detail-grid"><section class="ws-panel"><h2>Details</h2>{task.description ? <p class="ws-description">{task.description}</p> : <p class="ws-muted">No description.</p>}
      <dl class="ws-details"><div><dt>Due</dt><dd>{task.dueAt ? task.dueHasTime ? displayTime(task.dueAt, data.settings) : displayDate(task.dueAt, data.settings) : "No due date"}</dd></div>
        <div><dt>Context</dt><dd>{context ? <ContextBadge name={context.name} color={context.color} /> : contextName(null, data.contexts)}</dd></div>
        <div><dt>Source</dt><dd>{task.origin === "manual" ? "Added by you" : task.origin === "ai" ? "From a conversation" : "History import"}</dd></div>
        {chat ? <div><dt>Chat</dt><dd><a href={`#/chats/${encodeURIComponent(chat.id)}`}>{chat.name ?? chat.jid}</a></dd></div> : null}
        {person ? <div><dt>Person</dt><dd><a href={`#/people/${encodeURIComponent(person.id)}`}>{person.displayName}</a></dd></div> : null}</dl>
      <TaskLinks task={task} disabled={busy} onSave={(links) => void change(() => api.updateTask(task.id, { links }))} /></section>
      <section class="ws-panel"><h2>Evidence</h2>{detail.evidence.length ? detail.evidence.map((message) => <Evidence key={message.id} message={message} />) : <p class="ws-muted">No linked messages.</p>}</section>
    </div>
    <section class="ws-panel ws-history"><h2>History</h2>{detail.events.length ? detail.events.map((event) => <div class="ws-history-row" key={event.id}><div><b>{event.type.replace("_", " ")}</b><span>{event.actor} · {displayTime(event.createdAt, data.settings)}</span></div>
      {event.undoableUntil && !event.undoneAt && new Date(event.undoableUntil) > new Date() ? <button type="button" class="ws-text-button" disabled={busy} onClick={() => void change(() => api.undo(event.id))}>Undo</button> : null}</div>) : <p class="ws-muted">No changes yet.</p>}</section>
    {editing ? <TaskEditor title="Edit task" initial={task} disabled={busy} onClose={() => setEditing(false)} onSave={(patch) => void change(() => api.updateTask(task.id, patch)).then((ok) => { if (ok) setEditing(false); })} /> : null}
  </>;
}

const linkInputs = (links: readonly TaskLink[]): LinkInput[] => links.map((link) => ({ name: link.name, chatId: link.chatId }));

/**
 * "Also closed from": the other chats this task involves, which may mark it done. A name that matched
 * no single chat asks "Who is “Robin”?" with the suggested chats first; any link can be removed, and
 * another chat linked by hand.
 */
function TaskLinks(props: { task: Task; disabled: boolean; onSave: (links: LinkInput[]) => void }) {
  const { data } = useWorkspace();
  const links = props.task.links ?? [];
  // Chats that could close it: not its own chat, and not Off (Off chats are never read).
  const linkable = data.chats.filter((chat) => chat.id !== props.task.chatId && chat.mode !== "off");
  const option = (chatId: string) => ({ value: chatId, label: chatLabel(chatId, data) ?? chatId });
  const free = linkable.filter((chat) => !links.some((link) => link.chatId === chat.id)).map((chat) => option(chat.id));
  return <div class="ws-links"><h3>Also closed from</h3>
    {links.length === 0 ? <p class="ws-muted">No other chats. Link one when another conversation can finish this task, like sending Jordan the list Casey asked for.</p> : null}
    {links.map((link) => {
      const remove = () => props.onSave(linkInputs(links.filter((other) => other !== link)));
      if (link.chatId) {
        return <div class="ws-link-row" key={link.chatId}><a href={`#/chats/${encodeURIComponent(link.chatId)}`}>→ {chatLabel(link.chatId, data) ?? link.name}</a>
          <button type="button" class="ws-text-button" disabled={props.disabled} aria-label={`Remove link to ${chatLabel(link.chatId, data) ?? link.name}`} onClick={remove}>Remove</button></div>;
      }
      const suggested = link.candidates.filter((candidate) => linkable.some((chat) => chat.id === candidate.chatId)).map((candidate) => ({ ...option(candidate.chatId), detail: "Suggested" }));
      const options = [...suggested, ...free.filter((item) => !suggested.some((s) => s.value === item.value))];
      const pick = (chatId: string) => { if (chatId) props.onSave(links.map((other) => ({ name: other.name, chatId: other === link ? chatId : other.chatId }))); };
      return <div class="ws-link-row unconfirmed" key={`name:${link.name}`}>
        <Combobox label={`Who is “${link.name}”?`} value="" options={options} onChange={pick} emptyLabel="Choose a chat" placeholder="Search chats" />
        <button type="button" class="ws-text-button" disabled={props.disabled} aria-label={`Remove “${link.name}”`} onClick={remove}>Remove</button></div>;
    })}
    {links.length < 5 && free.length ? <Combobox label="Add contact" value="" options={free} onChange={(chatId) => { if (chatId) props.onSave([...linkInputs(links), { chatId }]); }} emptyLabel="Choose a chat" placeholder="Search chats" /> : null}
  </div>;
}

export function Evidence(props: { message: MessageView }) {
  return <div class="ws-evidence"><div><b>{props.message.fromOwner ? "You" : props.message.senderName ?? "Contact"}</b><time>{displayTime(props.message.at)}</time></div>
    <p>{props.message.body || props.message.derivedText || "Media message"}</p><a href={`#/chats/${encodeURIComponent(props.message.chatId)}?around=${encodeURIComponent(props.message.id)}`}>Open conversation ↗</a></div>;
}

export function TaskEditor(props: { title: string; initial?: Task | CreateTaskAction; create?: boolean; disabled?: boolean; onClose: () => void; onSave: (draft: NewTask) => void; suggestedChatId?: string | null; suggestedPersonId?: string | null }) {
  const { data, busy } = useWorkspace();
  const initial = props.initial;
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [kind, setKind] = useState<Task["kind"]>(initial?.kind ?? "todo");
  const [contextId, setContextId] = useState(initial?.contextId ?? "");
  const [date, setDate] = useState(initial?.dueAt ? dateKey(initial.dueAt, data.settings) ?? "" : "");
  const [time, setTime] = useState(initial?.dueAt && initial.dueHasTime ? timeKey(initial.dueAt, data.settings) : "");
  const [chatId, setChatId] = useState("chatId" in (initial ?? {}) ? (initial as Task).chatId ?? "" : props.suggestedChatId ?? "");
  const [personId, setPersonId] = useState("personId" in (initial ?? {}) ? (initial as Task).personId ?? "" : props.suggestedPersonId ?? "");
  const submit = (event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    const dueAt = date ? time ? zonedDateTime(date, time, data.settings.timezone) : date : null;
    props.onSave({ title: title.trim(), description, kind, contextId: contextId || null, dueAt, dueHasTime: Boolean(time), ...(!initial || props.create ? { chatId: chatId || null, personId: personId || null } : {}) });
  };
  return <Dialog title={props.title} onClose={props.onClose} wide><form onSubmit={submit} class="ws-form">
    <label>Title<input required maxLength={180} autoFocus value={title} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
    <label>Description<textarea rows={3} maxLength={4000} value={description} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
    <div class="ws-form-grid"><label>Type<select value={kind} onChange={(event) => setKind(event.currentTarget.value as Task["kind"])}><option value="todo">To do</option><option value="waiting_on">Waiting on</option></select></label>
      <label>Context<select value={contextId} onChange={(event) => setContextId(event.currentTarget.value)}><option value="">Inherit / unsorted</option>{data.contexts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label></div>
    <div class="ws-form-grid"><label>Due date<input type="date" value={date} onInput={(event) => setDate(event.currentTarget.value)} /></label><label>Time (optional)<input type="time" value={time} onInput={(event) => setTime(event.currentTarget.value)} disabled={!date} /></label></div>
    {!initial || props.create ? <div class="ws-form-grid"><label>Chat (optional)<select value={chatId} onChange={(event) => setChatId(event.currentTarget.value)}><option value="">None</option>{data.chats.map((item) => <option value={item.id} key={item.id}>{item.name ?? item.jid}</option>)}</select></label>
      <label>Person (optional)<select value={personId} onChange={(event) => setPersonId(event.currentTarget.value)}><option value="">None</option>{data.people.map((item) => <option value={item.id} key={item.id}>{item.displayName}</option>)}</select></label></div> : null}
    <div class="ws-form-actions"><button class="ws-button" type="button" onClick={props.onClose}>Cancel</button><button class="ws-button primary" type="submit" disabled={busy || props.disabled}>{props.title === "Edit and accept" ? "Accept task" : "Save task"}</button></div>
  </form></Dialog>;
}
