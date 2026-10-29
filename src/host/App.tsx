/**
 * dom-annotakit — host app root (design D2a "host shell").
 *
 * Layout: left sidebar (capture browser) | main (toolbar over the capture
 * iframe) | bottom drawer (the ported ReviewPanel).
 *
 * THE SCROLLING CONTRACT (load-bearing, design D2a): html/body overflow
 * hidden — the HOST PAGE NEVER SCROLLS; the iframe fills the main area
 * (`width:100%; height:100%`) and the CAPTURE SCROLLS INSIDE the IFRAME.
 * Pins are position:fixed against the iframe's viewport — the exact
 * SB-preview shape the layer was hardened in. The drawer shrinks the main
 * area (a flex row, not an overlay) so the iframe resize re-anchors pins.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureHref, injectLayer, type CaptureEntry } from './inject';
import { startThreadsPoll } from './channel';
import { Sidebar } from './Sidebar';
import { Toolbar } from './Toolbar';
import { PanelDrawer } from './PanelDrawer';
import { ImportBar, type ImportState } from './ImportBar';
import { theme, useHostTheme } from './theme';
import { captureName } from './capture-id';
import { parseSingleFileNotes, setSingleFileNoteCardsVisible } from '../singlefile/parse';
import { probeMode } from '../shared/mode';
import { hasStrippedFlag, hasAnchorV2Flag, importSingleFileNotes, migrateLegacySingleFileAnchors } from './import';
import { onPendingSpecBump, readPendingSpecValues, rememberPendingSpecValue, useSpecCatalog } from './specBox';
import { filterCaptureCounts, filterCaptureIds, nextSelection, storiesForEpic } from '../shared/specCatalog';
import { hotkeyMatches, isTypingTarget, parseHotkey } from '../shared/hotkeys';

export interface Manifest {
  generatedAt: string;
  captures: CaptureEntry[];
}

/** D9: barStyle became a FUNCTION — the old module-level object captured
 *  theme.appBorderColor ONCE at import, so a dark-mode swap never reached
 *  it (the one module-level theme capture in the shell — audit item F). */
const barStyle = (): React.CSSProperties => ({
  padding: '8px 12px',
  fontSize: 12,
  borderBottom: `1px solid ${theme.appBorderColor}`,
});

/** D5: the zen chord — 'alt+z'. HOST-managed (the zen toggle is a host
 * concept, not a layer command); the vendored kernel only MATCHES it.
 * Collision-free: outside our defaults (pin/region/layer/panel/freeze/help)
 * and outside SB 9/10's documented alt-set (hotkeys.ts header). Fixed, not
 * configurable — one binding, matched identically on both documents. */
const ZEN_HOTKEY = 'alt+z';

/** D13: the persisted per-capture SF-card visibility overrides
 *  (`{captureId: boolean}`). Absent = the flag-driven default (post-import
 *  HIDDEN). Kept at module scope — read once into a ref. */
const SF_VISIBLE_KEY = 'dom-annotakit:sf-visible';
function readSfVisibleOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SF_VISIBLE_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(v)) if (typeof val === 'boolean') out[k] = val;
    return out;
  } catch {
    return {};
  }
}

