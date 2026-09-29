import type { JSX } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { ApiError, createApi, describeError, type Api } from "./api";
import { BottomNav, MenuContext, MenuSheet } from "./components/mobile";
import { ApiContext, Button, Notice, Spinner } from "./components/ui";
import { SECTIONS, WORKSPACE_SECTIONS, sectionFromHash, type Section } from "./sections";
import { Workspace } from "./workspace/Workspace";
import { Bootstrap, Login } from "./views/Auth";
import { DangerZone } from "./views/DangerZone";
import { HistoryImport } from "./views/HistoryImport";
import { Overview } from "./views/Overview";
import { Phones } from "./views/Phones";
import { Policy } from "./views/Policy";
import { Providers } from "./views/Providers";
import { Usage } from "./views/Usage";
import { WhatsApp } from "./views/WhatsApp";

type AuthState =
  | { kind: "loading" }
  | { kind: "unreachable"; message: string }
  | { kind: "bootstrap"; tokenRequired: boolean }
  | { kind: "login"; expired: boolean }
  | { kind: "ready" };

const VIEWS: Record<Exclude<Section, "tasks" | "people" | "chats" | "ask" | "settings">, () => JSX.Element> = {
  overview: Overview,
  whatsapp: WhatsApp,
  providers: Providers,
  usage: Usage,
  phones: Phones,
  policy: Policy,
  import: HistoryImport,
  danger: DangerZone,
};

async function resolveAuth(api: Api): Promise<AuthState> {
  try {
    const session = await api.session();
    if (!session.ownerExists) return { kind: "bootstrap", tokenRequired: session.bootstrapTokenRequired };
    return session.authenticated ? { kind: "ready" } : { kind: "login", expired: false };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) throw error;
    // Older API without /setup/session: probe an authenticated route instead.
    try {
      await api.status();
      return { kind: "ready" };
    } catch (probe) {
      if (probe instanceof ApiError && probe.status === 401) return { kind: "login", expired: false };
      throw probe;
    }
  }
}

function useHashLocation(): string {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(location.hash);
      document.getElementById("main")?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function Shell(props: { onLogout: () => void }) {
  const hash = useHashLocation();
  const section = sectionFromHash(hash);
  const workspace = WORKSPACE_SECTIONS.includes(section);
  const View = workspace ? null : VIEWS[section as keyof typeof VIEWS];
  const current = SECTIONS.find((item) => item.id === section)!;
  const [menuOpen, setMenuOpen] = useState(false);
  const openMenu = useCallback(() => setMenuOpen(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    document.title = `${current.label} · WABrain`;
  }, [current.label]);

  return (
    <MenuContext.Provider value={openMenu}>
    <div class="shell">
      <a class="skip" href="#main">
        Skip to content
      </a>
      <aside class="sidebar">
        <div class="brand">
          <img class="mark" src="/logo.webp" alt="" width={44} height={44} />
          <div>
            <b>WABrain</b>
            <small>Your second brain</small>
          </div>
        </div>
              <nav aria-label="App sections">
          <p class="nav-heading">Workspace</p>
          <ul>{SECTIONS.filter((item) => WORKSPACE_SECTIONS.includes(item.id)).map((item) => (
              <li key={item.id}><a href={`#/${item.id}`} class={`nav-item ${section === item.id ? "active" : ""}`} aria-current={section === item.id ? "page" : undefined}>{item.label}</a></li>
            ))}</ul>
          <p class="nav-heading">Server setup</p>
          <ul>
            {SECTIONS.filter((item) => !WORKSPACE_SECTIONS.includes(item.id)).map((item) => (
              <li key={item.id}>
                <a
                  href={`#/${item.id}`}
                  class={`nav-item ${item.id === section ? "active" : ""} ${item.id === "danger" ? "nav-danger" : ""}`}
                  aria-current={item.id === section ? "page" : undefined}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div class="sidebar-foot">
          <span class="readonly-pill" title="WABrain never sends, reacts, edits, deletes, or marks messages as read">
            Read-only
          </span>
          <button type="button" class="link link-inverse" onClick={props.onLogout}>
            Sign out
          </button>
        </div>
      </aside>
      <main id="main" class={`main ${workspace ? "workspace-main" : ""}`} tabIndex={-1}>
        {workspace ? <Workspace section={section} hash={hash} /> : View ? <View /> : null}
      </main>
      <BottomNav section={section} />
      {menuOpen ? <MenuSheet section={section} onClose={closeMenu} onLogout={props.onLogout} /> : null}
    </div>
    </MenuContext.Provider>
  );
}

export function App() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });
  const api = useMemo(
    () =>
      createApi({
        onUnauthorized: () => setAuth((current) => (current.kind === "ready" ? { kind: "login", expired: true } : current)),
      }),
    [],
  );

  const refresh = () => {
    setAuth({ kind: "loading" });
    resolveAuth(api).then(setAuth, (error: unknown) => setAuth({ kind: "unreachable", message: describeError(error) }));
  };
  useEffect(refresh, [api]);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // The session is gone either way.
    }
    setAuth({ kind: "login", expired: false });
  };

  return (
    <ApiContext.Provider value={api}>
      {auth.kind === "loading" ? (
        <main class="auth" id="main">
          <Spinner label="Connecting to the server…" />
        </main>
      ) : null}
      {auth.kind === "unreachable" ? (
        <main class="auth" id="main">
          <div class="auth-card">
            <Notice tone="error" title="The server did not answer">
              {auth.message}
            </Notice>
            <Button variant="primary" onClick={refresh}>
              Try again
            </Button>
          </div>
        </main>
      ) : null}
      {auth.kind === "bootstrap" ? <Bootstrap tokenRequired={auth.tokenRequired} onDone={refresh} /> : null}
      {auth.kind === "login" ? <Login expired={auth.expired} onDone={() => setAuth({ kind: "ready" })} /> : null}
      {auth.kind === "ready" ? <Shell onLogout={() => void logout()} /> : null}
    </ApiContext.Provider>
  );
}
