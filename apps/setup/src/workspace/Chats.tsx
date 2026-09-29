import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { Chat } from "./model";
import { ContextBadge, EmptyState, useWorkspace, WorkspaceHeader } from "./Workspace";
import { displayTime } from "./model";

export function ChatsView(props: { hash: string }) {
  const { data } = useWorkspace();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const id = props.hash.replace(/^#\/?/, "").split("?")[0]!.split("/")[1];
  if (id) return <ChatView id={decodeURIComponent(id)} hash={props.hash} />;
  const chats = data.chats.filter((chat) => {
    const matchesText = (chat.name ?? chat.jid).toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || filter === chat.mode || (filter === "confirm" && !chat.contextConfirmed);
    return matchesText && matchesFilter;
  });
  return <>
    <WorkspaceHeader logo eyebrow="Conversation rules" title="Chats" description="Choose what WABrain may analyze and how tasks are created." />
    <div class="ws-toolbar"><label class="ws-search"><span>Search chats</span><input type="search" placeholder="Name or group" value={search} onInput={(event) => setSearch(event.currentTarget.value)} /></label>
      <label class="ws-filter">Show <select value={filter} onChange={(event) => setFilter(event.currentTarget.value)}><option value="all">All chats</option><option value="confirm">Needs context</option><option value="on">On</option><option value="mentions_only">Mentions only</option><option value="off">Off</option></select></label></div>
    {chats.length ? <div class="ws-card-list">{chats.map((chat) => {
      const context = data.contexts.find((item) => item.id === chat.defaultContextId);
      return <a key={chat.id} class="ws-chat-row" href={`#/chats/${encodeURIComponent(chat.id)}`}><span class="ws-avatar group">{chat.isGroup ? "♧" : (chat.name ?? chat.jid).slice(0, 1).toUpperCase()}</span>
        <span class="ws-person-info"><b>{chat.name ?? chat.jid}</b><small>{chat.isGroup ? "Group" : "Direct chat"} · {chat.mode === "mentions_only" ? "Mentions only" : chat.mode === "on" ? "On" : "Off"}</small></span>
        {!chat.contextConfirmed ? <span class="ws-pill attention">Confirm context</span> : context ? <ContextBadge name={context.name} color={context.color} /> : null}<span>↗</span></a>;
    })}</div> : <EmptyState title="No chats found">Try another search or filter.</EmptyState>}
  </>;
}

function ChatView(props: { id: string; hash: string }) {
  const { data, api, run, busy } = useWorkspace();
  const chat = data.chats.find((item) => item.id === props.id);
  const around = new URLSearchParams(props.hash.split("?")[1] ?? "").get("around") ?? undefined;
  const [messages, setMessages] = useState<Awaited<ReturnType<typeof api.messages>>["items"]>([]);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [mode, setMode] = useState<Chat["mode"]>(chat?.mode ?? "on");
  const [contextId, setContextId] = useState(chat?.defaultContextId ?? "");
  const [autoCreate, setAutoCreate] = useState(chat?.autoCreate ?? false);
  const [confidence, setConfidence] = useState(chat?.minimumAutoConfidence?.toString() ?? "");
  const [aliases, setAliases] = useState(chat?.aliases.join(", ") ?? "");
  useEffect(() => {
    setMode(chat?.mode ?? "on"); setContextId(chat?.defaultContextId ?? ""); setAutoCreate(chat?.autoCreate ?? false);
    setConfidence(chat?.minimumAutoConfidence?.toString() ?? ""); setAliases(chat?.aliases.join(", ") ?? "");
  }, [chat?.id]);
  useEffect(() => {
    void api.messages(props.id, around).then((result) => { setMessages(result.items); setMessageError(null); }, () => { setMessages([]); setMessageError("Conversation unavailable."); });
  }, [props.id, around]);
  if (!chat) return <><a class="ws-back" href="#/chats">← Chats</a><div class="ws-panel">Chat not found.</div></>;
  const save = (event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    if (mode === "off" && chat.mode !== "off" && !window.confirm("Turning this chat off deletes its stored messages and media. Continue?")) return;
    void run(() => api.updateChat(chat.id, {
      mode, defaultContextId: contextId || null, contextConfirmed: true, autoCreate,
      minimumAutoConfidence: confidence === "" ? null : Number(confidence),
      aliases: aliases.split(",").map((value) => value.trim()).filter(Boolean),
    }));
  };
  return <>
    <a class="ws-back" href="#/chats">← Chats</a>
    <WorkspaceHeader eyebrow={chat.isGroup ? "Group conversation" : "Direct conversation"} title={chat.name ?? chat.jid} description={chat.jid} />
    <div class="ws-detail-grid"><section class="ws-panel"><h2>Chat rules</h2><form class="ws-form" onSubmit={save}>
      <label>Analysis mode<select value={mode} onChange={(event) => setMode(event.currentTarget.value as Chat["mode"])}><option value="on">On — analyze messages</option>{chat.isGroup ? <option value="mentions_only">Mentions only</option> : null}<option value="off">Off — don't store messages</option></select></label>
      <label>Default context<select value={contextId} onChange={(event) => setContextId(event.currentTarget.value)}><option value="">None</option>{data.contexts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      {!chat.contextConfirmed ? <p class="ws-hint">This context is a suggestion. Saving confirms your choice.</p> : null}
      <label class="ws-checkbox"><input type="checkbox" checked={autoCreate} onChange={(event) => setAutoCreate(event.currentTarget.checked)} /> Allow automatic task creation when policy permits</label>
      <label>Minimum confidence override <input type="number" min="0" max="1" step="0.01" placeholder="Use global threshold" value={confidence} onInput={(event) => setConfidence(event.currentTarget.value)} /></label>
      <label>Mention aliases, separated by commas<input value={aliases} onInput={(event) => setAliases(event.currentTarget.value)} placeholder="Names people use for you" /></label>
      <button type="submit" class="ws-button primary" disabled={busy}>Save rules</button></form></section>
      <section class="ws-panel"><h2>Conversation</h2>{messageError ? <p class="ws-muted">{messageError}</p> : messages.length ? <div class="ws-conversation">{messages.map((message) => <article key={message.id} class={`ws-message ${message.fromOwner ? "owner" : ""} ${around === message.id ? "highlight" : ""}`}>
        <div><b>{message.fromOwner ? "You" : message.senderName ?? "Contact"}</b><time>{displayTime(message.at, data.settings)}</time></div><p>{message.body || message.derivedText || "Media message"}</p></article>)}</div>
      : <p class="ws-muted">No stored messages in this chat.</p>}</section></div>
    <section class="ws-panel ws-danger-zone"><h2>Delete chat data</h2><p>Delete stored messages and derived data from this chat.</p><button class="ws-button danger" type="button" disabled={busy} onClick={() => { if (window.confirm(`Permanently delete stored data for ${chat.name ?? chat.jid}?`)) void run(() => api.deleteChatData(chat.id)).then((ok) => { if (ok) setMessages([]); }); }}>Delete data</button></section>
  </>;
}
