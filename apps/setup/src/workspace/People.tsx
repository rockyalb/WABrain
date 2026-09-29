import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PersonFactKey } from "@wabrain/contracts";
import { ContextBadge, EmptyState, useWorkspace, WorkspaceHeader } from "./Workspace";
import { Evidence } from "./Tasks";
import type { MessageView, Person } from "./model";

const FACT_KEYS: PersonFactKey[] = ["name", "company", "role", "relationship", "language", "topic", "location", "other"];

export function PeopleView(props: { hash: string }) {
  const { data } = useWorkspace();
  const [search, setSearch] = useState("");
  const id = props.hash.replace(/^#\/?/, "").split("?")[0]!.split("/")[1];
  if (id) return <PersonView id={decodeURIComponent(id)} />;
  const people = data.people.filter((person) => person.displayName.toLowerCase().includes(search.toLowerCase()));
  return <>
    <WorkspaceHeader logo eyebrow="Your network" title="People" description="Names, context and useful details learned from conversations." />
    <div class="ws-toolbar"><label class="ws-search"><span>Search people</span><input type="search" placeholder="Name or contact" value={search} onInput={(event) => setSearch(event.currentTarget.value)} /></label><span class="ws-muted">{people.length} people</span></div>
    {people.length ? <div class="ws-people-grid">{people.map((person) => {
      const context = data.contexts.find((item) => item.id === person.defaultContextId);
      return <a key={person.id} class="ws-person-card" href={`#/people/${encodeURIComponent(person.id)}`}><span class="ws-avatar">{person.displayName.slice(0, 1).toUpperCase()}</span><span class="ws-person-info"><b>{person.displayName}</b><small>{person.facts.length} facts · {person.languages.join(", ") || "Language unknown"}</small>{context ? <ContextBadge name={context.name} color={context.color} /> : null}</span><span>↗</span></a>;
    })}</div> : <EmptyState title="No people found">Try a different search, or wait for conversations to be processed.</EmptyState>}
  </>;
}

function PersonView(props: { id: string }) {
  const { api, data, run, busy } = useWorkspace();
  const [person, setPerson] = useState<Person | null>(null);
  const [name, setName] = useState("");
  const [contextId, setContextId] = useState("");
  const [factKey, setFactKey] = useState<PersonFactKey>("company");
  const [factValue, setFactValue] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sources, setSources] = useState<MessageView[]>([]);
  const load = async () => {
    try { const result = await api.person(props.id); setPerson(result); setName(result.displayName); setContextId(result.defaultContextId ?? ""); } catch { setPerson(null); }
  };
  useEffect(() => { void load(); }, [props.id]);
  const mutate = async (operation: () => Promise<unknown>) => { const ok = await run(operation); if (ok) void load(); return ok; };
  const save = (event: JSX.TargetedEvent<HTMLFormElement, Event>) => { event.preventDefault(); void mutate(() => api.updatePerson(props.id, { displayName: name.trim(), defaultContextId: contextId || null })); };
  const add = (event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    void mutate(() => api.addFact(props.id, factKey, factValue.trim())).then((ok) => { if (ok) setFactValue(""); });
  };
  const openSources = async (factId: string) => {
    if (sourceId === factId) { setSourceId(null); return; }
    try { setSources((await api.factSources(props.id, factId)).items); setSourceId(factId); } catch { setSources([]); setSourceId(factId); }
  };
  if (!person) return <><a class="ws-back" href="#/people">← People</a><div class="ws-panel">Loading person…</div></>;
  return <>
    <a class="ws-back" href="#/people">← People</a>
    <WorkspaceHeader eyebrow="Person profile" title={person.displayName} description={person.jids.join(" · ")} />
    <div class="ws-detail-grid"><section class="ws-panel"><h2>Profile</h2><form class="ws-form" onSubmit={save}>
      <label>Display name<input required maxLength={120} value={name} onInput={(event) => setName(event.currentTarget.value)} /></label>
      <label>Default context<select value={contextId} onChange={(event) => setContextId(event.currentTarget.value)}><option value="">None</option>{data.contexts.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
      <button type="submit" class="ws-button primary" disabled={busy}>Save profile</button></form>
      <div class="ws-divider" /><p class="ws-muted">Languages: {person.languages.join(", ") || "Not known yet"}</p></section>
      <section class="ws-panel"><h2>Add a fact</h2><form class="ws-form" onSubmit={add}><label>Type<select value={factKey} onChange={(event) => setFactKey(event.currentTarget.value as PersonFactKey)}>{FACT_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
        <label>Detail<input required maxLength={500} value={factValue} onInput={(event) => setFactValue(event.currentTarget.value)} placeholder="Something useful to remember" /></label><button type="submit" class="ws-button primary" disabled={busy}>Add fact</button></form></section></div>
    <section class="ws-panel"><h2>Known facts</h2>{person.facts.length ? <div class="ws-fact-list">{person.facts.map((fact) => <div class="ws-fact" key={fact.id}>
      <div><span class="ws-review-kind">{fact.key}</span><p>{fact.value}</p><small>{fact.verified ? "Verified" : fact.selfClaimed ? "Self reported" : "Unverified"} · {fact.source === "owner" ? "Added by you" : "Learned from messages"}</small></div>
      <div class="ws-actions"><button type="button" class="ws-text-button" onClick={() => void openSources(fact.id)}>Sources ({fact.sourceMessageIds.length})</button>
        {!fact.verified ? <button type="button" class="ws-text-button" disabled={busy} onClick={() => void mutate(() => api.updateFact(person.id, fact.id, { verified: true }))}>Verify</button> : null}
        <button type="button" class="ws-text-button" disabled={busy} onClick={() => { const value = window.prompt("Edit fact", fact.value); if (value?.trim()) void mutate(() => api.updateFact(person.id, fact.id, { value: value.trim() })); }}>Edit</button>
        <button type="button" class="ws-text-button danger" disabled={busy} onClick={() => { if (window.confirm("Delete this fact?")) void mutate(() => api.deleteFact(person.id, fact.id)); }}>Delete</button></div>
      {sourceId === fact.id ? <div class="ws-fact-sources">{sources.length ? sources.map((message) => <Evidence key={message.id} message={message} />) : <p class="ws-muted">No stored source messages.</p>}</div> : null}
    </div>)}</div> : <p class="ws-muted">No facts yet.</p>}</section>
    <section class="ws-panel ws-danger-zone"><h2>Delete person data</h2><p>Remove this person and their stored conversation data.</p><button type="button" class="ws-button danger" disabled={busy} onClick={() => { if (window.confirm(`Permanently delete data for ${person.displayName}?`)) void mutate(() => api.deletePersonData(person.id)).then((ok) => { if (ok) location.hash = "#/people"; }); }}>Delete data</button></section>
  </>;
}
