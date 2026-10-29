# CSS cascade + request-seam + store-API facts (session-4 live finds)

## The `display:contents !important` cascade trap (D13, live E2E)

SingleFile saves its OWN rule for note hosts into captured pages:

```css
single-file-note { /* per-property all:initial set */ display: contents !important; }
```

Two author-origin `!important` rules are resolved by **document order of
their stylesheets** — the LATER one wins. A hide-stylesheet appended to
`<head>` LOSES to SingleFile's rule (wherever its `<style>` sits later), and
the cards stay visible. The fix: append the injected sheet at the **BODY
END** (last in document order). To UN-hide, don't fight the cascade — flip
`style.media` to `'not all'` (the sheet goes inert; SingleFile's rule
restores). `:nth-child` counts TREE position, so `display:none` vs
`display:contents` never changes anchor math — only DOM REMOVAL does (the
strip-flow drift bug class).

## The engine request-rewrite wrapper (D10 seam)

The engine's full `req` inventory for POST bodies (audited):
`url`, `method`, `headers` (host, origin, x-annotakit-key),
`socket.remoteAddress` (isLoopbackPeer), `on('data'|'end'|'error')` (readBody,
routes.ts:392). A wrapper must: (a) carry `socket` or the loopback gate
loosens, (b) fix `content-length`, (c) re-emit BUFFERED bytes from a
PassThrough (never re-attach the consumed original stream), (d) enforce the
engine's own 2MB cap at pre-load, (e) settle on `close` too (client aborts).
`Object.create(passThrough)` + `Object.defineProperties` for the scalars is
the whole trick.

## Static-store write doors (audit round-1 P1)

`StaticStore`'s write door is **`patch(thread)`** — there is NO `update`.
A duck-typed `store.update?.()` silently no-op'd while the caller counted
success and latched a one-time flag. Rules: call the REAL API (never
optional-chain into an assumed method), and pin the API shape in the suite
(`scripts/singlefile-import-test.mjs` fails if `update` ever appears or
`patch` vanishes). `LinkedStaticStore.patch` also enqueues the GH outbox —
the right door for anything that must reach the mirror.

## Serving a captures-dir that IS a project root

The manifest is the ONE source of truth for what `/captures/*` may serve:
servable IFF the current manifest build lists the relpath (dot-skip,
non-recursive/denylist, extension rules live in the scan only). Everything
else 404s — including `.env`, `.git/…`, `package.json` that physically sit
under the dir. The same gate guards in-app deletes (not servable → not
deletable). Manifest cache: dir mtime + per-file (mtime,size) fingerprint —
a same-name re-save refreshes; an untouched tree serves the cached object.
`captureIdOf` strips only the LAST extension → `foo.html` + `foo.htm`
collide → refuse collision-class uploads with 409 (a written pair bricks
the manifest + closes the gate until an on-disk fix).

## Git durability from a request handler

`execFileSync('git', …)` without `{ timeout }` freezes the single-threaded
standalone for the op duration (network pushes worst). 30s cap + SIGKILL;
failures are WARNINGS (the file op already succeeded — report the durability
string honestly). `HEAD:main` is safe only on main-locked worktrees (the
watchdog guarantees it here); hardcoding it ships the assumption elsewhere.
