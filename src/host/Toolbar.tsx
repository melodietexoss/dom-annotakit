/**
 * dom-annotakit — host toolbar (COPY-MAP manager row: the SB TOOL
 * AnnotaKitTool → this component; identical commands/payloads).
 *
 * pin · region · freeze · threads+count · show/hide — the same five upstream
 * affordances, driven over the host channel (UI_COMMAND {command} /
 * TOGGLE_LAYER shape) and reflecting reality via the layer's UI_STATE +
 * LAYER_STATE acks (armed mode, visibility, counts, api up/down), never
 * host-local guesses.
 *
 * The any-focus hotkey BRIDGE is ported with it: native keydowns on the HOST
 * document emit the same commands (the layer binds its own listener on the
 * IFRAME document — two documents, so the bridge can never double-fire).
 *
 * Freeze button: disabled + hinted when the capture exceeds the 20MB clone
 * threshold (design D2a freeze gate) — the layer's own ⌥I/UI_COMMAND gate
 * says the same hint from inside.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { hostChannel } from './channel';
import { BoxIcon, CommentsIcon, EyeCloseIcon, EyeIcon, MoonIcon, PinIcon, SunIcon } from './icons';
import { theme } from './theme';
import { captureName } from './capture-id';
import { useProjectStatus, projectStatusTitle } from './projectStatus';
import { SpecBox } from './specBox';
import type { CaptureEntry } from './inject';
import {
  LAYER_STATE,
  UI_COMMAND,
  UI_STATE,
  type UiCommand,
  type UiState,
} from '../shared/events';
import {
  DEFAULT_HOTKEYS,
  hotkeyLabel,
  hotkeyMatches,
  isTypingTarget,
  parseHotkey,
  type Hotkeys,
} from '../shared/hotkeys';

const FREEZE_MAX_BYTES = 20 * 1024 * 1024;

export interface ToolbarProps {
  capture: CaptureEntry | null;
  panelOpen: boolean;
  onTogglePanel: () => void;
  /** D5: enter maximized zero-chrome review (⌥Z). The toolbar hides once
   *  zen is on, so this is the entry affordance, never an exit one. */
  onZen: () => void;
  /** D9: the dark-mode toggle (App owns the mode state via useHostTheme). */
  onToggleTheme: () => void;
  darkMode: boolean;
  /* ---- D10/D11: the spec comboboxes (filter + compose context) ---- */
  specAvailable: boolean;
  epicOptions: string[];
  storyOptions: string[];
  epicSelected: string | null;
  storySelected: string | null;
  /** a selection change (kind, value|null) — App runs nextSelection + PUTs. */
  onSpecSelect: (kind: 'epic' | 'story', value: string | null) => void;
  /** bumped by the ⌥E/⌥S chords to open the respective box */
  epicOpenSignal: number;
  storyOpenSignal: number;
  /* ---- D13: the SingleFile original-annotations toggle ---- */
  /** present only when the capture carries ≥1 SF note: count + current state */
  sfNotes: { count: number; visible: boolean } | null;
  onToggleSfNotes: () => void;
}

/** UI_STATE + LAYER_STATE mirror (upstream useAnnotaHotkeys, trimmed to the
 *  toolbar's needs — zen UNMOUNTS this component (App hides it): the mirror
 *  resets to defaults and self-heals on the next layer ack; no module cache
 *  either way). */
function useLayerUi(): { hk: Hotkeys; hotkeysOn: boolean; ui: UiState | null; layerVisible: boolean } {
  const [ui, setUi] = useState<UiState | null>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const onState = (s: UiState | undefined) => {
      if (s && typeof s === 'object') setUi(s);
    };
    const onLayer = (v: unknown) => {
      if (typeof v === 'boolean') setVisible(v);
    };
    hostChannel.on(UI_STATE, onState);
    hostChannel.on(LAYER_STATE, onLayer);
    return () => {
      hostChannel.removeListener(UI_STATE, onState);
      hostChannel.removeListener(LAYER_STATE, onLayer);
    };
  }, []);
  return {
    hk: ui?.hotkeys ?? DEFAULT_HOTKEYS,
    hotkeysOn: ui?.hotkeys !== null,
    ui,
    layerVisible: (ui?.visible ?? true) && visible,
  };
}

