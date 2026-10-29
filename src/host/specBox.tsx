/**
 * dom-annotakit — the spec combobox (D10, design 2026-10-26 + §9 folds).
 *
 * A compact, keyboard-first listbox-with-typeahead for Epic/Story selection.
 * The PURE state machine lives in src/shared/specCatalog.ts (comboReduce —
 * unit-tested with plain data); this component is the DOM/a11y skin:
 *
 *   - click (or the host chord ⌥E/⌥S, forwarded from the capture document by
 *     inject.ts) opens; typing filters (prefix-first), ↑/↓ move (edge-clamped),
 *     Enter commits, Esc closes + refocuses, Tab COMMITS a typed-new value and
 *     CONTINUES the tab order (never traps — §9 P3 fold);
 *   - a typed value with no exact match mints a `Create “X”` row — the value
 *     is selected in-memory and materializes on the board only when a thread
 *     actually files under it (lazy — no option pollution);
 *   - the selected value renders as a chip with a labelled × (clear);
 *   - aria: combobox/listbox/option + aria-expanded/controls/activedescendant;
 *     the open list announces through role=listbox semantics (no extra live
 *     region needed for navigation), and App owns the story-cleared
 *     announcement (the reducer's transition is announced there).
 *
 * Serve mode only (the spec endpoint 404s in static builds — the hook then
 * reports unavailable and the Toolbar hides the boxes).
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { comboOptions, comboReduce, type ComboState } from '../shared/specCatalog';
import { theme } from './theme';

/* ------------------------------- the data hook ------------------------------- */

export interface SpecCatalogShape {
  epics: string[];
  stories: { name: string; epics: string[] }[];
  /* s6: pairs — epic⋄story PAIR counts (the pair-exact match chips). The
   * server-side mergeCatalog passes the local rollups through verbatim. */
  captures: Record<string, { epics: Record<string, number>; stories: Record<string, number>; pairs: Record<string, number> }>;
}
export interface SpecEndpointShape {
  catalog: SpecCatalogShape;
  context: { epic?: string | null; story?: string | null };
}

const SPEC_POLL_MS = 20_000;
const SPEC_CONTEXT_KEY = 'dom-annotakit:spec-context';
export const SPEC_CONTEXT_EVENT = 'dom-annotakit:spec-context-echo';

/** localStorage-mirrored pending values (created via "Create X", not yet on
 *  the board) — they join the LOCAL option lists until the board catches up
 *  (§9 P3 fold 14: the chip must never hold a value absent from its own list). */
const SPEC_PENDING_KEY = 'dom-annotakit:spec-pending';

