/**
 * dom-annotakit — the host/iframe channel PAIR (design D2a "cross-heap channel
 * fan-out"; COPY-MAP events.ts row: the SB WS transport is replaced by this
 * module implementing the same names/payloads).
 *
 * The capture iframe is a SEPARATE JS heap: a host-side THREADS_CHANGED emit
 * reaches the host panel but NOT the layer, and a layer-side UI_STATE emit
 * reaches nothing but the layer. The host therefore owns a channel PAIR with
 * ONE broadcast: an emit on EITHER side delivers to BOTH listener sets.
 *
 *   hostChannel  — the host app subscribes/emits here (panel, toolbar, App).
 *   createLayerChannel() — called by injectLayer on every iframe load; the
 *                 fresh object is injected as `__DOM_AK_CHANNEL__` and becomes
 *                 the ACTIVE layer side (the previous document's listeners die
 *                 with its document — a reloaded capture never hears stale
 *                 callbacks).
 *
 * No re-entrancy loops are possible: `emit` is a flat delivery function (it
 * never calls the other side's public `emit`), so one event is delivered to
 * each side exactly once.
 *
 * Server-mode live updates (design D3a): `startThreadsPoll()` probes the mode
 * once (dev/static/down via shared/mode.ts — the host document's baseURI makes
 * the health/seed ladders just work) and, in dev mode only, polls
 * GET /annotakit/api/threads every 5s; a CHANGED list (JSON string compare)
 * re-emits THREADS_CHANGED on hostChannel — panel AND layer both hear it via
 * the broadcast. Static mode keeps the poll OFF: the staticStore
 * storage-event branch is the cross-document transport there.
 */

import { API_BASE, THREADS_CHANGED, type ThreadsChangedPayload } from '../shared/events';
import { probeMode } from '../shared/mode';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Mirrors the layer's minimal ChannelLike (on/removeListener/emit). */
export interface HostChannel {
  on(event: string, cb: (...args: any[]) => void): void;
  removeListener(event: string, cb: (...args: any[]) => void): void;
  emit(event: string, payload?: unknown): void;
}

type Cb = (payload?: any) => void;
type ListenerMap = Map<string, Set<Cb>>;

function addListener(map: ListenerMap, event: string, cb: Cb): void {
  let set = map.get(event);
  if (!set) {
    set = new Set();
    map.set(event, set);
  }
  set.add(cb);
}

function removeListenerAt(map: ListenerMap, event: string, cb: Cb): void {
  map.get(event)?.delete(cb);
}

/** Copy-then-call: a listener that removes itself mid-delivery must not skip
 *  its siblings, and one listener throwing must never break the rest. */
function deliver(map: ListenerMap | null, event: string, payload?: unknown): void {
  if (!map) return;
  const set = map.get(event);
  if (!set || set.size === 0) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch {
      /* a broken listener never blocks the broadcast */
    }
  }
}

/** Host-side listeners (panel, toolbar, App) — singleton, lives across
 *  capture switches and iframe reloads. */
const hostMap: ListenerMap = new Map();

/** The ACTIVE capture iframe's listeners (the layer registers on the
 *  injected channel object; those callbacks land here). One at a time —
 *  `createLayerChannel()` swaps it on every iframe load. */
let layerMap: ListenerMap | null = null;

/** ONE broadcast for both sides — the fan-out itself. */
function broadcast(event: string, payload?: unknown): void {
  deliver(hostMap, event, payload);
  deliver(layerMap, event, payload);
}

/** The host app's channel (panel + toolbar + App subscribe here; emits reach
 *  the layer too). Event names from shared/events.ts — identical to the SB
 *  wire contract upstream used. */
export const hostChannel: HostChannel = {
  on: (event, cb) => addListener(hostMap, event, cb),
  removeListener: (event, cb) => removeListenerAt(hostMap, event, cb),
  emit: broadcast,
};

/**
 * Build the channel object injected into the capture iframe
 * (`window.__DOM_AK_CHANNEL__`). Its `emit` is the same broadcast, so
 * layer-side acks (UI_STATE, LAYER_STATE, THREAD_FOCUSED…) reach the host
 * too. Calling this REPLACES the active layer side — one live iframe at a
 * time; the reloaded document re-registers its own listeners.
 */
export function createLayerChannel(): HostChannel {
  const map: ListenerMap = new Map();
  layerMap = map;
  return {
    on: (event, cb) => addListener(map, event, cb),
    removeListener: (event, cb) => removeListenerAt(map, event, cb),
    emit: broadcast,
  };
}

/** Drop the active layer side (away-from-capture load, capture switch, app
 *  unmount) — its listeners belong to a dead or replaced document. */
export function clearLayerChannel(): void {
  layerMap = null;
}

/* ------------------------- server-mode live updates ------------------------- */

const POLL_MS = 5000;

/**
 * Server mode: poll the REST truth every 5s and re-emit THREADS_CHANGED when
 * the list changes (v0.1 transport — SSE/WS is a PLAN item). Static mode: the
 * poll stays off (storage events own cross-document updates). Returns a stop
 * function.
 */
export function startThreadsPoll(): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastJson: string | null = null;

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };

  void probeMode().then((mode) => {
    if (stopped || mode !== 'dev') return; // static: storage events; down: nothing to poll
    const tick = (): void => {
      if (stopped) return;
      fetch(`${API_BASE}/threads`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.text() : null))
        .then((text) => {
          if (stopped || text === null) return;
          if (lastJson !== null && text !== lastJson) {
            const payload: ThreadsChangedPayload = { reason: 'updated' };
            hostChannel.emit(THREADS_CHANGED, payload);
          }
          lastJson = text;
        })
        .catch(() => undefined) // transient poll failures are silent — REST is re-tried next tick
        .finally(() => {
          if (!stopped) timer = setTimeout(tick, POLL_MS);
        });
    };
    tick();
  });

  return stop;
}
