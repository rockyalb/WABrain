import { createContext } from "preact";
import { useContext, useEffect } from "preact/hooks";
import { SECTIONS, WORKSPACE_SECTIONS, type Section } from "../sections";

/** Circle as a path, the same helper the Android icons use. */
const circle = (cx: number, cy: number, r: number) => `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;

/** Stroke icons copied from the Android app (WabIcons.kt), 24×24. */
const ICONS = {
  tasks: [circle(12, 12, 9), "M8 12.4l2.8 2.8 5.4-5.6"],
  people: [circle(12, 8, 3.6), "M5 20c0.6-3.8 3.4-6 7-6s6.4 2.2 7 6"],
  chats: ["M4.5 5.5h15v10.5H10l-5.5 4.2z"],
  ask: [circle(10.5, 10.5, 6.5), "M15.4 15.4L20 20", "M10.5 7.6l0.8 2.1 2.1 0.8-2.1 0.8-0.8 2.1-0.8-2.1-2.1-0.8 2.1-0.8z"],
  settings: ["M4 7h9M17 7h3M4 17h3M11 17h9", circle(15, 7, 2), circle(9, 17, 2)],
  sparkle: ["M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1-5.1-1.9 5.1-1.9z", "M18.5 16.5l0.8 2 2 0.8-2 0.8-0.8 2-0.8-2-2-0.8 2-0.8z"],
  plus: ["M12 5v14M5 12h14"],
  refresh: ["M20 12a8 8 0 1 1-2.34-5.66", "M20 4v5h-5"],
  menu: ["M4 7h16M4 12h16M4 17h16"],
  back: ["M15 5l-7 7 7 7"],
} as const;

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; size?: number; width?: number }) {
  const size = props.size ?? 24;
  return <svg class="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width={props.width ?? 2} stroke-linecap="round" stroke-linejoin="round">
    {ICONS[props.name].map((d) => <path key={d} d={d} />)}
  </svg>;
}

/** Opens the server-setup sheet on phones; the sidebar covers it on wider screens. */
export const MenuContext = createContext<() => void>(() => {});

export function MenuButton() {
  const open = useContext(MenuContext);
  return <button type="button" class="m-icon-button mobile-only" aria-label="Server setup and account" onClick={open}><Icon name="menu" /></button>;
}

/** Android-style bottom navigation for the five app sections. */
export function BottomNav(props: { section: Section }) {
  return <nav class="bottom-nav mobile-only" aria-label="App sections">
    {SECTIONS.filter((item) => WORKSPACE_SECTIONS.includes(item.id)).map((item) => {
      const active = props.section === item.id;
      return <a key={item.id} href={`#/${item.id}`} class={active ? "active" : ""} aria-current={active ? "page" : undefined}>
        <span class="bottom-nav-pill"><Icon name={item.id as IconName} /></span>
        <span class="bottom-nav-label">{item.label}</span>
      </a>;
    })}
  </nav>;
}

/** Bottom sheet listing the server-setup pages, with sign out. */
export function MenuSheet(props: { section: Section; onClose: () => void; onLogout: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", props.onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hashchange", props.onClose);
    };
  }, [props.onClose]);
  // biome-ignore lint/a11y/noStaticElementInteractions: tapping outside the sheet closes it; Escape does the same for keyboards.
  // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on window above.
  return <div class="m-sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <section class="m-sheet" role="dialog" aria-modal="true" aria-label="Server setup">
      <span class="m-sheet-handle" aria-hidden="true" />
      <p class="nav-heading">Server setup</p>
      <ul>
        {SECTIONS.filter((item) => !WORKSPACE_SECTIONS.includes(item.id)).map((item) => (
          <li key={item.id}>
            <a href={`#/${item.id}`} class={`m-sheet-item ${item.id === props.section ? "active" : ""} ${item.id === "danger" ? "nav-danger" : ""}`}
              aria-current={item.id === props.section ? "page" : undefined}>{item.label}</a>
          </li>
        ))}
      </ul>
      <div class="m-sheet-foot">
        <span class="readonly-pill" title="WABrain never sends, reacts, edits, deletes, or marks messages as read">Read-only</span>
        <button type="button" class="ws-button" onClick={props.onLogout}>Sign out</button>
      </div>
    </section>
  </div>;
}