export function Toolbar(props: ToolbarProps): React.ReactElement {
  const { hk, hotkeysOn, ui, layerVisible } = useLayerUi();
  const { status: project } = useProjectStatus();

  const emit = useCallback((command: UiCommand['command']): void => {
    hostChannel.emit(UI_COMMAND, { command });
  }, []);

  const freezeSizeOk = props.capture ? props.capture.size <= FREEZE_MAX_BYTES : true;
  const frozenViewEnabled = ui?.frozenViewEnabled !== false;
  const freezeEnabled = frozenViewEnabled && freezeSizeOk;

  /* the any-focus hotkey bridge (upstream v0.6.10 S6-D3d, host side) */
  const hkSpecs = useMemo(
    () => ({
      pin: parseHotkey(hk.pin, DEFAULT_HOTKEYS.pin),
      region: parseHotkey(hk.region, DEFAULT_HOTKEYS.region),
      layer: parseHotkey(hk.layer, DEFAULT_HOTKEYS.layer),
      freeze: parseHotkey(hk.freeze, DEFAULT_HOTKEYS.freeze),
    }),
    [hk],
  );
  useEffect(() => {
    if (!hotkeysOn) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return; // synthetic dispatches (the E2E path) stay single-source
      if (isTypingTarget(e.target)) return;
      if (hotkeyMatches(e, hkSpecs.pin)) emit('pin');
      else if (hotkeyMatches(e, hkSpecs.region)) emit('region');
      else if (hotkeyMatches(e, hkSpecs.layer)) emit('layer');
      else if (hotkeyMatches(e, hkSpecs.freeze)) emit('freeze');
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [hkSpecs, hotkeysOn, emit]);

  const apiDown = ui?.apiOk === false;
  const armed = (on: boolean): React.CSSProperties => ({
    color: on ? theme.barSelectedColor : theme.barTextColor,
    opacity: on ? 1 : 0.75,
  });
  const btn = (
    key: string,
    label: string,
    icon: React.ReactNode,
    on: boolean,
    onClick: () => void,
    disabled?: boolean,
    title?: string,
  ): React.ReactElement => (
    <button
      key={key}
      title={title ?? (apiDown ? 'Annotakit: no store reachable — start the standalone server (npm run serve)' : label)}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled ?? apiDown}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 4,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        cursor: disabled || apiDown ? 'default' : 'pointer',
        ...armed(on),
      }}
      onClick={onClick}
    >
      {icon}
    </button>
  );

  const kPin = hotkeysOn ? ` (${hotkeyLabel(hk.pin, DEFAULT_HOTKEYS.pin)})` : '';
  const kRegion = hotkeysOn ? ` (${hotkeyLabel(hk.region, DEFAULT_HOTKEYS.region)})` : '';
  const kLayer = hotkeysOn ? ` (${hotkeyLabel(hk.layer, DEFAULT_HOTKEYS.layer)})` : '';

  const open = ui?.open ?? 0;
  const fixed = ui?.fixed ?? 0;
  const rejected = ui?.rejected ?? 0;
  const total = ui?.total ?? 0;

  const freezeTitle = !freezeSizeOk
    ? 'Frozen views are disabled for this capture — it exceeds the 20MB clone threshold (too large to freeze safely)'
    : apiDown
      ? 'Annotakit: no store reachable — start the standalone server (npm run serve)'
      : ui?.frozen === true
        ? 'Thaw the frozen view (Esc) — pin what you see while it lasts'
        : `Freeze the current view${hotkeysOn ? ` (${hotkeyLabel(hk.freeze, DEFAULT_HOTKEYS.freeze)} — no mouse movement, so hover-driven UI cannot close)` : ''}`;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '3px 10px',
        borderBottom: `1px solid ${theme.appBorderColor}`,
        background: theme.backgroundBar,
        minHeight: 34,
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: theme.barContentText,
          maxWidth: '46%',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={props.capture?.relpath}
      >
        {/* D7: ALWAYS the filename (minus extension) — never the page title */}
        {props.capture ? captureName(props.capture.relpath) : 'no capture selected'}
      </span>
      <span style={{ flex: 1 }} />
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        {/* D10/D11 — the Epic/Story selectors: typeahead + keyboard +
            create-on-new. They BOTH filter the sidebar/panel (D11) and set
            the compose context: new comments gain the missing @epic:/@story:
            lines server-side (the board body keeps the honest record). ⌥E/⌥S
            open them from either document (inject.ts forwards the chord). */}
        {props.specAvailable && (
          <>
            <SpecBox
              label="Epic"
              options={props.epicOptions}
              selected={props.epicSelected}
              onSelect={(v) => props.onSpecSelect('epic', v)}
              openSignal={props.epicOpenSignal}
              title="Epic — filters the capture list + panel, and files NEW comments under it (⌥E)"
            />
            <SpecBox
              label="Story"
              options={props.storyOptions}
              selected={props.storySelected}
              onSelect={(v) => props.onSpecSelect('story', v)}
              openSignal={props.storyOpenSignal}
              title={`Story${props.epicSelected ? ' (scoped to the selected Epic)' : ''} — filters + files NEW comments (⌥S)`}
            />
          </>
        )}
        {/* D13 — SingleFile's ORIGINAL annotation cards: hidden by default
            after import (our pins represent them); this toggles their
            display WITHOUT touching the DOM tree (anchors stay consistent
            — hidden cards still count for :nth-child). */}
        {props.sfNotes && props.sfNotes.count > 0 && (
          <button
            title={
              props.sfNotes.visible
                ? `SingleFile annotations: VISIBLE (${props.sfNotes.count}) — click to hide`
                : `SingleFile annotations: hidden (${props.sfNotes.count}) — click to show`
            }
            aria-label="Toggle SingleFile annotations"
            aria-pressed={props.sfNotes.visible}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 4,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              cursor: 'pointer',
              color: props.sfNotes.visible ? theme.barSelectedColor : theme.barTextColor,
              fontSize: 11,
              fontWeight: 600,
            }}
            onClick={props.onToggleSfNotes}
          >
            {props.sfNotes.visible ? <EyeIcon width={13} height={13} /> : <EyeCloseIcon width={13} height={13} />}
            SF
          </button>
        )}
        {btn(
          'pin',
          `Pin a comment to an element${kPin}`,
          <PinIcon width={14} height={14} />,
          ui?.mode === 'pin',
          () => emit('pin'),
        )}
        {btn(
          'region',
          `Mark a region${kRegion}`,
          <BoxIcon width={14} height={14} />,
          ui?.mode === 'region',
          () => emit('region'),
        )}
        {btn(
          'freeze',
          freezeTitle,
          <span style={{ fontSize: 14, lineHeight: '14px' }} aria-hidden>
            ❄
          </span>,
          ui?.frozen === true,
          () => emit('freeze'),
          !freezeEnabled,
          freezeTitle,
        )}
        <button
          key="threads"
          title={`Open the Annotakit threads panel — the bottom drawer${hotkeysOn ? ` (${hotkeyLabel(hk.drawer, DEFAULT_HOTKEYS.drawer)})` : ''}`}
          aria-label="Annotakit threads panel"
          aria-pressed={props.panelOpen}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
            ...armed(props.panelOpen),
          }}
          onClick={props.onTogglePanel}
        >
          <CommentsIcon width={14} height={14} />
          {total > 0 && (
            <span
              title={
                open > 0 || fixed > 0 || rejected > 0
                  ? `${open} open · ${fixed} fixed (awaiting review) · ${rejected} rejected (re-work) · ${total} total`
                  : `${total} threads, all resolved`
              }
              style={{
                background: open > 0 ? '#d97706' : fixed > 0 ? '#2563eb' : rejected > 0 ? '#dc2626' : '#94a3b8',
                color: '#fff',
                borderRadius: 999,
                minWidth: 16,
                height: 16,
                lineHeight: '16px',
                textAlign: 'center',
                fontSize: 10,
                padding: '0 4px',
                fontWeight: 700,
              }}
            >
              {open > 0 ? open : fixed > 0 ? fixed : rejected > 0 ? rejected : total}
            </span>
          )}
        </button>
        {/* D6: the spec-board chip — the honest sync surface (serve: polled
            status endpoint; static: the projectClient's window event). Click
            opens the board; the tooltip carries state/counts/last-sync/error
            + the real recovery path. */}
        <button
          key="project-spec"
          title={project ? projectStatusTitle(project) : 'GH spec board: probing…'}
          aria-label="GH spec board"
          disabled={!project?.projectUrl}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            cursor: project?.projectUrl ? 'pointer' : 'default',
            color: theme.barTextColor,
            fontSize: 11,
            fontWeight: 600,
          }}
          onClick={() => {
            if (project?.projectUrl) window.open(project.projectUrl, '_blank', 'noopener');
          }}
        >
          <span
            aria-hidden
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background:
                project?.state === 'ok' ? '#66BF3C' : project?.state === 'error' ? theme.danger : project?.state === 'dormant' ? '#94a3b8' : 'transparent',
            }}
          />
          Spec
          {project?.state === 'ok' && typeof project.items === 'number' && (
            <span style={{ fontWeight: 400, color: theme.textMutedColor }}>{project.items}</span>
          )}
        </button>
        {/* D9: the dark-mode toggle (audit 5-b-r: aria-pressed exposes the
            CURRENT state — an always-identical label hid it from SR users) */}
        <button
          key="theme"
          title={props.darkMode ? 'Light mode' : 'Dark mode'}
          aria-label={props.darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-pressed={props.darkMode}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 4,
            display: 'inline-flex',
            cursor: 'pointer',
            color: theme.barTextColor,
          }}
          onClick={props.onToggleTheme}
        >
          {props.darkMode ? <SunIcon width={14} height={14} /> : <MoonIcon width={14} height={14} />}
        </button>
        <span style={{ width: 1, height: 16, background: theme.appBorderColor, margin: '0 4px' }} />
        {btn(
          'layer',
          layerVisible ? `Hide Annotakit pins${kLayer}` : `Show Annotakit pins${kLayer}`,
          layerVisible ? <EyeIcon width={14} height={14} /> : <EyeCloseIcon width={14} height={14} />,
          layerVisible,
          () => emit('layer'),
        )}
        {/* D5: the zen entry — every host action has a button (upstream
            discipline): discoverable, mouse-reachable, and the E2E door for
            the toggle (synthetic chords are isTrusted-refused by design). */}
        <button
          key="zen"
          title="Maximized review (⌥Z) — hide all UI, the capture fills the viewport"
          aria-label="Maximized review"
          style={{
            background: 'transparent',
            border: 'none',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
            cursor: 'pointer',
            color: theme.barTextColor,
          }}
          onClick={props.onZen}
        >
          <span style={{ fontSize: 14, lineHeight: '14px' }} aria-hidden>
            ⛶
          </span>
        </button>
      </div>
    </div>
  );
}
