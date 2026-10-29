/**
 * dom-annotakit — parent-side layer injection (COPY-MAP preview row: index.ts
 * REPLACE → this module; design D2a "same-origin iframe + layer injection").
 *
 * Runs in the HOST window. Given the capture iframe + its manifest entry, on
 * every iframe `load`:
 *
 *   (a) LOAD-GUARD — if `contentWindow.location` is not the capture URL, the
 *       user navigated away (a form POST slipped through, a _blank link
 *       replaced the frame, …): show the "away from capture" notice and SKIP
 *       injection (the layer must never mount against a foreign document).
 *       D15 (session 5): the away verdict is GATED — pre-navigation frames
 *       (about:blank at first paint, the PREVIOUS capture's document while a
 *       switch is committing) used to flash the red notice on EVERY load;
 *       they are "not there yet", not "away". A verdict is only honest once
 *       the expected document was seen (sawExpected) OR the frame sits on
 *       genuinely FOREIGN territory (not about:blank, not under our own
 *       /captures/ root).
 *   (b) INJECT THE GLOBALS (same-origin object references, set BEFORE the
 *       module script so the layer reads them at import time):
 *         __DOM_AK_CHANNEL__        a fresh channel-pair side (channel.ts)
 *         __DOM_AK_SNAPSHOT_META__  { storyId, name, url }  (snapshot-meta.ts)
 *         __DOM_AK_OPTIONS__        { freezeEnabled } — false when the capture
 *                                   exceeds the 20MB clone threshold (the
 *                                   freeze gate, layer.tsx EDIT (vi))
 *         __DOM_AK_APP_BASE__      the HOST page's baseURI — mode.ts's FIRST
 *                                   health candidate (subpath deployments)
 *   (c) APPEND THE LAYER SCRIPT — `<script type="module">` with the src minted
 *       from the HOST baseURI (`new URL('layer.mjs', hostBase)`), never a
 *       hard-coded absolute path (a subpath deployment would 404 it).
 *   (d) NAVIGATION GUARD — capture-phase click/submit interceptor on the
 *       contentDocument: preventDefault on unmodified link clicks + form
 *       submits (a live href in a capture would destroy the session);
 *       modifier clicks + target=_blank stay honest (new tab, no session
 *       loss). The listeners die with their document — every load re-arms a
 *       fresh guard, which is also how re-injection after a reload works.
 *
 *   (e) NOTE-CARD HIDE (M4/D2c → D13, §9 P1-A — opts.hideNoteCards): when
 *       the imported flag `dom-annotakit:stripped:<captureId>` is set (the
 *       capture was imported in an earlier session), the SingleFile note
 *       CARDS are hidden AT LOAD via one injected <style> — the ELEMENTS
 *       STAY in the tree (the D13 display invariant: `:nth-child` counts
 *       tree position, so hidden cards keep every captured anchor
 *       consistent; the old strip-at-load made cards-present sessions
 *       resolve stripped-DOM anchors against shifted siblings). The user's
 *       per-capture visibility override (App) flips the same style live;
 *       the capture FILE is never touched. No hide when the flag is
 *       absent: the import bar offers the import instead (cards visible,
 *       the user may decline).
 *
 *   (f) HOST-KEY FORWARDER (D5; D10 adds ⌥E/⌥S): keydowns on the capture
 *       document never reach the HOST document — and focus usually lives
 *       inside the capture. A host-context listener (same lifecycle as the
 *       nav guard: dies with the document, re-armed every load) recognizes
 *       the zen chord (⌥Z → onHostKey('zen')) and the spec chords (⌥E →
 *       onHostKey('specEpic'), ⌥S → onHostKey('specStory') — the Epic/Story
 *       comboboxes' keyboard activation, D10).
 */

import { clearLayerChannel, createLayerChannel } from './channel';
import { getSnapshotMeta } from './snapshot-meta';
import { hideSingleFileNoteCards, setSingleFileNoteCardsVisible } from '../singlefile/parse';
import { hotkeyMatches, parseHotkey } from '../shared/hotkeys';

/** One manifest capture entry (server manifest route or static bake; M5 shape). */
export interface CaptureEntry {
  id: string;
  relpath: string;
  title?: string;
  /** The SingleFile provenance URL (`Page saved with SingleFile / url: …`). */
  url?: string;
  savedDate?: string;
  size: number;
}

