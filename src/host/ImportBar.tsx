/**
 * dom-annotakit — the SingleFile import bar (M4, design D2c-6; host shell
 * "import affordance"). Rendered below the toolbar, ABOVE the capture iframe.
 *
 * OFFER (amber): the capture carries embedded SingleFile notes and this
 * browser has no auto-strip flag for it yet. The copy is honest about the
 * trade (D13): notes become annotakit threads; the sticky cards are HIDDEN
 * (the SF toggle in the toolbar re-shows them; annotakit pins represent
 * them where the target still exists; dangling/page-level notes stay
 * panel-only).
 *
 * DONE: the summary notice replaces the bar after a run — the exact
 * import counts (formatImportSummary) + the pinned/dangling split, so a
 * partial import (per-note failures, tombstoned ids) never looks like a
 * silent success.
 *
 * The bar never shows when the imported flag is set (the host HIDES the
 * cards at load and skips the bar) or when the layer failed to inject (the
 * anchor capture needs the in-iframe engine).
 */

import React from 'react';
import { formatImportSummary, type ImportSummary } from './import';
import { theme } from './theme';

export type ImportState =
  | { kind: 'hidden' }
  | { kind: 'offer'; count: number }
  | { kind: 'busy' }
  | { kind: 'done'; summary: ImportSummary }
  | { kind: 'error'; message: string };

export function ImportBar({ state, onImport }: { state: ImportState; onImport: () => void }): React.ReactElement | null {
  if (state.kind === 'hidden') return null;

  const base: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    borderBottom: `1px solid ${theme.appBorderColor}`,
  };

  if (state.kind === 'offer') {
    return (
      <div role="status" data-import-bar="offer" style={{ ...base, background: '#f59e0b18', color: '#b45309' }}>
        <span style={{ flex: 1 }}>
          <b>This capture carries {state.count} embedded SingleFile note{state.count === 1 ? '' : 's'}</b> — sticky
          cards SingleFile drew on the page. Import them as annotakit threads? The note texts become review threads
          (pinned where their target still exists in the capture; notes whose target is gone stay panel-only), and
          the sticky cards are hidden — the toolbar SF toggle re-shows them anytime.
        </span>
        <button
          data-import-button="1"
          style={{
            padding: '3px 10px',
            fontSize: 11,
            fontWeight: 700,
            cursor: 'pointer',
            borderRadius: 6,
            border: '1px solid #b45309',
            background: '#f59e0b22',
            color: '#b45309',
          }}
          onClick={onImport}
        >
          Import {state.count} SingleFile note{state.count === 1 ? '' : 's'}
        </button>
      </div>
    );
  }

  if (state.kind === 'busy') {
    return (
      <div role="status" data-import-bar="busy" style={{ ...base, background: '#f59e0b18', color: '#b45309' }}>
        Importing SingleFile notes — parsing, hiding the sticky cards, capturing anchors, creating threads…
      </div>
    );
  }

  if (state.kind === 'done') {
    const s = state.summary;
    const split: string[] = [];
    if (s.pinned) split.push(`${s.pinned} with canvas pins`);
    const panelOnly = s.dangling + s.pageLevel;
    if (panelOnly) split.push(`${panelOnly} panel-only (dangling/page-level${s.pageLevel ? `, incl. ${s.pageLevel} page-level` : ''})`);
    if (s.cardsHidden > 0) split.push(`${s.cardsHidden} sticky card${s.cardsHidden === 1 ? '' : 's'} hidden`);
    return (
      <div role="status" data-import-bar="done" style={{ ...base, background: '#16a34a18', color: '#15803d' }}>
        <span style={{ flex: 1 }}>
          <b>SingleFile import</b> — {formatImportSummary(s)}
          {split.length ? `. ${split.join(' · ')}.` : ''}
          {s.errors.length ? <span style={{ color: '#b45309' }}> First error: {s.errors[0]}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div role="alert" data-import-bar="error" style={{ ...base, background: '#FF440018', color: '#FF4400' }}>
      <span style={{ flex: 1 }}>SingleFile import failed — {state.message}. Reload the capture and retry.</span>
    </div>
  );
}
