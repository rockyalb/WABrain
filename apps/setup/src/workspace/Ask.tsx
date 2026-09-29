import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { describeError } from "../api";
import { useWorkspace, WorkspaceHeader } from "./Workspace";
import { TaskEditor } from "./Tasks";
import { Combobox } from "./Combobox";
import type { AskResponse } from "./model";
import { displayTime, jidPhone } from "./model";

function zonedInstant(date: string, end: boolean, zone: string): string | null {
  if (!date) return null;
  const clock = end ? "23:59:59.999" : "00:00:00.000";
  const desired = Date.parse(`${date}T${clock}Z`);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = formatter.formatToParts(new Date(desired));
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? "0");
  const observed = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"), end ? 999 : 0);
  return new Date(desired - (observed - desired)).toISOString();
}

export function AskView(_props: { hash: string }) {
  const { data, api, run } = useWorkspace();
  const [question, setQuestion] = useState("");
  const [personId, setPersonId] = useState("");
  const [contextId, setContextId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [result, setResult] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const personOptions = useMemo(() => [...data.people]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((person) => ({ value: person.id, label: person.displayName, detail: person.jids.map(jidPhone).find(Boolean) ?? undefined })), [data.people]);
  const submit = async (event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    if (from && to && from > to) { setError("The start date must be before the end date."); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await api.ask(question.trim(), {
        personId: personId || null, contextId: contextId || null,
        from: zonedInstant(from, false, data.settings.timezone), to: zonedInstant(to, true, data.settings.timezone),
      }));
    } catch (caught) { setError(describeError(caught)); }
    finally { setBusy(false); }
  };
  return <>
    <WorkspaceHeader logo eyebrow="Ask your chats" title="Find the thread" description="Ask a question about stored conversations. Answers include the messages behind them." />
    <div class="ws-ask-layout"><section class="ws-panel ws-ask-panel"><form class="ws-form" onSubmit={(event) => void submit(event)}>
      <label>Your question<textarea rows={4} required maxLength={1000} placeholder="What did we agree about the delivery?" value={question} onInput={(event) => setQuestion(event.currentTarget.value)} /></label>
      <div class="ws-form-grid"><Combobox label="Person" value={personId} options={personOptions} onChange={setPersonId} emptyLabel="Everyone" placeholder="Type a name or number" />
        <label>Context<select value={contextId} onChange={(event) => setContextId(event.currentTarget.value)}><option value="">All contexts</option>{data.contexts.map((context) => <option key={context.id} value={context.id}>{context.name}</option>)}</select></label></div>
      <div class="ws-form-grid"><label>From<input type="date" value={from} onInput={(event) => setFrom(event.currentTarget.value)} /></label><label>To<input type="date" value={to} onInput={(event) => setTo(event.currentTarget.value)} /></label></div>
      <button type="submit" class="ws-button primary" disabled={busy || !question.trim()}>{busy ? "Searching…" : "Ask WABrain"}</button>
    </form></section>
    <section class="ws-panel ws-answer-panel" aria-live="polite"><span class="ws-review-kind">Answer</span>
      {busy ? <div class="ws-ask-wait"><span class="spinner" /> Looking through your conversations…</div> : error ? <div class="ws-error" role="alert">{error}</div> : result ? <>
        <p class="ws-answer-text">{result.answer}</p>
        {result.citations.length ? <div class="ws-citations"><h2>Sources</h2>{result.citations.map((citation, index) => <a key={`${citation.chatId}:${citation.messageId}`} class="ws-citation" href={`#/chats/${encodeURIComponent(citation.chatId)}?around=${encodeURIComponent(citation.messageId)}`}><b>{index + 1}</b><span>{citation.excerpt}<small>{displayTime(citation.at, data.settings)}</small></span><span>↗</span></a>)}</div> : null}
        {result.suggestedAction ? <div class="ws-suggestion"><p><b>Suggested task</b><br />{result.suggestedAction.title}</p><button type="button" class="ws-button primary" onClick={() => setShowSuggestion(true)}>Review & create</button></div> : null}
      </> : <div class="ws-ask-placeholder"><span>✦</span><h2>Answers with receipts</h2><p>Ask about an agreement, a person, or a date. Every answer points back to its source.</p></div>}
    </section></div>
    {showSuggestion && result?.suggestedAction ? <TaskEditor title="Create suggested task" initial={result.suggestedAction} create suggestedChatId={result.citations[0]?.chatId} suggestedPersonId={personId || null} onClose={() => setShowSuggestion(false)} onSave={(draft) => void run(() => api.createTask(draft)).then((ok) => { if (ok) setShowSuggestion(false); })} /> : null}
  </>;
}