export interface InjectStatus {
  /** true when a `load` fired for a document that is NOT our capture. */
  away: boolean;
  /** false when the layer module never booted in the iframe (a strict CSP
   *  the server could not strip, a network error, a build gap) — the host
   *  surfaces the notice; pinning is unavailable for this capture. */
  injected?: boolean;
}

export interface InjectOptions {
  /** Override the freeze-size decision (default: size <= 20MB). */
  freezeEnabled?: boolean;
  /** D13: hide the SingleFile note CARDS at load (style-injected; elements
   *  stay in the tree). Set when the imported flag covers this capture AND
   *  the user's per-capture visibility override doesn't force them visible. */
  hideNoteCards?: boolean;
  /** D13: the user's persisted visibility override for this capture — when
   *  `true`, a hidden-by-flag capture gets its cards RE-SHOWN right after the
   *  hide step (the override wins over the post-import default). */
  noteCardsVisibleOverride?: boolean;
  /** D5/D10: host-chord callbacks — keydowns inside the capture document
   *      never reach the host document. 'zen' (⌥Z), 'specEpic' (⌥E),
   *      'specStory' (⌥S). The forwarder's typing guard is REALM-AWARE
   *      (duck-typed: the shared instanceof-based guard is a cross-realm
   *      no-op here). */
  onHostKey?: (key: 'zen' | 'specEpic' | 'specStory') => void;
  onStatus?: (status: InjectStatus) => void;
}

/** The captures-root-relative URL of a capture, per-path-segment encoded. */
export function captureHref(relpath: string, hostBase = document.baseURI): string {
  const encoded = relpath.split('/').map(encodeURIComponent).join('/');
  return new URL(`captures/${encoded}`, hostBase).href;
}

/** Design D2a: the freeze threshold — freeze deep-clones the whole captured
 *  DOM; above this the host + layer both refuse. */
const FREEZE_MAX_BYTES = 20 * 1024 * 1024;

/** D5: the zen chord spec — the HOST owns the zen binding (it toggles host
 * chrome, not a layer command); the vendored kernel only MATCHES it.
 * 'alt+z' is collision-free (see App.tsx). Fixed here + in App as the SAME
 * literal so both documents match identically (two bindings, never a
 * double-fire: each document has exactly one listener). */
const ZEN_SPEC = parseHotkey('alt+z', 'alt+z');
/** D10: the spec-chord specs — ⌥E opens Epic, ⌥S opens Story. Both are
 *  OUTSIDE the engine's documented alt-set (hotkeys.ts: pin ⌥C, region ⌥B,
 *  layer ⌥L, drawer ⌥P, freeze ⌥I — audited collision-free). */
const SPEC_EPIC_SPEC = parseHotkey('alt+e', 'alt+e');
const SPEC_STORY_SPEC = parseHotkey('alt+s', 'alt+s');