export function readPendingSpecValues(): { epic?: string; story?: string } {
  try {
    const raw = localStorage.getItem(SPEC_PENDING_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as { epic?: unknown; story?: unknown };
    return {
      ...(typeof v.epic === 'string' && v.epic ? { epic: v.epic } : {}),
      ...(typeof v.story === 'string' && v.story ? { story: v.story } : {}),
    };
  } catch {
    return {};
  }
}

/** Audit round-1 P3: callers need a change SIGNAL — an impure render-time
 *  localStorage read inside useMemo recomputed only when the catalog object
 *  swapped (≤20s), so a fresh "Create X" value missed its own option list.
 *  The bump counter rides every rememberPendingSpecValue call. */
export const SPEC_PENDING_BUMP = 'dom-annotakit:spec-pending-bumped-at';
let pendingBumpListeners: (() => void)[] = [];
export function onPendingSpecBump(cb: () => void): () => void {
  pendingBumpListeners.push(cb);
  return () => {
    pendingBumpListeners = pendingBumpListeners.filter((l) => l !== cb);
  };
}

function writePendingSpecValues(v: { epic?: string; story?: string }): void {
  try {
    localStorage.setItem(SPEC_PENDING_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable — pending values live for this page only */
  }
}

export function rememberPendingSpecValue(kind: 'epic' | 'story', value: string): void {
  const cur = readPendingSpecValues();
  writePendingSpecValues({ ...cur, [kind]: value });
  try {
    localStorage.setItem(SPEC_PENDING_BUMP, String(Date.now()));
  } catch {
    /* ignore */
  }
  for (const l of pendingBumpListeners) l();
}

/** Drop pending values the board now knows (called on every poll). */
function retirePendingValues(catalog: SpecCatalogShape): void {
  const pending = readPendingSpecValues();
  const next = { ...pending };
  if (pending.epic && catalog.epics.some((e) => e.toLocaleLowerCase() === pending.epic!.toLocaleLowerCase())) delete next.epic;
  if (pending.story && catalog.stories.some((s) => s.name.toLocaleLowerCase() === pending.story!.toLocaleLowerCase())) delete next.story;
  if (next.epic !== pending.epic || next.story !== pending.story) writePendingSpecValues(next);
}

export interface UseSpecCatalog {
  available: boolean;
  catalog: SpecCatalogShape | null;
  /** the server-authoritative compose context (the echo) */
  context: { epic?: string | null; story?: string | null };
  /** optimistic local mirror of the echo (last PUT) */
  selection: { epic?: string | null; story?: string | null };
  setSelection: (next: { epic?: string | null; story?: string | null }) => void;
}

/**
 * One hook for both halves of D10: the catalog (epic/story options + the
 * capture rollup for D11 filtering) and the compose context (server-
 * authoritative — §9 fold 5). Boots by RE-PUTting the localStorage mirror
 * once (restart survival), adopts every echo on the 20s poll (multi-tab
 * last-write-wins), and PUTs optimistically on each local change.
 */
export function useSpecCatalog(): UseSpecCatalog {
  const [catalog, setCatalog] = useState<SpecCatalogShape | null>(null);
  const [context, setContext] = useState<{ epic?: string | null; story?: string | null }>({});
  const [selection, setSel] = useState<{ epic?: string | null; story?: string | null }>({});

  const putContext = useCallback((next: { epic?: string | null; story?: string | null }) => {
    setSel(next);
    void fetch(new URL('dom-annotakit-spec-context', document.baseURI).href, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      fetch(new URL('dom-annotakit-spec.json', document.baseURI).href, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((s: SpecEndpointShape) => {
          if (!alive) return;
          setCatalog(s.catalog);
          setContext(s.context ?? {});
          setSel(s.context ?? {}); // §9 fold 5: the chip follows the server
          retirePendingValues(s.catalog);
          window.dispatchEvent(new CustomEvent(SPEC_CONTEXT_EVENT, { detail: s.context ?? {} }));
        })
        .catch(() => undefined); // static mode / server down: stay unavailable
    };
    /* §9 fold 5: restore + re-PUT the persisted context ONCE at boot so the
     * chips never diverge from what the server will actually inject.
     * Audit round-2 B-2: the re-PUT settles BEFORE the first poll — otherwise
     * a restarted server's EMPTY echo overwrote the optimistic mirror and
     * blanked the chips until the next 20s poll adopted the re-PUT. */
    let booted = false;
    const bootPut = (async (): Promise<void> => {
      try {
        const raw = localStorage.getItem(SPEC_CONTEXT_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw) as { epic?: string | null; story?: string | null };
        if (!saved || typeof saved !== 'object') return;
        setSel(saved);
        await fetch(new URL('dom-annotakit-spec-context', document.baseURI).href, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(saved),
        }).catch(() => undefined);
      } catch {
        /* ignore */
      } finally {
        booted = true;
      }
    })();
    void bootPut.then(() => poll()); // the first poll lands AFTER the re-PUT
    const timer = setInterval(() => {
      if (booted) poll(); // pre-boot polls would adopt a stale echo
    }, SPEC_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const setSelection = useCallback(
    (next: { epic?: string | null; story?: string | null }) => {
      try {
        localStorage.setItem(SPEC_CONTEXT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      putContext(next);
    },
    [putContext],
  );

  return { available: catalog != null, catalog, context, selection, setSelection };
}

/* ------------------------------- the combobox ------------------------------- */

export interface SpecBoxProps {
  label: string;
  options: string[];
  selected: string | null;
  onSelect: (value: string | null) => void;
  /** bumped to open via the ⌥E/⌥S chord (App-managed) */
  openSignal?: number;
  disabled?: boolean;
  title?: string;
}

export function SpecBox(props: SpecBoxProps): React.ReactElement {
  const [state, setState] = useState<ComboState>({ open: false, query: '', active: 0, selected: props.selected });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const rows = useMemo(() => comboOptions(props.options, state.query), [props.options, state.query]);

  /* external open requests (chord) — focus + open, exactly once per bump */
  useEffect(() => {
    if (props.openSignal == null || props.openSignal === 0) return;
    setState((s) => comboReduce(s, { type: 'open' }, props.options));
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openSignal]);

  /* keep the reducer's selected in sync when the App-level selection changes
   * (e.g. the story-cleared-on-epic-mismatch transition, or the echo poll) */
  useEffect(() => {
    setState((s) => (s.selected === props.selected ? s : { ...s, selected: props.selected }));
  }, [props.selected]);

  const commit = useCallback(
    (value: string | null): void => {
      setState({ open: false, query: '', active: 0, selected: value });
      props.onSelect(value);
    },
    [props.onSelect],
  );

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setState((s) => comboReduce(s, { type: 'move', delta: 1 }, props.options));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setState((s) => comboReduce(s, { type: 'move', delta: -1 }, props.options));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      /* audit round-1 P3: side effects NEVER inside the updater (StrictMode
       * double-invokes updaters in dev — a commit there fires the App's PUT
       * twice). Resolve the row from current state, then commit outside. */
      const row = comboOptions(props.options, state.query)[state.active];
      if (row) commit(row.value);
      else setState((s) => comboReduce(s, { type: 'close' }, props.options));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setState((s) => comboReduce(s, { type: 'close' }, props.options));
      inputRef.current?.blur();
    } else if (e.key === 'Tab') {
      /* §9 P3 fold: Tab COMMITS a typed-new value and continues — the input
       * keeps default tab behavior (no preventDefault), the commit rides the
       * blur edge below. */
      const typed = state.query.trim();
      if (typed && state.open) {
        const exact = props.options.find((o) => o.toLocaleLowerCase() === typed.toLocaleLowerCase());
        commit(exact ?? typed);
      } else if (state.open) {
        setState((s) => comboReduce(s, { type: 'close' }, props.options));
      }
    }
  };

  const activeRowId = rows[state.active] ? `${listId}-opt-${state.active}` : undefined;

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 11,
        minWidth: 0,
      }}
    >
      {state.selected ? (
        <span
          title={props.title ?? `${props.label}: ${state.selected} — click to change, × to clear`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            padding: '1px 4px 1px 8px',
            borderRadius: 999,
            border: `1px solid ${theme.colorSecondary}`,
            background: `${theme.colorSecondary}14`,
            color: theme.textColor,
            fontWeight: 600,
            maxWidth: 150,
          }}
        >
          <span
            role="button"
            tabIndex={0}
            aria-label={`Change ${props.label} selection`}
            onClick={() => {
              setState((s) => comboReduce(s, { type: 'open' }, props.options));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setState((s) => comboReduce(s, { type: 'open' }, props.options));
              }
            }}
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              fontSize: 10.5,
              fontWeight: 600,
              color: theme.barContentText,
            }}
          >
            {state.selected}
          </span>
          <button
            aria-label={`Clear ${props.label} selection`}
            title={`Clear ${props.label}`}
            onClick={() => commit(null)}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: theme.textMutedColor,
              padding: '0 3px',
              fontSize: 11,
              lineHeight: '11px',
            }}
          >
            ×
          </button>
        </span>
      ) : (
        <button
          type="button"
          aria-haspopup="listbox"
          title={props.title ?? `Filter + file new pins by ${props.label} (type to search or create)`}
          onClick={() => {
            setState((s) => comboReduce(s, { type: 'open' }, props.options));
            inputRef.current?.focus();
          }}
          style={{
            border: `1px solid ${theme.appBorderColor}`,
            borderRadius: 6,
            background: 'transparent',
            color: theme.barTextColor,
            padding: '2px 8px',
            fontSize: 11,
            fontWeight: 600,
            cursor: props.disabled ? 'default' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
          }}
        >
          {props.label} ▾
        </button>
      )}
      {state.open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 1000,
            marginTop: 3,
            minWidth: 190,
            maxWidth: 320,
            maxHeight: 260,
            overflow: 'auto',
            borderRadius: 8,
            border: `1px solid ${theme.appBorderColor}`,
            background: theme.backgroundBar,
            boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
            padding: 4,
          }}
        >
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeRowId}
            aria-label={`${props.label} search`}
            autoFocus
            value={state.query}
            onChange={(e) => setState((s) => comboReduce(s, { type: 'type', query: e.target.value }, props.options))}
            onKeyDown={onKey}
            onBlur={() =>
              setTimeout(() => setState((s) => (s.open ? comboReduce(s, { type: 'close' }, props.options) : s)), 120)
            }
            placeholder={`Search or create ${props.label.toLowerCase()}…`}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: `1px solid ${theme.appBorderColor}`,
              borderRadius: 6,
              background: theme.background,
              color: theme.textColor,
              padding: '4px 8px',
              fontSize: 11,
              marginBottom: 4,
              outline: 'none',
            }}
          />
          <ul role="listbox" id={listId} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {rows.map((row, i) => (
              <li
                key={`${row.kind}:${row.value}`}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === state.active}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep input focus — the click commits
                  commit(row.value);
                }}
                onMouseEnter={() => setState((s) => ({ ...s, active: i }))}
                style={{
                  padding: '4px 8px',
                  borderRadius: 5,
                  cursor: 'pointer',
                  fontSize: 11.5,
                  background: i === state.active ? `${theme.colorSecondary}22` : 'transparent',
                  color: row.kind === 'create' ? theme.colorSecondary : theme.textColor,
                  fontWeight: row.kind === 'create' ? 600 : 400,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {row.kind === 'create' ? `Create “${row.value}”` : row.value}
              </li>
            ))}
            {rows.length === 0 && (
              <li style={{ padding: '6px 8px', fontSize: 11, color: theme.textMutedColor }}>no matches</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

