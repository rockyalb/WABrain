import type { ComponentChildren, JSX } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import { describeError, isConflict, isNotImplemented, isRateLimited, type Api } from "../api";
import { MenuButton } from "./mobile";

export const ApiContext = createContext<Api | null>(null);

export function useApi(): Api {
  const api = useContext(ApiContext);
  if (!api) throw new Error("ApiContext missing");
  return api;
}

export interface LoadState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
}

/** Runs `load` on mount (and when `deps` change); keeps the last data while reloading. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): LoadState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await load();
      if (!alive.current) return;
      setData(value);
      setError(null);
    } catch (caught) {
      if (alive.current) setError(caught);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

/** Wraps an async action with a busy flag and an error message. */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await action(...args);
      } catch (caught) {
        setError(describeError(caught));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [action],
  );
  return { run, busy, error, setError };
}

// ---------------------------------------------------------------------------

export function PageHeader(props: { kicker: string; title: string; children?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <header class="page-header">
      <div>
        <p class="kicker">{props.kicker}</p>
        <h1>{props.title}</h1>
        {props.children ? <p class="lede">{props.children}</p> : null}
      </div>
      {props.actions ? <div class="page-actions">{props.actions}</div> : null}
      <MenuButton />
    </header>
  );
}

export function Card(props: { title?: ComponentChildren; children: ComponentChildren; class?: string; aside?: ComponentChildren; id?: string }) {
  return (
    <section class={`card ${props.class ?? ""}`} id={props.id} aria-label={typeof props.title === "string" ? props.title : undefined}>
      {props.title || props.aside ? (
        <div class="card-head">
          {props.title ? <h2>{props.title}</h2> : <span />}
          {props.aside}
        </div>
      ) : null}
      {props.children}
    </section>
  );
}

export type Tone = "ok" | "warn" | "error" | "idle";

export function Dot(props: { tone: Tone; label?: string }) {
  return <span class={`dot dot-${props.tone}`} role={props.label ? "img" : undefined} aria-label={props.label} aria-hidden={props.label ? undefined : true} />;
}

export function Badge(props: { tone: Tone; children: ComponentChildren }) {
  return <span class={`badge badge-${props.tone}`}>{props.children}</span>;
}

type ButtonProps = JSX.HTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
  type?: "button" | "submit";
  disabled?: boolean;
};

export function Button({ variant = "secondary", busy, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} class={`btn btn-${variant} ${rest.class ?? ""}`} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy ? <span class="spinner" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Notice(props: { tone: "info" | "warn" | "error" | "ok"; children: ComponentChildren; title?: string }) {
  return (
    <div class={`notice notice-${props.tone}`} role={props.tone === "error" ? "alert" : "status"}>
      {props.title ? <strong>{props.title}</strong> : null}
      <div>{props.children}</div>
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return (
    <div class="loading" role="status">
      <span class="spinner" aria-hidden="true" />
      <span>{props.label ?? "Loading…"}</span>
    </div>
  );
}

/**
 * Standard rendering for a failed load: 409 means the server needs configuration first (its message
 * says which), 429 asks to wait, and 501 (an older server) gets a calm "update the server" note.
 */
export function LoadError(props: { error: unknown; feature?: string; onRetry?: () => void }) {
  if (isNotImplemented(props.error)) {
    return (
      <Notice tone="info" title="Needs a newer server">
        {props.feature ?? "This feature"} is not supported by the server version you are running. Update the server; everything else on this page keeps
        working.
      </Notice>
    );
  }
  if (isConflict(props.error) || isRateLimited(props.error)) {
    return (
      <Notice tone="warn" title={isConflict(props.error) ? "The server needs configuration first" : "Please wait a moment"}>
        {describeError(props.error)}{" "}
        {props.onRetry ? (
          <button type="button" class="link" onClick={props.onRetry}>
            Try again
          </button>
        ) : null}
      </Notice>
    );
  }
  return (
    <Notice tone="error" title="Could not load">
      {describeError(props.error)}{" "}
      {props.onRetry ? (
        <button type="button" class="link" onClick={props.onRetry}>
          Try again
        </button>
      ) : null}
    </Notice>
  );
}

export function Field(props: { label: string; hint?: ComponentChildren; children: ComponentChildren; id: string; error?: string | null }) {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      {props.children}
      {props.hint ? <p class="hint" id={`${props.id}-hint`}>{props.hint}</p> : null}
      {props.error ? <p class="field-error" role="alert">{props.error}</p> : null}
    </div>
  );
}

export function CopyButton(props: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Button variant="secondary" onClick={copy} aria-live="polite">
      {copied ? "Copied" : props.label ?? "Copy"}
    </Button>
  );
}

// ---------------------------------------------------------------------------

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.round((at - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds <= 0 ? "just now" : "in a moment";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 86_400 * 45) return relative.format(Math.round(seconds / 86_400), "day");
  return formatDate(iso);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
