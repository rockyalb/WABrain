import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { describeError } from "../api";
import { useWorkspace, WorkspaceHeader } from "./Workspace";

function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function SettingsView(_props: { hash: string }) {
  const { data, api, run, busy } = useWorkspace();
  const [timezone, setTimezone] = useState(data.settings.timezone);
  const [endOfWorkDay, setEndOfWorkDay] = useState(data.settings.endOfWorkDay);
  const [remindersEnabled, setRemindersEnabled] = useState(data.settings.remindersEnabled);
  const [lead, setLead] = useState(String(data.settings.reminderLeadMinutes));
  const [summaryTime, setSummaryTime] = useState(data.settings.dailySummaryTime ?? "");
  const [newContext, setNewContext] = useState("");
  const [newColor, setNewColor] = useState("#7aa892");
  const [reassign, setReassign] = useState("");
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    void navigator.serviceWorker?.ready.then((registration) => registration.pushManager.getSubscription()).then((subscription) => setPushEnabled(Boolean(subscription))).catch(() => {});
  }, []);
  const save = (event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    void run(() => api.updateSettings({ timezone: timezone.trim(), endOfWorkDay, remindersEnabled, reminderLeadMinutes: Number(lead), dailySummaryTime: summaryTime || null }));
  };
  const enablePush = async () => {
    setPushBusy(true); setPushError(null);
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support push notifications.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Allow notifications for this site in your browser settings.");
      const registration = await navigator.serviceWorker.ready;
      const publicKey = (await api.vapidKey()).publicKey;
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(publicKey) });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser did not provide a push subscription.");
      await api.savePush({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setPushEnabled(true);
    } catch (caught) { setPushError(describeError(caught)); }
    finally { setPushBusy(false); }
  };
  const disablePush = async () => {
    setPushBusy(true); setPushError(null);
    try {
      await api.deletePush();
      const registration = await navigator.serviceWorker.ready;
      await (await registration.pushManager.getSubscription())?.unsubscribe();
      setPushEnabled(false);
    } catch (caught) { setPushError(describeError(caught)); }
    finally { setPushBusy(false); }
  };
  return <>
    <WorkspaceHeader logo eyebrow="Make it yours" title="Settings" description="The same task and notification preferences used by your phone." />
    <div class="ws-detail-grid"><section class="ws-panel"><h2>Daily rhythm</h2><form class="ws-form" onSubmit={save}>
      <label>Timezone<input required value={timezone} onInput={(event) => setTimezone(event.currentTarget.value)} placeholder="Europe/Rome" /></label>
      <label>End of work day<input required type="time" value={endOfWorkDay} onInput={(event) => setEndOfWorkDay(event.currentTarget.value)} /></label>
      <label class="ws-checkbox"><input type="checkbox" checked={remindersEnabled} onChange={(event) => setRemindersEnabled(event.currentTarget.checked)} /> Due-date reminders</label>
      <label>Remind me this many minutes before due<input type="number" min="0" max="10080" value={lead} onInput={(event) => setLead(event.currentTarget.value)} /></label>
      <label>Daily summary time (optional)<input type="time" value={summaryTime} onInput={(event) => setSummaryTime(event.currentTarget.value)} /></label>
      <button type="submit" class="ws-button primary" disabled={busy}>Save preferences</button></form></section>
      <section class="ws-panel"><h2>Desktop notifications</h2><p>Receive review requests, reminders and summaries in this browser. Review alerts offer Accept / Reject actions.</p>
        <p class="ws-muted">Notification text stays generic to protect conversation details on your lock screen.</p>
        <div class="ws-actions">{pushEnabled ? <button type="button" class="ws-button" disabled={pushBusy} onClick={() => void disablePush()}>Turn off notifications</button>
          : <button type="button" class="ws-button primary" disabled={pushBusy} onClick={() => void enablePush()}>Enable notifications</button>}
          <span class={`ws-pill ${pushEnabled ? "good" : ""}`}>{pushEnabled ? "Enabled" : "Off"}</span></div>
        {pushError ? <p class="ws-field-error" role="alert">{pushError}</p> : null}
        <div class="ws-divider" /><h3>Install on desktop</h3><p class="ws-muted">Use Chrome’s Install option to open WABrain in its own window and Dock icon.</p>
      </section></div>
    <section class="ws-panel"><h2>Contexts</h2><p class="ws-muted">Organize tasks, chats and people across every part of your life.</p>
      <div class="ws-context-list">{data.contexts.map((context) => <div class="ws-context-row" key={context.id}><span class="ws-context-dot" style={{ backgroundColor: context.color ?? "#a4b8ad" }} /><b>{context.name}</b>
        <div class="ws-actions"><button type="button" class="ws-text-button" disabled={busy} onClick={() => { const name = window.prompt("Rename context", context.name); if (name?.trim()) void run(() => api.updateContext(context.id, { name: name.trim() })); }}>Rename</button>
          <button type="button" class="ws-text-button danger" disabled={busy || data.contexts.length < 2} onClick={() => {
            const target = reassign && reassign !== context.id ? reassign : data.contexts.find((item) => item.id !== context.id)?.id;
            if (target && window.confirm(`Delete ${context.name} and move linked items to ${data.contexts.find((item) => item.id === target)?.name}?`)) void run(() => api.deleteContext(context.id, target));
          }}>Delete</button></div></div>)}</div>
      {data.contexts.length > 1 ? <label class="ws-filter">Move items to on delete <select value={reassign} onChange={(event) => setReassign(event.currentTarget.value)}><option value="">Choose automatically</option>{data.contexts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
      <form class="ws-inline-form" onSubmit={(event) => { event.preventDefault(); void run(() => api.createContext(newContext.trim(), newColor)).then((ok) => { if (ok) setNewContext(""); }); }}>
        <label>New context<input required maxLength={40} placeholder="e.g. Family" value={newContext} onInput={(event) => setNewContext(event.currentTarget.value)} /></label>
        <label>Color<input type="color" value={newColor} onInput={(event) => setNewColor(event.currentTarget.value)} /></label>
        <button type="submit" class="ws-button primary" disabled={busy}>Add context</button></form></section>
    <section class="ws-panel"><h2>Server and account</h2><p class="ws-muted">Connected to {location.origin}. Manage providers, policy, phone pairing and server health in Setup.</p>
      <a class="ws-button" href="#/overview">Open server setup ↗</a></section>
  </>;
}
