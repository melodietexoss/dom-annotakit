/**
 * dom-annotakit — host theme (COPY-MAP manager row: `useTheme` → literal
 * theme object; D9 dark mode).
 *
 * Upstream consumed SB's themed manager fields; the panel already resolves
 * BOTH historical shapes (`theme.colorPositive` top-level AND the nested
 * `theme.color.positive`) with hardcoded fallbacks (#66BF3C / #FF4400). This
 * module provides EVERY field the panel + toolbar actually read.
 *
 * D9 (2026-10-23): the literal became a LIVE palette owner — LIGHT (the SB
 * default palette as shipped) + DARK (GitHub-dark-adjacent neutrals, SAME
 * accent #1EA7FD). Swap = Object.assign onto the SAME exported object: every
 * component reads theme.* inline at render, so an App re-render on mode
 * change re-renders the tree with fresh colors (verified: no React.memo, no
 * module-level theme captures outside App.tsx's former barStyle — now a
 * function). BOTH `color` shapes swap together (fold P3-2 — the panel's
 * dual-shape resolver must never fall back to the hardcoded values).
 *
 * The CAPTURE IFRAME is never themed (zero-interference rule) — only host
 * chrome. `viewportBackdrop` is the area AROUND the iframe; badge/hint colors
 * that read fine on both palettes stay hardcoded (P3-2).
 *
 * Persistence: localStorage `dom-annotakit:theme` ('light'|'dark'); boot =
 * stored value else prefers-color-scheme.
 */

import { useEffect, useState } from 'react';

export interface HostTheme {
  fontBase: string;
  fontMonospace: string;
  textColor: string;
  textMutedColor: string;
  appBorderColor: string;
  inputBorder: string;
  inputBackground: string;
  colorSecondary: string;
  background: string;
  backgroundBar: string;
  barSelectedColor: string;
  barTextColor: string;
  barContentText: string;
  /** D9: the area AROUND the capture iframe (App.tsx backdrop). */
  viewportBackdrop: string;
  /** D9: destructive/danger text (away/failed notices). */
  danger: string;
  /** D9: danger wash background. */
  dangerSoft: string;
  /** Historical top-level shape (v0.6.1 SB runtime). */
  colorPositive?: string;
  colorNegative?: string;
  /** Nested current shape (v0.6.4+ SB runtime). */
  color?: { positive?: string; negative?: string };
}

export type HostThemeMode = 'light' | 'dark';

const FONT_BASE = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

const LIGHT: HostTheme = {
  fontBase: FONT_BASE,
  fontMonospace: FONT_MONO,
  textColor: '#333333',
  textMutedColor: '#738694',
  appBorderColor: 'rgba(0,0,0,0.1)',
  inputBorder: 'rgba(0,0,0,0.2)',
  inputBackground: 'transparent',
  colorSecondary: '#1EA7FD',
  background: '#ffffff',
  backgroundBar: '#f6f9fc',
  barSelectedColor: '#1EA7FD',
  barTextColor: '#738694',
  barContentText: '#333333',
  viewportBackdrop: '#e9eef2',
  danger: '#FF4400',
  dangerSoft: '#FF440018',
  colorPositive: '#66BF3C',
  colorNegative: '#FF4400',
  color: { positive: '#66BF3C', negative: '#FF4400' },
};

const DARK: HostTheme = {
  fontBase: FONT_BASE,
  fontMonospace: FONT_MONO,
  textColor: '#e6edf3',
  textMutedColor: '#8b949e',
  appBorderColor: 'rgba(240,246,252,0.125)',
  inputBorder: 'rgba(240,246,252,0.25)',
  inputBackground: 'transparent',
  colorSecondary: '#1EA7FD',
  background: '#0d1117',
  backgroundBar: '#161b22',
  barSelectedColor: '#388bfd',
  barTextColor: '#8b949e',
  barContentText: '#e6edf3',
  viewportBackdrop: '#090c10',
  danger: '#f85149',
  dangerSoft: '#f8514922',
  colorPositive: '#3fb950',
  colorNegative: '#f85149',
  color: { positive: '#3fb950', negative: '#f85149' },
};

export const theme: HostTheme = { ...LIGHT, color: { ...LIGHT.color! } };

const THEME_KEY = 'dom-annotakit:theme';

function paletteFor(mode: HostThemeMode): HostTheme {
  return mode === 'dark' ? DARK : LIGHT;
}

export function setHostThemeMode(mode: HostThemeMode): void {
  const p = paletteFor(mode);
  Object.assign(theme, p);
  theme.color = { ...p.color! }; // fresh nested object — no shared references
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage unavailable — the mode lives for this page's lifetime only */
  }
}

export function getHostThemeMode(): HostThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/* MODULE-INIT swap: the palette must be correct BEFORE the first render —
 * components read theme.* inline at render time, and a render that precedes
 * the first setHostThemeMode would paint light values that stay until some
 * later re-render (the toggle landed in storage but never on the DOM — live
 * E2E find #4). Safe at module scope: getHostThemeMode's localStorage/matchMedia
 * reads are guarded; the browser bundle only ever loads with a DOM. */
setHostThemeMode(getHostThemeMode());

/** The App-root hook: owns the mode state; every mode change re-renders the
 *  whole shell so inline theme.* reads pick up the swapped palette. The swap
 *  runs SYNCHRONOUSLY before the state flip — the re-render then reads the
 *  NEW palette (a post-commit effect swap would leave the just-rendered DOM
 *  one palette behind). */
export function useHostTheme(): { mode: HostThemeMode; setMode: (m: HostThemeMode) => void; toggle: () => void } {
  const [mode, setModeState] = useState<HostThemeMode>(getHostThemeMode());
  useEffect(() => {
    setHostThemeMode(mode); // idempotent re-apply (covers the mount-time persistence)
  }, [mode]);
  return {
    mode,
    setMode: (m) => {
      setHostThemeMode(m);
      setModeState(m);
    },
    /* derive the next mode from REACT STATE (review P3-8): a failed
     * localStorage write must not wedge the toggle (getHostThemeMode reads
     * storage; if setItem silently failed, a storage-derived toggle would
     * compute next===current and no-op the DOM forever). */
    toggle: () => {
      setModeState((m) => {
        const next = m === 'dark' ? 'light' : 'dark';
        setHostThemeMode(next);
        return next;
      });
    },
  };
}