export function injectLayer(iframe: HTMLIFrameElement, capture: CaptureEntry, opts?: InjectOptions): () => void {
  const hostBase = document.baseURI;
  const expectedHref = captureHref(capture.relpath, hostBase);
  /* D15: our own serving territory — a frame parked here is a pre-navigation
   * or sibling-capture state, never a foreign hijack. */
  const capturesRoot = new URL('captures/', hostBase).href;
  /* D15: has THIS injection instance ever seen the expected document? Only
   * then can a later foreign document mean "the user navigated away". */
  let sawExpected = false;

  /* D15-1 (audit 5-a): the silent pre-navigation window is BOUNDED — a
   * self-redirecting capture (meta-refresh / early location.replace to a
   * RELATIVE url, still under /captures/) never fires its own load, so the
   * gate would stay silent forever with no layer and no notice. If the
   * expected document never arrives within the watchdog window while the
   * frame sits on a COMMITTED non-blank foreign page, report the honest
   * away (the reload/switch affordances are the escape). */
  let awayWatchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    awayWatchdog = null;
    if (sawExpected) return;
    let href = '';
    try {
      href = iframe.contentWindow?.location.href ?? '';
    } catch {
      href = '';
    }
    if (href && href !== 'about:blank' && href.split('#')[0] !== expectedHref.split('#')[0]) {
      opts?.onStatus?.({ away: true });
    }
  }, 7_000);

  /* Injection-failure probes pending from a PREVIOUS load of this iframe — a
   * capture switch / reload replaces the document (and its window) mid-probe;
   * a stale probe would read the OLD window and report a verdict for the
   * WRONG capture. Cleared at the top of every load + by the disposer. */
  let loadTimers: ReturnType<typeof setTimeout>[] = [];

  let lastRunAt = 0;
  const onLoad = (): void => {
    /* cached-load race (live E2E find #5): an HTTP-cached capture can fire
     * `load` BEFORE this effect attaches its listener — injection never ran
     * (no channel, no layer script) until a REAL reload landed. The attach
     * path below therefore calls onLoad DIRECTLY when the document is past
     * parsing. Per-document identity guard: a capture whose `load` NEVER
     * fires (stuck at `interactive` — SingleFile inlines resources that can
     * hang the browser's load bookkeeping forever) is injected at interactive
     * — DOM parsed = safe — and the eventual `load` must NOT re-inject (a
     * second channel would orphan the live layer + a second script tag would
     * double the pins). Real reloads get a NEW document object → identity
     * resets → re-injects. (live E2E find #6) */
    const now = Date.now();
    if (now - lastRunAt < 500) return;
    lastRunAt = now;
    /* (a) load-guard — same-origin read; a failed read counts as away. */
    let href = '';
    try {
      href = iframe.contentWindow?.location.href ?? '';
    } catch {
      href = '';
    }
    const sameDoc = href.split('#')[0] === expectedHref.split('#')[0];
    if (!sameDoc) {
      /* D15 away-gate: about:blank (boot) and the previous capture (mid-switch)
      * read as foreign to THIS injection instance — reporting them flashed the
      * away notice on every load. Silent for our own territory until the
      * expected document has been seen; a genuinely foreign URL is always an
      * honest away. */
      const ownTerritory = href === 'about:blank' || (href.startsWith(capturesRoot) && !sawExpected);
      if (sawExpected || !ownTerritory) {
        /* D15-3 (audit 5-a): kill the pending injection probes too — a stale
         * 5s probe would later overwrite this honest away verdict with a
         * misleading {away:false, injected:false} CSP-failure report. */
        loadTimers.forEach(clearTimeout);
        loadTimers = [];
        clearLayerChannel(); // the old layer's listeners died with its document
        opts?.onStatus?.({ away: true });
      }
      return;
    }
    sawExpected = true;
    if (awayWatchdog) {
      clearTimeout(awayWatchdog);
      awayWatchdog = null;
    }
    opts?.onStatus?.({ away: false });

    const win = iframe.contentWindow as (Window & Record<string, unknown>) | null;
    const doc = iframe.contentDocument;
    if (!win || !doc) return; // frame detached mid-load — nothing to inject
    /* per-document identity: exactly one injection per document object */
    if (win.__domAnnotakitInjectedDoc === doc) return;
    win.__domAnnotakitInjectedDoc = doc;

    /* (e) note-card DISPLAY at load — style-injected hide (D13): elements
     *     stay in the tree; the user override re-shows them immediately. */
    if (opts?.hideNoteCards) {
      const hidden = hideSingleFileNoteCards(doc);
      if (hidden > 0) console.info(`[dom-annotakit] hidden ${hidden} SingleFile note card${hidden === 1 ? '' : 's'} (capture imported in an earlier session — the SF toggle re-shows them)`);
    }
    if (opts?.noteCardsVisibleOverride) setSingleFileNoteCardsVisible(doc, true);

    /* (b) globals, BEFORE the script (module evaluation reads them). */
    win.__DOM_AK_CHANNEL__ = createLayerChannel();
    win.__DOM_AK_SNAPSHOT_META__ = getSnapshotMeta(capture.id, capture);
    win.__DOM_AK_OPTIONS__ = { freezeEnabled: opts?.freezeEnabled ?? capture.size <= FREEZE_MAX_BYTES };
    win.__DOM_AK_APP_BASE__ = hostBase;

    /* (d) navigation guard — capture phase, fresh document every load. */
    const guard = (e: Event): void => {
      if (e.type === 'submit') {
        e.preventDefault(); // a capture form can never leave the frame usefully
        return;
      }
      const me = e as MouseEvent;
      if (me.defaultPrevented) return;
      if (me.button !== 0) return; // middle/auxiliary clicks — the UA decides
      // upstream honesty: modifier clicks keep their native meaning
      // (open-in-tab etc.) — only the plain left click that would REPLACE the
      // frame dies here.
      if (me.metaKey || me.ctrlKey || me.shiftKey || me.altKey) return;
      const target = me.target as Element | null;
      const a = (target?.closest?.('a[href]') as HTMLAnchorElement | null) ?? null;
      if (!a) return; // plain clicks not on links need no guard
      const href = a.getAttribute('href') ?? '';
      if (!href || href.startsWith('#')) return; // in-page anchors are harmless
      if (/^(mailto|tel|javascript):/i.test(href)) return; // UA-handled, no navigation
      if (a.target === '_blank') return; // new tab — the session survives
      e.preventDefault(); // _self/_top/_parent/unnamed: would replace the frame
    };
    doc.addEventListener('click', guard, true);
    doc.addEventListener('submit', guard, true);

    /* (f) host-key forwarder — same lifecycle as the nav guard (host-context
     *     listener on the capture document; dies with it, re-armed every
     *     load). ⌥Z pressed with focus inside the capture never reaches the
     *     HOST document; forward it to the host's zen toggle.
     *     Review P2-2 (cross-realm): the shared isTypingTarget uses
     *     instanceof HTMLElement — FALSE for an iframe-realm target seen
     *     from this HOST-context listener, so the guard was a no-op here
     *     (live-verified: ⌥Z engaged while typing in a capture input).
     *     Duck-type the same four cases instead — no instanceof, no realm. */
    const forwardKey = (e: KeyboardEvent): void => {
      if (!e.isTrusted) return; // synthetic dispatches stay single-source
      const t = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true)) return;
      if (!e.repeat) {
        if (hotkeyMatches(e, ZEN_SPEC)) opts?.onHostKey?.('zen');
        else if (hotkeyMatches(e, SPEC_EPIC_SPEC)) opts?.onHostKey?.('specEpic');
        else if (hotkeyMatches(e, SPEC_STORY_SPEC)) opts?.onHostKey?.('specStory');
      }
    };
    doc.addEventListener('keydown', forwardKey, true);

    /* (c) the layer script — src minted from the HOST baseURI. */
    const script = doc.createElement('script');
    script.type = 'module';
    script.src = new URL('layer.mjs', hostBase).href;
    (doc.body ?? doc.documentElement).appendChild(script);

    /* (e) injection-failure detection — the module sets __domAnnotakit at
     * the END of its top level; poll briefly and surface an honest notice
     * if it never lands (CSP-blocked script loads fail SILENTLY — no error
     * event reaches the host; the iframe's console is a separate context). */
    loadTimers.forEach(clearTimeout);
    loadTimers = [];
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const isUp = (): boolean => !!(win as Record<string, unknown>).__domAnnotakit;
    for (const delay of [1200, 2500, 5000]) {
      timers.push(setTimeout(() => {
        if (settled) return;
        if (isUp()) {
          settled = true;
          timers.forEach(clearTimeout);
          opts?.onStatus?.({ away: false, injected: true });
        } else if (delay === 5000) {
          opts?.onStatus?.({ away: false, injected: false });
        }
      }, delay));
    }
    loadTimers = timers;
  };

  /* attach: past-parsing documents (cached-complete OR already-interactive)
   * inject IMMEDIATELY. Two listener doors cover every other shape:
   *   - DOMContentLoaded on the content document — fires at `interactive`
   *     even when `load` NEVER does (live E2E find #6: SingleFile captures
   *     with hanging inlined resources sit at interactive forever);
   *   - the iframe `load` — first loads, reloads, capture switches.
   * The per-document identity guard makes double doors inject exactly once;
   * the href guard heals a stale-document direct call on the fresh load. */
  if (iframe.contentDocument && iframe.contentDocument.readyState !== 'loading') onLoad();
  iframe.contentDocument?.addEventListener('DOMContentLoaded', onLoad);
  iframe.addEventListener('load', onLoad);
  /* backstop poller: if the DOMContentLoaded binding attached to a MID-
   * NAVIGATION stale document (capture switch — the fresh document object
   * only exists after the navigation commits) and that fresh document is
   * stuck-interactive, NOTHING above would fire. Poll cheaply; the identity
   * guard + debounce make extra pokes no-ops (an injected document costs
   * one readyState read per tick). NO HARD CAP (review P2-3): a reload >20s
   * after attach into a load-hanging capture must still find this door open;
   * the poller lives for the injectLayer lifetime and dies with the disposer. */
  const poll = setInterval(() => {
    if (iframe.contentDocument && iframe.contentDocument.readyState !== 'loading') onLoad();
  }, 500);
  return () => {
    if (awayWatchdog) {
      clearTimeout(awayWatchdog);
      awayWatchdog = null;
    }
    clearInterval(poll);
    iframe.removeEventListener('load', onLoad);
    iframe.contentDocument?.removeEventListener('DOMContentLoaded', onLoad);
    loadTimers.forEach(clearTimeout);
    loadTimers = [];
    clearLayerChannel();
  };
}
