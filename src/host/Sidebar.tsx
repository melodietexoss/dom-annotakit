/**
 * dom-annotakit — capture browser sidebar (design D2a "host shell").
 *
 * Lists the manifest's captures (id, provenance URL/date, size); selection
 * drives the iframe's src. The manifest carries BOTH id and relpath
 * (capture-id.ts notes why) — this surface reads it, plus D12's manage
 * affordance (upload via file picker + drag-drop) and D11's two-level
 * filter banner.
 *
 * D7 (2026-10-23): the DISPLAY identity is the FILENAME, extension-stripped
 * (captureName) — never the page `<title>` (users organize captures by
 * renaming files). The tooltip keeps the provenance (relpath, saved-from
 * URL, saved date).
 *
 * D8: sort control — by NAME (captureName, case-insensitive locale compare)
 * or DATE (savedDate, ISO-valid only), asc or desc, persisted
 * (`dom-annotakit:sort`).
 *
 * D12 (2026-10-26): Upload = multi-file picker + drop-zone over the whole
 * sidebar (JSON {name, content} per file → the server commits each capture
 * to git — git-is-the-disk; collisions ask before overwriting). Static mode
 * has no server: the affordance hides (honest).
 *
 * D15 (2026-10-27, session 5): capture DELETE is GONE (user directive —
 * removal is a git/CLI concern, never a UI click); the row button also gets
 * an EXPLICIT transparent background (Chrome's UA default #EFEFEF painted
 * every row WHITE in dark mode — the "left panel disaster") + a hover tint.
 *
 * D11: when a spec filter is active, only matching captures list (the rollup
 * comes from the spec endpoint via App), with a one-click clear banner.
 */

import React, { useMemo, useRef, useState } from 'react';
import type { CaptureEntry } from './inject';
import { captureName } from './capture-id';
import { theme } from './theme';

export interface SidebarProps {
  captures: CaptureEntry[];
  currentId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  error: string | null;
  /** D11: matching capture ids when a filter is active — null = no filter. */
  filterIds: string[] | null;
  /** D11: the active filter's display label ("Epic · Story"). */
  filterLabel: string | null;
  /** s6: per-capture MATCH-COUNTS while a filter is active (pair-exact under
   *  two-level selections) — null = no filter. Drives the row chips. */
  filterCounts: Record<string, number> | null;
  onClearFilter: () => void;
  /** D12: multi-file upload (the server handles git durability). */
  onUpload: (files: File[]) => void;
  /** D12: transient upload feedback (busy/message/error). */
  ops: { busy: boolean; message: string | null; error: string | null };
  /** D12 + audit P3-2: upload/drop need the standalone server —
   *  static builds have no /dom-annotakit-captures behind them, so the
   *  manage affordance HIDES (probeMode-driven, App passes it). */
  manageEnabled?: boolean;
}

type SortKey = 'name' | 'date';
type SortDir = 'asc' | 'desc';
const SORT_KEY_STORAGE = 'dom-annotakit:sort';