export function App(): React.ReactElement {
  /* D9: the theme hook at the ROOT — every mode flip re-renders the whole
   * shell, so inline theme.* reads pick up the swapped palette (useHostTheme
   * applies + persists). */
  const hostTheme = useHostTheme();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [away, setAway] = useState(false);
  const [injectFailed, setInjectFailed] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [drawerHeight, setDrawerHeight] = useState(300);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  /* D5 zen (maximized zero-chrome review): ⌥Z toggles. Sidebar/Toolbar/
   * ImportBar hide; the drawer force-closes on entry (pre-zen open state
   * remembered, restored on exit); ?zen=1 is the URL persistence (reload
   * keeps zen; ⌥Z strips the param on exit). zenRef mirrors state so the
   * stable callbacks below read fresh values without dep churn. */
  const [zen, setZen] = useState<boolean>(() => {
    try {
      return new URLSearchParams(location.search).get('zen') === '1';
    } catch {
      return false;
    }
  });
  const zenRef = useRef(zen);
  zenRef.current = zen;
  const panelBeforeZenRef = useRef(true);
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const [zenHint, setZenHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* M4: SingleFile note-import state (the ImportBar below the toolbar). The
   * scan runs on every successful injection (capture switch + reload); the
   * flag-driven hide happens earlier, at load, inside injectLayer. */
  const [importState, setImportState] = useState<ImportState>({ kind: 'hidden' });

  /* ---- D10/D11: the spec selection (Epic/Story) — ONE state for BOTH the
   *  compose context (server-injected @epic:/@story: lines on new comments)
   *  and the two-level filter (sidebar captures + panel threads). The catalog
   *  + context echo arrive from the spec endpoint (useSpecCatalog); the
   *  reducer transitions live in shared/specCatalog (pure, unit-tested). */
  const spec = useSpecCatalog();
  const [epicOpenSignal, setEpicOpenSignal] = useState(0);
  const [storyOpenSignal, setStoryOpenSignal] = useState(0);
  const [specAnnounce, setSpecAnnounce] = useState<string | null>(null);
  const onSpecSelect = useCallback(
    (kind: 'epic' | 'story', value: string | null) => {
      const next = nextSelection(spec.selection, { [kind]: value }, spec.catalog);
      spec.setSelection(next);
      if (value && value.trim()) {
        const pool = kind === 'epic' ? spec.catalog?.epics ?? [] : storiesForEpic(spec.catalog, spec.selection.epic ?? null).map((s) => s.name);
        const known = pool.some((v) => v.toLocaleLowerCase() === value.trim().toLocaleLowerCase());
        if (!known) rememberPendingSpecValue(kind, value.trim());
      }
      /* §9 P3: announce the surprise transitions — a story cleared by an
       * epic switch must never happen silently. */
      const cleared = Boolean(spec.selection.story) && next.story == null && kind === 'epic';
      setSpecAnnounce(
        cleared
          ? `Story "${spec.selection.story}" is not filed under "${next.epic}" — story filter cleared.`
          : next.epic || next.story
            ? `Filter + filing context: ${[next.epic, next.story].filter(Boolean).join(' · ')} — new comments file under it.`
            : 'Filter cleared — showing all captures; new comments carry no epic/story.',
      );
      window.setTimeout(() => setSpecAnnounce(null), 3500);
    },
    [spec],
  );
  const filterIds = useMemo(
    () => filterCaptureIds(spec.catalog, { epic: spec.selection.epic ?? null, story: spec.selection.story ?? null }),
    [spec.catalog, spec.selection.epic, spec.selection.story],
  );
  /* s6: pair-exact per-capture match counts — the sidebar's filter chips. */
  const filterCounts = useMemo(
    () => filterCaptureCounts(spec.catalog, { epic: spec.selection.epic ?? null, story: spec.selection.story ?? null }),
    [spec.catalog, spec.selection.epic, spec.selection.story],
  );
  /* audit round-1 P2: the banner's "clear" passes BOTH keys — the reducer
   * keeps the story on an epic-only null patch (right for the epic chip's
   * own ×), so a one-key patch left the filter half-on. */
  const clearSpecFilter = useCallback((): void => {
    spec.setSelection({ epic: null, story: null });
    setSpecAnnounce('Filter cleared — showing all captures; new comments carry no epic/story.');
    window.setTimeout(() => setSpecAnnounce(null), 3500);
  }, [spec]);
  const filterActive = Boolean(spec.selection.epic || spec.selection.story);
  /* audit round-1 P3: the pending-values join recomputes on the bump signal
   * (a fresh "Create X" lands in its OWN option list immediately) — the
   * localStorage read stays out of the render path via an effect-fed state. */
  const [pendingSpecValues, setPendingSpecValues] = useState(readPendingSpecValues);
  useEffect(() => {
    const sync = (): void => setPendingSpecValues(readPendingSpecValues());
    sync();
    return onPendingSpecBump(sync);
  }, []);
  useEffect(() => {
    if (!spec.catalog) return;
    const stale = readPendingSpecValues();
    const next = { ...stale };
    if (stale.epic && spec.catalog.epics.some((e) => e.toLocaleLowerCase() === stale.epic!.toLocaleLowerCase())) delete next.epic;
    if (stale.story && spec.catalog.stories.some((s) => s.name.toLocaleLowerCase() === stale.story!.toLocaleLowerCase())) delete next.story;
    if (next.epic !== stale.epic || next.story !== stale.story) {
      setPendingSpecValues(next);
    }
  }, [spec.catalog]);
  const epicOptions = useMemo(() => {
    const board = spec.catalog?.epics ?? [];
    const pending = pendingSpecValues.epic;
    return pending && !board.some((e) => e.toLocaleLowerCase() === pending.toLocaleLowerCase()) ? [pending, ...board] : board;
  }, [spec.catalog, pendingSpecValues]);
  const storyOptions = useMemo(
    () => storiesForEpic(spec.catalog, spec.selection.epic ?? null).map((s) => s.name),
    [spec.catalog, spec.selection.epic],
  );

  /* ---- D13: SingleFile card VISIBILITY per capture — the user override
   *  (persisted) wins over the post-import hidden default; toggling flips
   *  the injected style live (elements never leave the tree). */
  const [sfNotes, setSfNotes] = useState<{ count: number; visible: boolean } | null>(null);
  const sfVisibleOverrides = useRef<Record<string, boolean>>(readSfVisibleOverrides());
  const persistSfVisibleOverride = (captureId: string, visible: boolean): void => {
    sfVisibleOverrides.current[captureId] = visible;
    try {
      localStorage.setItem(SF_VISIBLE_KEY, JSON.stringify(sfVisibleOverrides.current));
    } catch {
      /* ignore */
    }
  };
  const effectiveSfVisible = useCallback(
    (cap: CaptureEntry | null): boolean => {
      if (!cap) return true;
      const override = sfVisibleOverrides.current[cap.id];
      if (typeof override === 'boolean') return override;
      return !hasStrippedFlag(cap.id); // default: post-import HIDDEN (the ask)
    },
    [],
  );
  const toggleSfNotes = useCallback(() => {
    const iframe = iframeRef.current;
    const cap = captureRef.current;
    if (!iframe?.contentDocument || !cap) return;
    const next = !effectiveSfVisible(cap);
    persistSfVisibleOverride(cap.id, next);
    setSingleFileNoteCardsVisible(iframe.contentDocument, next);
    setSfNotes((s) => (s ? { ...s, visible: next } : s));
  }, [effectiveSfVisible]);

  /* ---- D12: capture upload state + handlers. (D15: DELETE is gone — the
   *  user directive; removal is a git/CLI concern, never a UI click. The
   *  B-1 stale-selection heal below stays: captures can still vanish from
   *  the manifest via git-side operations.) */
  const [captureOps, setCaptureOps] = useState<{ busy: boolean; message: string | null; error: string | null }>({ busy: false, message: null, error: null });
  /* audit round-1 P3-2: the manage affordances need the standalone server —
   * static builds (baked) have no /dom-annotakit-captures behind them. */
  const [manageEnabled, setManageEnabled] = useState(true);
  useEffect(() => {
    let alive = true;
    void probeMode()
      .then((m) => {
        if (alive) setManageEnabled(m !== 'static');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /* manifest — served by the standalone server (GET /dom-annotakit-manifest.json)
   * or baked next to a static build; same JSON shape (M5 contract). D12:
   * POLLED every 20s (uploads/deletes/renames land from outside too — the
   * file manager IS a supported workflow), plus explicit refreshes after
   * in-app upload/delete. */
  const refreshManifest = useCallback((): void => {
    fetch(new URL('dom-annotakit-manifest.json', document.baseURI).href, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((m: Manifest) => setManifest(m))
      .catch((e: unknown) => setManifestError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      fetch(new URL('dom-annotakit-manifest.json', document.baseURI).href, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((m: Manifest) => {
          if (alive) setManifest(m);
        })
        .catch((e: unknown) => {
          if (alive) setManifestError(e instanceof Error ? e.message : String(e));
        });
    };
    poll();
    const timer = setInterval(poll, 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  /* ?capture= deep link — story.url points here (snapshot-meta.ts). */
  useEffect(() => {
    try {
      const id = new URLSearchParams(location.search).get('capture');
      if (id) setCaptureId(id);
    } catch {
      /* ignore */
    }
  }, []);

  /* D5: zen enter/exit — ONE function, both directions. Entry: remember the
   * drawer's open state, force-close it (one-shot at entry, NOT a derived
   * open={zen ? false : panelOpen} — a derived prop would silently eat the
   * in-zen ⌥P reopen), show the transient exit hint. Exit: restore the
   * remembered state. The ?zen param rides history.replaceState — the same
   * discipline as ?capture=, which PRESERVES it across capture switches. */
  const setZenMode = useCallback(
    (on: boolean) => {
      if (on) {
        panelBeforeZenRef.current = panelOpenRef.current;
        setPanelOpen(false);
        setZenHint(true);
        if (hintTimer.current) clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setZenHint(false), 2600);
      } else {
        setPanelOpen(panelBeforeZenRef.current);
        setZenHint(false);
        if (hintTimer.current) {
          clearTimeout(hintTimer.current);
          hintTimer.current = null;
        }
      }
      setZen(on);
      try {
        const u = new URL(location.href);
        if (on) u.searchParams.set('zen', '1');
        else u.searchParams.delete('zen');
        history.replaceState(null, '', u);
      } catch {
        /* ignore */
      }
    },
    [],
  );
  const toggleZen = useCallback(() => {
    setZenMode(!zenRef.current);
  }, [setZenMode]);

  /* boot into zen when the URL says so (reload persistence): the initial
   * state already reads the param; running the ENTER path once closes the
   * drawer + arms the hint exactly like an interactive entry. */
  useEffect(() => {
    if (zenRef.current) setZenMode(true);
  }, [setZenMode]);

  /* host-document ⌥Z + ⌥E/⌥S — keydowns with focus INSIDE the capture never
   * reach this document (inject.ts forwards those from the capture document;
   * two documents, never a double-fire). Audit round-1 P2: the spec chords
   * were bound ONLY on the capture side — dead whenever focus sat on the
   * host shell (the common sidebar/panel case). */
  useEffect(() => {
    const zenSpec = parseHotkey(ZEN_HOTKEY, ZEN_HOTKEY);
    const epicSpec = parseHotkey('alt+e', 'alt+e');
    const storySpec = parseHotkey('alt+s', 'alt+s');
    const onKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return; // synthetic dispatches stay single-source
      if (isTypingTarget(e.target)) return;
      if (e.repeat) return;
      if (hotkeyMatches(e, zenSpec)) toggleZen();
      else if (hotkeyMatches(e, epicSpec)) setEpicOpenSignal((v) => v + 1);
      else if (hotkeyMatches(e, storySpec)) setStoryOpenSignal((v) => v + 1);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [toggleZen]);

  useEffect(
    () => () => {
      if (hintTimer.current) clearTimeout(hintTimer.current);
    },
    [],
  );

  const captures = useMemo(() => manifest?.captures ?? [], [manifest]);
  const capture = useMemo(() => captures.find((c) => c.id === captureId) ?? null, [captures, captureId]);

  /* auto-select the first capture once the manifest lands — AND heal a
   * selection that left the manifest (audit round-2 B-1: deleting the
   * currently-OPEN capture left a stale id whose lookup returned null and
   * the pane rendered "Loading captures…" forever). The heal picks the
   * first remaining capture; the deep-link ?capture= case is covered too
   * (an id that later returns restores the selection on its own row click). */
  useEffect(() => {
    if (captures.length === 0) return;
    if (captureId == null) {
      setCaptureId(captures[0].id);
      return;
    }
    if (!captures.some((c) => c.id === captureId)) setCaptureId(captures[0].id);
  }, [captureId, captures]);

  const selectCapture = useCallback((id: string) => {
    setCaptureId(id);
    setAway(false);
    setImportState({ kind: 'hidden' }); // fresh offer scan for the new capture
    setSfNotes(null); // audit round-1 P3: never show the PREVIOUS capture's SF state
    try {
      const u = new URL(location.href);
      u.searchParams.set('capture', id);
      history.replaceState(null, '', u);
    } catch {
      /* ignore */
    }
  }, []);

  /** Cross-capture focus/recall from the panel: switch when the manifest
   *  knows the id; unknown ids (renamed/removed capture) are a no-op — the
   *  thread stays listed, the view stays honest. */
  const selectCaptureIfKnown = useCallback(
    (id: string) => {
      if (captures.some((c) => c.id === id)) selectCapture(id);
    },
    [captures, selectCapture],
  );

  /* server-mode live updates: 5s poll → THREADS_CHANGED (static mode stays
   * storage-event driven — the poll self-disables via the mode probe). */
  useEffect(() => startThreadsPoll(), []);

  /** D5: iframe-side ⌥Z → the host's zen toggle (focus usually lives INSIDE
   *  the capture; its keydowns never reach the host document). Declared
   *  BEFORE the injection effect that consumes it. */
  const onHostKey = useCallback(
    (key: 'zen' | 'specEpic' | 'specStory') => {
      if (key === 'zen') toggleZen();
      else if (key === 'specEpic') setEpicOpenSignal((v) => v + 1);
      else if (key === 'specStory') setStoryOpenSignal((v) => v + 1);
    },
    [toggleZen],
  );

  /* Layer injection — keyed by capture ID only: the cleanup clears the
   * channel-pair's layer side, which must happen exactly when the DOCUMENT
   * goes away, never on an unrelated re-render. */
  const captureRef = useRef<CaptureEntry | null>(capture);
  captureRef.current = capture;
  const currentCaptureId = capture?.id ?? null;

  /* M4/D13: after the layer boots, scan the capture DOM for embedded SingleFile
   * notes (LIVE parse — the manifest note count is an M5 field and can lag a
   * re-saved file). The bar offers only when importable notes exist AND the
   * imported flag is absent (flag set → cards were HIDDEN at load, the
   * notes are already threads — re-offering would only invite no-op clicks). */
  const scanForNotes = useCallback((cap: CaptureEntry) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    let importable = 0;
    let total = 0;
    try {
      for (const n of parseSingleFileNotes(doc)) {
        total++;
        if (n.text) importable++;
      }
    } catch {
      return; // a hostile DOM must never brick the host shell
    }
    setImportState(importable > 0 && !hasStrippedFlag(cap.id) ? { kind: 'offer', count: importable } : { kind: 'hidden' });
    /* D13: the toolbar SF toggle shows whenever the capture carries notes;
     * `visible` follows the effective per-capture state (override > default). */
    const override = sfVisibleOverrides.current[cap.id];
    const visible = typeof override === 'boolean' ? override : !hasStrippedFlag(cap.id);
    setSfNotes(total > 0 ? { count: total, visible } : null);
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    const cap = captureRef.current;
    if (!iframe || !cap || cap.id !== currentCaptureId) return;
    const visible = effectiveSfVisible(cap);
    return injectLayer(iframe, cap, {
      /* D13: hide (never strip) post-import cards at load; the user's
       * persisted visible-override re-shows them immediately. */
      hideNoteCards: hasStrippedFlag(cap.id) && !visible,
      noteCardsVisibleOverride: visible,
      onHostKey,
      onStatus: (s) => {
        setAway(s.away);
        if (s.injected !== undefined) {
          setInjectFailed(!s.injected);
          if (s.injected) {
            scanForNotes(cap); // the anchor-capture handle is up — safe to offer the import
            /* D13 §9 P1-A: the one-time legacy anchor migration — old
             * strip-flow anchors are re-captured on THIS cards-present DOM
             * via the refs ground truth. No-ops when flagged / noteless.
             * (s6 static-E2E fold) the OLD hasStrippedFlag() gate tied the
             * heal to THIS browser's own import flow, so seed-carried legacy
             * anchors — a static bake from a pre-v2 store — never healed:
             * every fresh consumer loaded drifted anchors and nothing fired.
             * The migration is idempotent + one-time-flagged per browser, so
             * run it on the FIRST settled load of any capture: identical
             * anchors → skipped + flagged; drifted ones → healed through
             * the real patch door (store.patch in static, REST in dev). */
            if (!hasAnchorV2Flag(cap.id)) {
              void migrateLegacySingleFileAnchors(iframe, cap.id)
                .then((r) => {
                  if (r && r.migrated > 0) console.info(`[dom-annotakit] anchor-v2 migration: ${r.migrated} thread(s) re-captured on ${cap.id}`);
                })
                .catch(() => undefined); // honest degradation: retry next load
            }
          }
        }
      },
    });
  }, [currentCaptureId, scanForNotes, onHostKey]);

  /* M4/D13: the import click — parse → hide → capture → create, then the
   * summary notice replaces the bar (THREADS_CHANGED + the auto-strip flag
   * land inside importSingleFileNotes). An in-flight ref guards the
   * double-click/double-dispatch race (the busy bar replaces the button, but
   * two concurrent runs would race their parse/hide passes — the second
   * parse would find the cards already gone and its summary would overwrite
   * the honest one). */
  const importingRef = useRef(false);
  const runImport = useCallback(() => {
    const iframe = iframeRef.current;
    const cap = captureRef.current;
    if (!iframe || !cap) return;
    if (importingRef.current) return;
    importingRef.current = true;
    setImportState({ kind: 'busy' });
    void importSingleFileNotes(iframe, cap)
      .then((summary) => {
        setImportState({ kind: 'done', summary });
        /* audit round-1 P3-1: cards are hidden by the import itself — the
         * toolbar SF state must say so immediately (the first toggle click
         * post-import used to do the OPPOSITE of the icon). */
        setSfNotes(summary.notesTotal > 0 ? { count: summary.notesTotal, visible: false } : null);
      })
      .catch((e: unknown) => setImportState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
      .finally(() => {
        importingRef.current = false;
      });
  }, []);

  const reloadCapture = useCallback(() => {
    const iframe = iframeRef.current;
    const cap = captureRef.current;
    if (!iframe || !cap) return;
    setImportState({ kind: 'hidden' }); // re-offered after the fresh load's scan
    // assigning src re-navigates even to the same URL → `load` → re-inject
    iframe.src = captureHref(cap.relpath);
  }, []);

  /* ---- D12: upload (multi-file, JSON {name, content} per file; the server
   *  commits each capture to git — git-is-the-disk). Collisions ask
   *  before overwriting (SingleFile re-saves under the same name are the
   *  COMMON case, so the question is one honest confirm, never silent). */
  const uploadCaptures = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      setCaptureOps({ busy: true, message: `uploading ${files.length} file(s)…`, error: null });
      void (async () => {
        const uploaded: string[] = [];
        const problems: string[] = [];
        let replaceAll: boolean | null = null; // audit round-1 P3: re-saves are the COMMON case — ask once, not per file
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          setCaptureOps({ busy: true, message: `uploading ${i + 1}/${files.length}: ${f.name}…`, error: null });
          if (!/\.html?$/i.test(f.name)) {
            problems.push(`${f.name}: not an .html/.htm file`);
            continue;
          }
          try {
            const content = await f.text();
            const post = (overwrite: boolean): Promise<Response> =>
              fetch(new URL('dom-annotakit-captures', document.baseURI).href, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: f.name, content, overwrite }),
              });
            let r = await post(false);
            if (r.status === 409) {
              const pre = (await r.json().catch(() => ({}))) as { existing?: boolean; error?: string };
              if (pre.existing !== true) {
                /* audit round-2 B-5: the capture-ID-collision 409 can NEVER
                 * succeed with overwrite (it needs a RENAME) — surface it,
                 * never offer the futile "Replace?" question. */
                problems.push(`${f.name}: ${pre.error ?? 'capture id collision'}`);
                continue;
              }
              if (replaceAll === null) {
                const more = files.slice(i).filter((x) => /\.html?$/i.test(x.name)).length;
                replaceAll = window.confirm(`A capture named "${f.name}" already exists.\n\nReplace it${more > 1 ? ` and any other existing captures in this batch (${more - 1} more)` : ''}?`);
              }
              if (!replaceAll) {
                problems.push(`${f.name}: skipped (exists)`);
                continue;
              }
              r = await post(true);
            }
            const j = (await r.json().catch(() => ({}))) as { error?: string; durability?: string };
            if (!r.ok) problems.push(`${f.name}: ${j.error ?? `HTTP ${r.status}`}`);
            else uploaded.push(f.name);
          } catch (e) {
            problems.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        refreshManifest();
        setCaptureOps({
          busy: false,
          message: uploaded.length ? `uploaded ${uploaded.length} capture(s)` : null,
          error: problems.length ? problems.join('\n') : null,
        });
        window.setTimeout(() => setCaptureOps((s) => ({ ...s, message: null, error: null })), 6000);
      })();
    },
    [refreshManifest],
  );

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', fontFamily: theme.fontBase, color: theme.textColor, background: theme.background }}>
      {/* D5: zen hides ALL host chrome. The iframe subtree is NEVER
          restructured by zen — only preceding/following siblings unmount, so
          the capture never reloads mid-review (scroll + layer state hold). */}
      {!zen && (
        <Sidebar
          captures={captures}
          currentId={captureId}
          onSelect={selectCapture}
          loading={manifest == null && manifestError == null}
          error={manifestError}
          filterIds={filterActive ? filterIds : null}
          filterLabel={[spec.selection.epic, spec.selection.story].filter(Boolean).join(' · ') || null}
          filterCounts={filterActive ? filterCounts : null}
          onClearFilter={clearSpecFilter}
          onUpload={uploadCaptures}
          ops={captureOps}
          manageEnabled={manageEnabled}
        />
      )}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {!zen && (
          <Toolbar
            capture={capture}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((v) => !v)}
            onZen={toggleZen}
            onToggleTheme={hostTheme.toggle}
            darkMode={hostTheme.mode === 'dark'}
            specAvailable={spec.available}
            epicOptions={epicOptions}
            storyOptions={storyOptions}
            epicSelected={spec.selection.epic ?? null}
            storySelected={spec.selection.story ?? null}
            onSpecSelect={onSpecSelect}
            epicOpenSignal={epicOpenSignal}
            storyOpenSignal={storyOpenSignal}
            sfNotes={sfNotes}
            onToggleSfNotes={toggleSfNotes}
          />
        )}
        {/* M4: the SingleFile import offer/summary bar (hidden when the
            imported flag covered this capture, or while away/uninjected). */}
        {!zen && !away && !injectFailed && <ImportBar state={importState} onImport={runImport} />}
        {(away || injectFailed) && capture && (
          <div
            role="alert"
            style={{
              ...barStyle(),
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: theme.dangerSoft,
              color: theme.danger,
              borderBottom: `1px solid ${theme.appBorderColor}`,
            }}
          >
            <span style={{ flex: 1 }}>
              {away
                ? 'Away from the capture — the frame navigated to a different page, so the pin layer is not loaded. Reload the capture to re-arm review mode.'
                : 'The pin layer failed to load on this capture (a strict CSP the server could not strip, or a network error). Pins are unavailable until it loads — reload to retry.'}
            </span>
            <button
              style={{ padding: '3px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', borderRadius: 6, border: `1px solid ${theme.danger}`, background: 'transparent', color: theme.danger }}
              onClick={reloadCapture}
            >
              Reload capture
            </button>
          </div>
        )}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', background: theme.viewportBackdrop }}>
          {capture ? (
            <iframe
              ref={iframeRef}
              src={captureHref(capture.relpath)}
              title={`capture: ${captureName(capture.relpath)}`}
              style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
            />
          ) : manifestError ? (
            <div style={{ ...barStyle(), color: theme.danger }}>
              Capture manifest unavailable ({manifestError}) — start the standalone server
              (<code>npm run serve</code>); it serves <code>dom-annotakit-manifest.json</code> from
              the captures directory.
            </div>
          ) : manifest && captures.length === 0 ? (
            <div style={barStyle()}>
              No captures — put SingleFile <code>.html</code> files in the designated captures
              directory (the server's start directory by default; set <code>captures.dir</code> in
              <code>annotakit.config.json</code> or <code>DOM_AK_CAPTURES_DIR</code>), or upload with ↑.
            </div>
          ) : (
            <div style={barStyle()}>Loading captures…</div>
          )}
        </div>
        <PanelDrawer
          open={panelOpen}
          onOpenChange={setPanelOpen}
          height={drawerHeight}
          onHeightChange={setDrawerHeight}
          captureId={capture?.id}
          onSelectCapture={selectCaptureIfKnown}
          specFilter={{ epic: spec.selection.epic ?? null, story: spec.selection.story ?? null }}
          onSpecFilterClear={(kind) => onSpecSelect(kind, null)}
        />
      </div>
      {/* §9 P3: the spec-selection live region — announces filter changes
          AND the story-cleared-on-epic-switch surprise (polite politeness:
          role=status, pointer-transparent, auto-fades). */}
      {specAnnounce && !zen && (
        <div
          id="dom-annotakit-spec-announce"
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            top: 44,
            zIndex: 2147483646,
            pointerEvents: 'none',
            background: theme.backgroundBar,
            color: theme.textColor,
            border: `1px solid ${theme.appBorderColor}`,
            fontSize: 11.5,
            fontWeight: 600,
            padding: '5px 12px',
            borderRadius: 8,
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
            maxWidth: '70%',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {specAnnounce}
        </div>
      )}
      {/* D5: the transient zen hint — auto-fades, never intercepts pointer
          events, and lives in the HOST document (its own stacking context,
          so it can never collide with the capture's own layers). */}
      {zen && zenHint && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 2147483647,
            pointerEvents: 'none',
            background: 'rgba(20, 24, 30, 0.92)',
            color: '#e6edf3',
            fontSize: 12,
            fontWeight: 600,
            padding: '8px 12px',
            borderRadius: 8,
            boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
          }}
        >
          Maximized review — ⌥Z exits · pins live
        </div>
      )}
    </div>
  );
}
