import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ApiError } from "../api";
import { Icon } from "../components/mobile";
import type { CreateTaskAction } from "@wabrain/contracts";
import { Combobox } from "./Combobox";
import { ContextBadge, Dialog, EmptyState, useWorkspace, WorkspaceHeader } from "./Workspace";
import type { NewTask, TaskPatch } from "./api";
import { closedRecently, contextName, dateKey, displayDate, displayTime, effectiveContext, reviewLabel, reviewTitle, taskActivityToday, timeKey, todayKey, zonedDateTime } from "./model";
import { jidPhone } from "./model";
import type { MessageView, ReviewItem, Task, TaskDetail as Detail } from "./model";
import { reviewTargetFromHash } from "./review-target";

type TaskTab = "today" | "upcoming" | "waiting" | "review" | "closed";
type ReviewTargetState = "loading" | "pending" | "accepted" | "rejected" | "missing" | "unavailable";
const TABS: Array<{ id: TaskTab; label: string }> = [
  { id: "today", label: "Today" }, { id: "upcoming", label: "Upcoming" }, { id: "waiting", label: "Waiting on" },
  { id: "review", label: "Review" }, { id: "closed", label: "Closed" },
];

export function TasksView(props: { hash: string }) {
  const { data, api, run, runTask, runReview, pending, busy, refresh } = useWorkspace();
  const [context, setContext] = useState<string>("all");
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
  const closedSearch = useClosedSearch(tab === "closed" ? contact : "", detailId);
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
  const tasks = (searching ? closedSearch.tasks : data.tasks).filter((task) => {
    if (!contextMatches(task)) return false;
    if (tab === "closed") return searching || (task.status !== "open" && closedRecently(task, data.settings));
    if (task.status !== "open") return false;
    if (tab === "waiting") return task.kind === "waiting_on";
    if (task.kind !== "todo") return false;
    const due = dateKey(task.dueAt, data.settings);
    return tab === "today" ? due !== null && due <= currentDate : due === null || due > currentDate;
  }).sort(tab === "closed" ? (a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt) : (a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));
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
      <label class="ws-filter desktop-only">Context <select value={context} onChange={(event) => setContext(event.currentTarget.value)}>
        <option value="all">All contexts</option>{data.contexts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label>
    </div>
    {tab !== "review" ? <div class="m-chips mobile-only" role="group" aria-label="Context">
      <button type="button" class={context === "all" ? "active" : ""} aria-pressed={context === "all"} onClick={() => setContext("all")}>All</button>
      {data.contexts.map((item) => <button type="button" key={item.id} class={context === item.id ? "active" : ""} aria-pressed={context === item.id} onClick={() => setContext(item.id)}>
        <i style={{ backgroundColor: item.color ?? "#a4b8ad" }} />{item.name}</button>)}
    </div> : null}
    {tab === "closed" ? <div class="ws-closed-filter">
      <Combobox label="Contact" value={contact} options={contactOptions} onChange={setContact} emptyLabel="Today & yesterday" placeholder="Type a name or number" />
      <p class="ws-muted">{searching ? "Every closed task for this contact, newest first." : "Showing tasks closed today and yesterday. Pick a contact to search all closed tasks."}</p>
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

/** Closed tasks for one contact, newest closed first, fetched from the server so they reach past the synced week. */
function useClosedSearch(personId: string, refetchKey: string | null) {
  const { api } = useWorkspace();
  const [state, setState] = useState<{ personId: string; tasks: Task[]; next: string | null; loading: boolean; error: string | null }>({ personId: "", tasks: [], next: null, loading: false, error: null });
  const current = useRef(personId);
  current.current = personId;
  const load = async (target: string, cursor: string | null) => {
    setState((prev) => ({ ...prev, personId: target, loading: true, error: null, ...(cursor ? {} : { tasks: [], next: null }) }));
    try {
      const page = await api.closedTasks(target, cursor);
      if (current.current !== target) return;
      setState((prev) => ({ personId: target, tasks: cursor ? [...prev.tasks, ...page.items] : page.items, next: page.nextCursor, loading: false, error: null }));
    } catch {
      if (current.current === target) setState((prev) => ({ ...prev, loading: false, error: "Closed tasks could not be loaded." }));
    }
  };
  useEffect(() => {
    if (personId && !refetchKey) void load(personId, null);
  }, [personId, refetchKey]);
  const fresh = state.personId === personId;
  return { tasks: fresh ? state.tasks : [], next: fresh ? state.next : null, loading: !fresh || state.loading, error: fresh ? state.error : null, more: () => (state.next ? load(personId, state.next) : Promise.resolve()) };
}

/** Done-today ring from the Android Tasks header. */
function ProgressRing(props: { completed: number; created: number }) {
  if (props.completed === 0 && props.created === 0) return null;
  return <span class="m-daily-count mobile-only" role="img" aria-label={`${props.completed} completed today / ${props.created} created today`}>
    <b>{props.completed} / {props.created}</b><small>done / created</small>
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
      <div class="ws-task-meta"><span class={props.task.dueAt && new Date(props.task.dueAt) < new Date() && props.task.status === "open" ? "overdue" : ""}>{props.task.dueAt ? (props.task.dueHasTime ? displayTime(props.task.dueAt, data.settings) : displayDate(props.task.dueAt, data.settings)) : "No due date"}</span>
        {context ? <ContextBadge name={context.name} color={context.color} /> : null}
        {linked ? <span>↗ {linked}</span> : null}{props.task.kind === "waiting_on" ? <span>Waiting on</span> : null}
        {props.task.status !== "open" ? <span>{props.task.status === "done" ? "Done" : "Cancelled"} {displayDate(props.task.closedAt ?? props.task.updatedAt, data.settings)}</span> : null}
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
  const firstEvidence = props.item.action.evidenceMessageIds[0];
  // A later message suggests this proposal was already dealt with before it was reviewed.
  const handled = props.item.type === "create" ? props.item.handled : null;
  const handledEvidence = handled?.evidenceMessageIds[0];
  return <article ref={card} tabIndex={props.targeted ? -1 : undefined} class={`ws-review-card ${props.targeted ? "targeted" : ""}`}>
    <div class="ws-review-top"><span class="ws-review-kind">{reviewLabel(props.item)}</span><span class="ws-muted">{displayDate(props.item.createdAt)}</span></div>
    <h2>{reviewTitle(props.item)}</h2>
    {props.item.summary && props.item.summary !== reviewTitle(props.item) ? <p>{props.item.summary}</p> : null}
    <div class="ws-task-meta">{chat ? <span>{chat.name ?? "Chat"}</span> : null}{person ? <span>{person.displayName}</span> : null}
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
        {person ? <div><dt>Person</dt><dd><a href={`#/people/${encodeURIComponent(person.id)}`}>{person.displayName}</a></dd></div> : null}</dl></section>
      <section class="ws-panel"><h2>Evidence</h2>{detail.evidence.length ? detail.evidence.map((message) => <Evidence key={message.id} message={message} />) : <p class="ws-muted">No linked messages.</p>}</section>
    </div>
    <section class="ws-panel ws-history"><h2>History</h2>{detail.events.length ? detail.events.map((event) => <div class="ws-history-row" key={event.id}><div><b>{event.type.replace("_", " ")}</b><span>{event.actor} · {displayTime(event.createdAt, data.settings)}</span></div>
      {event.undoableUntil && !event.undoneAt && new Date(event.undoableUntil) > new Date() ? <button type="button" class="ws-text-button" disabled={busy} onClick={() => void change(() => api.undo(event.id))}>Undo</button> : null}</div>) : <p class="ws-muted">No changes yet.</p>}</section>
    {editing ? <TaskEditor title="Edit task" initial={task} disabled={busy} onClose={() => setEditing(false)} onSave={(patch) => void change(() => api.updateTask(task.id, patch)).then((ok) => { if (ok) setEditing(false); })} /> : null}
  </>;
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
