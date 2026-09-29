import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { ApiError, describeError } from "../api";
import { Button, Field, Notice, useApi } from "../components/ui";

const MIN_PASSWORD = 12;

function AuthFrame(props: { title: string; lede: string; children: ComponentChildren }) {
  return (
    <main class="auth" id="main">
      <div class="auth-card">
        <div class="brand brand-auth">
          <img class="mark" src="/logo.webp" alt="" width={44} height={44} />
          <b>WABrain</b>
        </div>
        <h1>{props.title}</h1>
        <p class="lede">{props.lede}</p>
        {props.children}
      </div>
      <p class="auth-foot">Self-hosted · read-only · your data stays on this server</p>
    </main>
  );
}

export function Bootstrap(props: { tokenRequired: boolean; onDone: () => void }) {
  const api = useApi();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters.`);
    if (password !== confirm) return setError("The two passwords differ.");
    if (props.tokenRequired && !token.trim()) return setError("Enter the setup token from the server's .env file.");
    setBusy(true);
    try {
      await api.bootstrap(password, token.trim() || undefined);
      props.onDone();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setError("An owner account already exists. Sign in instead.");
        setTimeout(props.onDone, 1200);
      } else if (caught instanceof ApiError && caught.status === 401) {
        setError("The setup token is wrong.");
      } else {
        setError(describeError(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Set the owner password" lede="This server has no owner yet. The password protects this setup page; phones get their own tokens later.">
      <form onSubmit={submit} class="stack">
        {props.tokenRequired ? (
          <Field id="setup-token" label="Setup token" hint={<>The value of <code>SETUP_BOOTSTRAP_TOKEN</code> in the server's environment.</>}>
            <input id="setup-token" type="password" autocomplete="off" spellcheck={false} value={token} onInput={(event) => setToken(event.currentTarget.value)} />
          </Field>
        ) : null}
        <Field id="new-password" label="Password" hint={`At least ${MIN_PASSWORD} characters. A passphrase works well.`}>
          <input
            id="new-password"
            type="password"
            autocomplete="new-password"
            minLength={MIN_PASSWORD}
            required
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </Field>
        <Field id="confirm-password" label="Repeat password">
          <input
            id="confirm-password"
            type="password"
            autocomplete="new-password"
            required
            value={confirm}
            onInput={(event) => setConfirm(event.currentTarget.value)}
          />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button variant="primary" type="submit" busy={busy}>
          Create owner account
        </Button>
      </form>
    </AuthFrame>
  );
}

export function Login(props: { onDone: () => void; expired?: boolean }) {
  const api = useApi();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.login(password);
      setPassword("");
      props.onDone();
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status === 401 ? "Wrong password." : describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" lede="Enter the owner password to manage this server.">
      {props.expired ? <Notice tone="info">Your session ended. Sign in again.</Notice> : null}
      <form onSubmit={submit} class="stack">
        <Field id="password" label="Password">
          <input
            id="password"
            type="password"
            autocomplete="current-password"
            required
            autoFocus
            value={password}
            onInput={(event) => setPassword(event.currentTarget.value)}
          />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button variant="primary" type="submit" busy={busy}>
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}
