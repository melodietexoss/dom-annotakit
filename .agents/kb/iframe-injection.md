# kb: iframe layer injection — globals, handle, channel pair, lifecycle

The host app and the pin layer live in SEPARATE JS heaps (same-origin
iframe). This entry records the exact contract (implemented in
`src/host/inject.ts`, `src/host/channel.ts`, `src/preview/bootstrap.ts`).

## Injection sequence (on every iframe `load`)

1. **Load-guard**: `contentWindow.location.href` (hash-stripped) must equal the
   expected capture URL — else "away from capture" notice, SKIP injection
   (the layer must never mount into a foreign document).
2. **Globals, BEFORE the script tag** (module top-level reads them):
   - `__DOM_AK_CHANNEL__` — the host channel object (on/removeListener/emit,
     events.ts names; try/catch'd contract inherited).
   - `__DOM_AK_SNAPSHOT_META__` — `{ storyId, name, title, url }` (story.url =
     the capture view `?capture=<id>` — feeds digest/issue deep links).
   - `__DOM_AK_OPTIONS__` — `{ freezeEnabled }` (false > 20MB captures; the
     layer honors it at EVERY freeze entry — hotkey, UI_COMMAND, internal).
   - `__DOM_AK_APP_BASE__` — the HOST page's baseURI (mode.ts's FIRST health
     candidate — subpath deployments would otherwise degrade to read-only).
3. **Navigation guard** — capture-phase click/submit listeners on the
   contentDocument: plain left-clicks on links + form submits that would
   REPLACE the frame are preventDefault-ed (modifier clicks + target=_blank
   stay honest). Listeners die with their document; every load re-arms fresh.
4. **The script** — `<script type="module" src=new URL('layer.mjs', hostBase)>`
   appended to the capture's body. Module type is LOAD-BEARING (the bundle is
   ESM; a classic script tag = SyntaxError). The src is minted from the HOST's
   baseURI — never hard-code an absolute path (subpath 404).
5. **Injection-failure polls** — check `contentWindow.__domAnnotakit` at
   1.2/2.5/5s; absent at the last → honest "layer failed to load" notice
   (CSP-blocked module loads fail SILENTLY — no error event reaches the host;
   the iframe console is a separate context). Timers are cleared at the top of
   every load AND by the disposer (a stale probe misreports for the WRONG
   capture).

## The handle (`window.__domAnnotakit` inside the iframe)

`{ channel, meta, options, captureAnchorFor(el), ready, version }` — the
SingleFile import uses `captureAnchorFor` so ALL anchor-capture DOM ops run in
the CAPTURE's document (it reuses the layer's own path: same storyRoot()
resolution, isPinnableTarget, captureAnchor(el, root)). The host reaches the
handle via `iframe.contentWindow.__domAnnotakit` (same-origin direct calls).

## The channel pair (cross-heap fan-out)

The host owns ONE channel object; the layer holds the SAME object reference
(same-origin objects cross frame boundaries). Every THREADS_CHANGED the host
emits must ALSO reach the iframe heap: the host's emit fans out — its own
listeners + a direct call into the iframe's handle channel (try/catch).
Server mode: a ~5s poll of GET /threads emits on change (REST is the source
of truth; the panel is poll-safe). Static mode: `storage` events instead
(cross-tab) — poll OFF.

## Lifecycle facts that bite

- The iframe document DIES on capture switch/reload — every listener, timer,
  and the handle go with it; the host's disposer (returned by `injectLayer`)
  removes its own listeners + clears probes + the layer channel side.
- The layer PULLS threads (`dataRef.list`) — you cannot "hand" it a filtered
  list. Dangling/page-level imports are skipped in the layer's pin-render
  path via `TargetContext.singleFileDangling` (panel still shows them).
- The host page NEVER scrolls: the iframe fills the viewport (100% height);
  the capture scrolls INSIDE. Pins are position:fixed to the iframe's
  viewport; the layer's scroll listener binds with `capture: true` (scrolls
  don't bubble — capture-phase catches INNER-container scrolls; captured SPAs
  scroll in divs, not the window).
- The drawer makes the iframe short (~235px) — E2E targets must be in-iframe-
  viewport; `elementFromPoint` is null outside it.
- The SingleFile note cards render ABOVE older z roots (2147483646) — the
  styles.ts edit puts `.annota-root` at 2147483647; ties are won by DOM order
  (the layer injects AFTER capture content). `.note-selected` cards (also
  2147483647) are an accepted cosmetic residual pre-import.
- Keyboard events in E2E go to the TOP document — dispatch KeyboardEvents on
  the IFRAME's document via eval (`new w.KeyboardEvent('keydown', …)` on
  `w.document`).
