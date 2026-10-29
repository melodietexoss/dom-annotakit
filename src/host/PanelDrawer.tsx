/**
 * dom-annotakit — the bottom drawer that hosts the ported ReviewPanel
 * (COPY-MAP manager row: SB's addons.add(PANEL) registration → this
 * component).
 *
 * The SB `layout.showPanel` interplay is REPLACED by plain drawer state owned
 * by App; the vendored panelToggle.ts truth-table helper still runs the toggle
 * through its PanelToggleApi shim (trivially backed by that state) so the
 * unit-pinned semantics stay the ones in play. Entry points, mirroring
 * upstream's three: the toolbar button (App), the host-focus ⌥P bridge, and
 * the layer's in-canvas ⌥P via the TOGGLE_THREADS_PANEL channel event.
 *
 * Dock: bottom, resizable height (drag the handle); the drawer is a FLEX ROW
 * member, not an overlay — the iframe above shrinks with it, so pins
 * re-anchor (the scrolling contract's resize path).
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { hostChannel } from './channel';
import { theme } from './theme';
import { ReviewPanel } from './panel/ReviewPanel';
import { TOGGLE_THREADS_PANEL } from '../shared/events';
import { DEFAULT_HOTKEYS, hotkeyMatches, isTypingTarget, parseHotkey } from '../shared/hotkeys';
import { toggleThreadsPanel as sharedToggleThreadsPanel, type PanelToggleApi } from '../shared/panelToggle';

const PANEL_ID = 'annotakit/panel';

export interface PanelDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  height: number;
  onHeightChange: (height: number) => void;
  /** current captureId — the panel's 'This capture' scope key. */
  captureId?: string;
  /** cross-capture focus/recall lands here (App switches the capture). */
  onSelectCapture: (storyId: string) => void;
  /** D11: the Epic/Story filter pass-through (App → panel threads). */
  specFilter?: { epic: string | null; story: string | null };
  /** D15: the panel's ⛭ chips clear a filter level (App owns the state). */
  onSpecFilterClear?: (kind: 'epic' | 'story') => void;
}

const MIN_HEIGHT = 120;

export function PanelDrawer(props: PanelDrawerProps): React.ReactElement {
  const { open, onOpenChange } = props;

  /* the PanelToggleApi shim — plain drawer state behind the vendored truth
   * table (getSelectedPanel/getIsPanelShown drive the close branch; only our
   * panel exists, so selection is implicit). */
  const api: PanelToggleApi = {
    getSelectedPanel: () => (open ? PANEL_ID : undefined),
    getIsPanelShown: () => open,
    setSelectedPanel: () => undefined, // only OUR panel exists — selection is implicit
    togglePanel: (next) => onOpenChange(typeof next === 'boolean' ? next : !open),
  };
  const doToggle = useCallback((): void => {
    sharedToggleThreadsPanel(api, PANEL_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onOpenChange]);

  /* host-focus ⌥P bridge (the manager-side bridge's panel entry, upstream
   * v0.6.11 S7-B) + the layer's in-canvas ⌥P via TOGGLE_THREADS_PANEL. */
  useEffect(() => {
    const hkDrawer = parseHotkey(DEFAULT_HOTKEYS.drawer, DEFAULT_HOTKEYS.drawer);
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return; // synthetic dispatches stay single-source
      if (isTypingTarget(e.target)) return;
      if (!e.repeat && hotkeyMatches(e, hkDrawer)) doToggle();
    };
    document.addEventListener('keydown', onKey);
    const onChannel = (): void => doToggle();
    hostChannel.on(TOGGLE_THREADS_PANEL, onChannel);
    return () => {
      document.removeEventListener('keydown', onKey);
      hostChannel.removeListener(TOGGLE_THREADS_PANEL, onChannel);
    };
  }, [doToggle]);

  /* resize drag — pointer events on the handle, clamped to [MIN_HEIGHT, 80% vh]. */
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.button !== 0) return;
      dragRef.current = { startY: e.clientY, startH: props.height };
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
    },
    [props.height],
  );
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d) return;
      const max = Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.8));
      const next = Math.min(max, Math.max(MIN_HEIGHT, d.startH + (d.startY - e.clientY)));
      if (next !== props.height) props.onHeightChange(next);
    };
    const onUp = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [props.height, props.onHeightChange]);

  if (!props.open) return <></>;

  return (
    <div
      style={{
        height: props.height,
        borderTop: `1px solid ${theme.appBorderColor}`,
        background: theme.background,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      <div
        onPointerDown={onHandleDown}
        title="Drag to resize the threads panel"
        style={{
          height: 6,
          cursor: 'row-resize',
          background: 'transparent',
          borderTop: `1px solid ${theme.appBorderColor}`,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <ReviewPanel
          channel={hostChannel}
          storyId={props.captureId}
          onSelectStory={props.onSelectCapture}
          specFilter={props.specFilter}
          onSpecFilterClear={props.onSpecFilterClear}
        />
      </div>
    </div>
  );
}