function readStoredSort(): { key: SortKey; dir: SortDir } {
  try {
    const raw = localStorage.getItem(SORT_KEY_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw) as { key?: unknown; dir?: unknown };
      if ((parsed.key === 'name' || parsed.key === 'date') && (parsed.dir === 'asc' || parsed.dir === 'desc')) {
        return { key: parsed.key, dir: parsed.dir };
      }
    }
  } catch {
    /* ignore — defaults apply */
  }
  return { key: 'name', dir: 'asc' };
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** Valid ISO date or null (P3-1: unparseable savedDate = missing → last). */
function dateMs(iso?: string): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function Sidebar(props: SidebarProps): React.ReactElement {
  const manage = props.manageEnabled !== false;
  const [sort, setSort] = useState(readStoredSort);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const applySort = (next: { key: SortKey; dir: SortDir }): void => {
    setSort(next);
    try {
      localStorage.setItem(SORT_KEY_STORAGE, JSON.stringify(next));
    } catch {
      /* storage unavailable — the choice lives for this page only */
    }
  };

  const filterSet = useMemo(() => (props.filterIds ? new Set(props.filterIds) : null), [props.filterIds]);

  const sorted = useMemo(() => {
    const arr = [...props.captures];
    const dir = sort.dir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      if (sort.key === 'date') {
        const da = dateMs(a.savedDate);
        const db = dateMs(b.savedDate);
        if (da === null && db === null) return 0;
        if (da === null) return 1; // missing ALWAYS last, regardless of dir
        if (db === null) return -1;
        return (da - db) * dir;
      }
      return captureName(a.relpath).localeCompare(captureName(b.relpath), undefined, { sensitivity: 'base' }) * dir;
    });
    return arr;
  }, [props.captures, sort]);

  const visible = useMemo(
    () => (filterSet ? sorted.filter((c) => filterSet.has(c.id)) : sorted),
    [sorted, filterSet],
  );

  const segBtn = (key: SortKey, label: string): React.ReactElement => (
    <button
      aria-pressed={sort.key === key}
      title={`Sort by ${key === 'name' ? 'file name' : 'saved date'}`}
      onClick={() => applySort({ key, dir: sort.dir })}
      style={{
        border: 'none',
        padding: '2px 7px',
        fontSize: 10.5,
        fontWeight: sort.key === key ? 700 : 400,
        cursor: 'pointer',
        background: sort.key === key ? theme.colorSecondary : 'transparent',
        color: sort.key === key ? '#fff' : theme.textMutedColor,
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        width: 250,
        minWidth: 250,
        borderRight: `1px solid ${theme.appBorderColor}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: theme.backgroundBar,
        position: 'relative',
      }}
      onDragOver={(e) => {
        if (manage && e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (manage && e.dataTransfer?.files?.length) {
          e.preventDefault();
          props.onUpload(Array.from(e.dataTransfer.files));
        }
      }}
    >
      <div
        style={{
          padding: '10px 12px 8px',
          fontSize: 12,
          fontWeight: 700,
          color: theme.barContentText,
          borderBottom: `1px solid ${theme.appBorderColor}`,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        Captures
        <span style={{ fontWeight: 400, color: theme.textMutedColor }}>
          {' '}
          · {visible.length}
          {filterSet && visible.length !== props.captures.length ? `/${props.captures.length}` : ''}
        </span>
        {/* D12: upload — multi-file picker (drag-drop works too). Static
            builds: hidden (no server behind the route — audit P3-2). */}
        {manage && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,.htm"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = ''; // re-picking the same file re-fires change
                if (files.length) props.onUpload(files);
              }}
            />
            <button
              title="Upload SingleFile captures (.html) — or drop files anywhere on this sidebar. New captures commit to git automatically."
              aria-label="Upload captures"
              disabled={props.ops.busy}
              onClick={() => fileInputRef.current?.click()}
              style={{
                marginLeft: 'auto',
                border: `1px solid ${theme.appBorderColor}`,
                borderRadius: 6,
                background: 'transparent',
                padding: '2px 8px',
                fontSize: 10.5,
                fontWeight: 600,
                cursor: props.ops.busy ? 'default' : 'pointer',
                color: theme.barContentText,
              }}
            >
              {props.ops.busy ? '…' : '↑ Upload'}
            </button>
          </>
        )}
      </div>
      {/* D11: the filter banner — one click clears (both levels). */}
      {props.filterLabel && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            fontSize: 11,
            borderBottom: `1px solid ${theme.appBorderColor}`,
            background: `${theme.colorSecondary}10`,
            color: theme.barContentText,
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }} title={`Filtered: ${props.filterLabel}`}>
            ⛭ {props.filterLabel}
          </span>
          <button
            title="Clear the epic/story filter"
            aria-label="Clear filter"
            onClick={props.onClearFilter}
            style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', color: theme.textMutedColor, fontSize: 11, padding: '0 3px' }}
          >
            clear ×
          </button>
        </div>
      )}
      {/* D8: the sort row — name/date + direction, persisted */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 12px',
          borderBottom: `1px solid ${theme.appBorderColor}`,
        }}
      >
        <div style={{ display: 'flex', border: `1px solid ${theme.appBorderColor}`, borderRadius: 6, overflow: 'hidden' }}>
          {segBtn('name', 'Name')}
          {segBtn('date', 'Date')}
        </div>
        <button
          aria-label={sort.dir === 'asc' ? 'Sort ascending' : 'Sort descending'}
          title={sort.dir === 'asc' ? `Ascending — click for descending` : `Descending — click for ascending`}
          onClick={() => applySort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
          style={{
            border: `1px solid ${theme.appBorderColor}`,
            borderRadius: 6,
            background: 'transparent',
            padding: '2px 8px',
            fontSize: 10.5,
            cursor: 'pointer',
            color: theme.barContentText,
          }}
        >
          {sort.dir === 'asc' ? '↑' : '↓'}
        </button>
      </div>
      {/* D12: transient op feedback (uploads) */}
      {(props.ops.message || props.ops.error) && (
        <div
          role={props.ops.error ? 'alert' : 'status'}
          style={{
            padding: '6px 12px',
            fontSize: 11,
            color: props.ops.error ? theme.danger : '#15803d',
            borderBottom: `1px solid ${theme.appBorderColor}`,
            whiteSpace: 'pre-wrap',
          }}
        >
          {props.ops.error ?? props.ops.message}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
        {props.error && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: theme.danger, whiteSpace: 'pre-wrap' }}>
            manifest unavailable: {props.error}
          </div>
        )}
        {props.loading && <div style={{ padding: '8px 12px', fontSize: 11, color: theme.textMutedColor }}>loading…</div>}
        {visible.map((c) => {
          const active = c.id === props.currentId;
          const host = hostOf(c.url);
          /* D15: hover tint lives on the ROW div (the button stays fully
           * transparent — the UA default #EFEFEF must never bleed through). */
          const rowBg = active ? `${theme.colorSecondary}18` : 'transparent';
          return (
            <div
              key={c.id}
              style={{ display: 'flex', alignItems: 'stretch', background: rowBg, borderLeft: `3px solid ${active ? theme.colorSecondary : 'transparent'}` }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = `${theme.colorSecondary}${active ? '2e' : '1a'}`;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = rowBg;
              }}
            >
              <button
                onClick={() => props.onSelect(c.id)}
                title={`${c.relpath}${host ? `\nsaved from ${c.url}` : ''}${c.savedDate ? `\nsaved ${c.savedDate}` : ''}`}
                style={{
                  display: 'block',
                  flex: 1,
                  minWidth: 0,
                  textAlign: 'left',
                  padding: '7px 6px 7px 9px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  color: active ? theme.textColor : theme.barContentText,
                }}
              >
                {/* D7: ALWAYS the filename (minus extension) — never the page title */}
                <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {captureName(c.relpath)}
                </div>
                <div style={{ fontSize: 10.5, color: theme.textMutedColor, marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
                  {props.filterCounts && (props.filterCounts[c.id] ?? 0) > 0 && (
                    <span
                      title={`${props.filterCounts[c.id]} thread(s) match ${props.filterLabel ?? 'the filter'}`}
                      aria-label={`${props.filterCounts[c.id]} matching threads`}
                      style={{
                        background: `${theme.colorSecondary}22`,
                        color: theme.colorSecondary,
                        borderRadius: 8,
                        padding: '0 6px',
                        fontWeight: 700,
                        fontSize: 9.5,
                        lineHeight: '15px',
                        flexShrink: 0,
                      }}
                    >
                      {props.filterCounts[c.id]}
                    </span>
                  )}
                  <span>{fmtSize(c.size)}</span>
                  {host && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{host}</span>}
                  {c.savedDate && <span style={{ marginLeft: 'auto' }}>{c.savedDate.slice(0, 10)}</span>}
                </div>
              </button>
            </div>
          );
        })}
        {!props.loading && !props.error && visible.length === 0 && props.captures.length > 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: theme.textMutedColor }}>
            No captures match the filter — <button onClick={props.onClearFilter} style={{ border: 'none', background: 'transparent', color: theme.colorSecondary, cursor: 'pointer', fontSize: 11, padding: 0, textDecoration: 'underline' }}>clear it</button> or drop an .html file here.
          </div>
        )}
        {!props.loading && !props.error && props.captures.length === 0 && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: theme.textMutedColor }}>
            No captures — drop SingleFile .html files here, upload with ↑, or put them in the captures directory.
          </div>
        )}
      </div>
      {/* D6: the comment-directive hint — discoverability without touching the
          vendored panel (the ONLY new copy in the shell; zero-interference in
          zen). */}
      <div
        style={{
          padding: '7px 12px',
          fontSize: 10.5,
          lineHeight: 1.45,
          color: theme.textMutedColor,
          borderTop: `1px solid ${theme.appBorderColor}`,
          whiteSpace: 'normal',
        }}
        title="Comments carrying these directives file their threads on the synced GH Projects board when it mirrors. Selecting an Epic/Story above files NEW comments automatically."
      >
        Tip: pick an Epic/Story in the toolbar to filter AND file new pins — or start a comment with <code>@epic:</code> / <code>@story:</code>.{' '}
      </div>
      {/* D12: the drop overlay */}
      {dragOver && manage && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${theme.colorSecondary}22`,
            border: `2px dashed ${theme.colorSecondary}`,
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 700,
            color: theme.barContentText,
            pointerEvents: 'none',
          }}
        >
          Drop .html captures to upload
        </div>
      )}
    </div>
  );
}
