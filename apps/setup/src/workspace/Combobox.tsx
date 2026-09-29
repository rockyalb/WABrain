import type { JSX } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { type ComboOption, filterOptions } from "./model";

const MAX_SHOWN = 60;

/**
 * A select you can type into: the list narrows to the options that match, and
 * arrow keys, Enter and Escape work as in a native select. The empty value is
 * offered first as `emptyLabel` (e.g. "Everyone"); `placeholder` shows while the list is open.
 */
export function Combobox(props: { label: string; value: string; options: ComboOption[]; onChange: (value: string) => void; emptyLabel: string; placeholder?: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = props.options.find((option) => option.value === props.value) ?? null;
  const typing = Boolean(query?.trim());
  const matches = useMemo(() => filterOptions(props.options, query ?? ""), [props.options, query]);
  const items: ComboOption[] = typing ? matches.slice(0, MAX_SHOWN) : [{ value: "", label: props.emptyLabel }, ...matches.slice(0, MAX_SHOWN)];

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const openList = () => {
    setOpen(true);
    const index = items.findIndex((item) => item.value === props.value);
    setActive(Math.max(index, 0));
  };
  const close = () => { setOpen(false); setQuery(null); };
  const choose = (option: ComboOption | undefined) => {
    if (!option) return;
    props.onChange(option.value);
    close();
  };
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return openList();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + items.length) % Math.max(items.length, 1));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    }
  };

  return <div class="ws-combo-field">
    <label for={id}>{props.label}</label>
    <div class={`ws-combo ${open ? "open" : ""}`}>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        spellcheck={false}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${id}-${active}` : undefined}
        placeholder={open ? props.placeholder ?? props.emptyLabel : props.emptyLabel}
        value={query ?? (selected ? selected.label : "")}
        onFocus={(event) => { event.currentTarget.select(); openList(); }}
        onClick={() => { if (!open) openList(); }}
        onInput={(event) => { setQuery(event.currentTarget.value); setOpen(true); setActive(0); }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      {selected && query === null ? <button type="button" class="ws-combo-clear" aria-label={`Clear ${props.label}`} onMouseDown={(event) => event.preventDefault()} onClick={() => { props.onChange(""); input.current?.focus(); }}>×</button>
        : <span class="ws-combo-chevron" aria-hidden="true" />}
      {open ? <div ref={list} id={`${id}-list`} role="listbox" class="ws-combo-list" aria-label={props.label}>
        {items.length ? items.map((option, index) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the input keeps focus and handles the keys (aria-activedescendant).
          <div
          key={option.value || "__empty"}
          id={`${id}-${index}`}
          data-index={index}
          role="option"
          tabIndex={-1}
          aria-selected={option.value === props.value}
          class={`${index === active ? "active" : ""} ${option.value === props.value ? "selected" : ""}`}
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={() => { if (index !== active) setActive(index); }}
          onClick={() => choose(option)}
        >
          {option.value ? <span class="ws-combo-avatar" aria-hidden="true">{option.label.slice(0, 1).toUpperCase()}</span> : <span class="ws-combo-avatar all" aria-hidden="true">✦</span>}
          <span class="ws-combo-text"><b>{option.label}</b>{option.detail ? <small>{option.detail}</small> : null}</span>
        </div>)) : <p class="ws-combo-none">No one matches “{query?.trim()}”</p>}
        {matches.length > MAX_SHOWN ? <p class="ws-combo-none">Keep typing to narrow {matches.length} matches</p> : null}
      </div> : null}
    </div>
  </div>;
}
