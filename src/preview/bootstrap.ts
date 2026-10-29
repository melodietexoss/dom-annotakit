/**
 * dom-annotakit — iframe-side layer entry (COPY-MAP preview row: index.ts
 * REPLACE → this bootstrap; the SB decorator registration is GONE).
 *
 * The HOST (src/host/inject.ts) appends `<script type="module"
 * src="…/layer.mjs">` to the capture iframe AFTER its load event, having set
 * the injected globals first:
 *
 *   window.__DOM_AK_CHANNEL__        the host channel object (see layer EDIT (i))
 *   window.__DOM_AK_SNAPSHOT_META__  { storyId, name, url }   (layer EDIT (iii))
 *   window.__DOM_AK_OPTIONS__       { freezeEnabled }        (layer EDIT (vi))
 *   window.__DOM_AK_APP_BASE__      the host app's baseURI (mode.ts candidate)
 *
 * What this module does — everything SB's decorator did, minus every SB API
 * (no decorators/globals/parameters, no toolbar registration — the HOST
 * toolbar owns that):
 *   1. mounts <AnnotaLayer/> into the captured document (a plain container div
 *      at body level — React's createRoot takes over the container's children,
 *      so never hand it the capture's own body);
 *   2. hotkeys — the layer binds its own document listeners internally
 *      (verified: layer.tsx's keyboard effect; the host toolbar carries its
 *      own any-focus bridge, a separate document — no double-fire);
 *   3. exposes `window.__domAnnotakit` — the HOST-side handle. The layer has
 *      NO imperative API (upstream drove it purely via the channel), so the
 *      minimal honest surface is the channel itself + the injected meta:
 *      the host (or an operator in devtools) can emit UI_COMMAND /
 *      TOGGLE_LAYER / FOCUS_THREAD / RECALL_THREAD on `.channel` and the layer
 *      hears them;
 *   4. `captureAnchorFor(el)` (M4, design D2c) — the ANCHOR-CAPTURE half of
 *      the layer's own pin flow, factored for the SingleFile note import:
 *      the host resolves each note's target element in this document and
 *      needs the ThreadTarget a click on that element would have minted.
 *      Every DOM op stays INSIDE the capture's document; the host only ever
 *      receives the plain serializable target data (see captureAnchorFor).
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { AnnotaLayer } from './layer';
import { captureAnchor } from './anchor';
import { isPinnableTarget } from './hittest';
import type { ThreadTarget } from '../shared/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Mirrors the layer's minimal ChannelLike (on/removeListener/emit). */
interface ChannelLike {
  on(event: string, cb: (...args: any[]) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  emit(event: string, payload?: unknown): void;
}

/** The channel used when the capture iframe is opened with NO host around. */
const noopChannel: ChannelLike = {
  on: () => undefined,
  removeListener: () => undefined,
  emit: () => undefined,
};

function readGlobal<T>(name: string): T | undefined {
  try {
    return (window as any)[name] as T | undefined;
  } catch {
    return undefined;
  }
}

interface InjectedMeta {
  storyId?: string;
  title?: string;
  name?: string;
  url?: string;
}

const meta = readGlobal<InjectedMeta>('__DOM_AK_SNAPSHOT_META__') ?? {};
const channel = readGlobal<ChannelLike>('__DOM_AK_CHANNEL__') ?? noopChannel;
const options = readGlobal<{ freezeEnabled?: boolean }>('__DOM_AK_OPTIONS__') ?? {};

// Mount: a fresh container div — the layer's `.annota-root` is position:fixed
// inside it; appending at body END never shifts the capture's own layout or
// the finder's nth-child paths (the strip-first invariant's discipline).
// createElement (not JSX) keeps this a .ts entry — the tsup classic-JSX
// transform needs no tsconfig change either way.
const container = document.createElement('div');
(document.body ?? document.documentElement).appendChild(container);
const root = createRoot(container);
root.render(
  React.createElement(AnnotaLayer, {
    storyId: meta.storyId ?? '',
    title: meta.title,
    name: meta.name,
    // the per-capture freeze gate is the injected option, not a story parameter
    frozenView: true,
  }),
);

/** The capture scope root — the layer's OWN storyRoot() resolution,
 * verbatim (layer.tsx: `document.getElementById('storybook-root') ??
 * document.body`): a capture never carries #storybook-root, so the body IS
 * the scope, exactly as the click path uses it unfrozen. Kept in sync with
 * layer.tsx by construction (same expression); do not "simplify" one side. */
function captureScopeRoot(): HTMLElement {
  return (document.getElementById('storybook-root') as HTMLElement | null) ?? (document.body as HTMLElement);
}

/**
 * The anchor-capture half of the layer's pin flow, reused for the SingleFile
 * note import (M4, design D2c) — the SAME pure functions the layer's click
 * path calls, with the SAME root/scope resolution:
 *
 *   layer actOnHit (unfrozen):
 *     scope = hitScope()                     = storyRoot()   ← captureScopeRoot()
 *     isPinnableTarget(target, scope)        (hittest.ts — strict descendant)
 *     root  = frozenCaptureRootFor(target)   = storyRoot()   ← captureScopeRoot()
 *     captureAnchor(target, root)            (anchor.ts — pure DOM)
 *     ThreadTarget = { kind: 'pin', ...anchor }
 *
 * What was NOT reused: hitTest (the import has the element directly — no
 * coordinates to hit-test), composer state (none needed — the HOST owns the
 * ThreadInput), and the frozen-view branch (an import runs against the LIVE
 * root; capture while frozen would mint clone-relative anchors). Returns null
 * when the element is not pinnable (scope itself / overlay chrome) — the
 * caller treats that as an honest per-note failure, never a dangling pin.
 */
function captureAnchorFor(el: Element): ThreadTarget | null {
  if (!(el instanceof HTMLElement)) return null;
  const root = captureScopeRoot();
  if (!isPinnableTarget(el, root)) return null;
  const anchor = captureAnchor(el, root);
  return { kind: 'pin', ...anchor };
}

/** The host-side handle (see the header comment). */
(window as any).__domAnnotakit = {
  channel,
  meta,
  options,
  captureAnchorFor,
  ready: true,
  version: '0.1.0',
};
