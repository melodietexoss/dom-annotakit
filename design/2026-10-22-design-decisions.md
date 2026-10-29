# dom-annotakit — Design decisions D1–D3 (v0.1 scope) — REV 2

Written 2026-10-22, orchestrator session 1. REV 3 folds critique round 2
(`2026-10-22-critique-2.md`: the dangling-filter mechanism fix, veil-z
attribution, freeze-hotkey gate, cross-heap channel fan-out, static-mode
tombstone divergence, and the round-2 P3s) on top of REV 2 (critique round 1:
`2026-10-22-critique-1a.md` + `2026-10-22-critique-1b.md`, all P1/P2 folded).
Status: REV 3 — per the round-2 auditor, only a confirm-diff remains before
DESIGN FINAL. Upstream: melodietexoss/storybook-annotakit-dev @ 2853e32
(v0.6.16). Vendoring rule: COPY EXACTLY; deviations are surgical, listed in
`COPY-MAP.md`, and mechanically checked (`UPSTREAM` pin + drift-check script).

Mission: the reviewer captures pages with SingleFile (maybe without
annotating at the time), then wants the annotakit review experience — pick an
element, pin, thread, discuss, resolve — pinned ON the rendered snapshot.
Same workflow integration as SB annotakit: GH Issues mirror, db storage,
offline md/json export. Plus: import SingleFile's own embedded notes when a
capture carries them.

## D1 — Tool shape & repo strategy

### D1a — DOM picker + annotation flow on the RENDERED capture

**Decision: render the capture in a same-origin iframe and inject the annotakit
pin layer into it.** (Reverse-to-TSX rejected: a rebuild is a lossy simulation
of minified production apps; the pin engine already proves itself on static
fiber-less DOM — frozen-view pins are exactly this shape; automated reversal
stays a PLAN item for a mockup pipeline.)

**Known fidelity limits (documented so reviewers don't file phantom bugs):**
root-relative `<use xlink:href=/svg-sprite/…>` icon refs 404 on our origin
(invisible icon slots — as-captured); 1–2 external `<link>`s and a few
external `<img>`s mean review-time network calls; content inside NESTED frames
in a capture (rare, e.g. a hidden Usersnap frame) is unpinnable
(`elementsFromPoint` cannot cross frames); `rel=expect blocking=render` in
some captures may delay first paint inside the iframe (verify prompt paint in
the E2E smoke). Corpus verified: 0 `<script>`, 0 `<base>`, 0 CSP metas in the
30-file corpus — preconditions hold TODAY; CSP-meta risk is tabled below.

### D1b — New sibling repo `dom-annotakit-dev` (private) + GL mirror

Different distribution shape than the SB addon, sealed upstream release
gates, no live dependency possible (kit not on npm). Layout mirrors the SB kit
+ `src/host/` (app shell) + `src/singlefile/` (note import). A `UPSTREAM`
file (repo URL + pinned commit) + `scripts/drift-check.mjs` make the
COPY-MAP contract mechanically checkable. Public release repo deferred (PLAN).

## D2 — Capture rendering, element targeting, SingleFile import

### D2a — Same-origin iframe + layer injection

- Capture loads by URL (same origin; `file://` unsupported). After the iframe
  `load` event, the host injects, verbatim:
  `<script type="module" src="/layer.mjs"></script>` (tsup browser format is
  ESM — a classic script tag is a guaranteed SyntaxError).
- The layer mounts `.annota-root`, injects its styles, and exposes its
  channel at `window.__domAnnotakit`; the host reaches it via
  `iframe.contentWindow` directly (same-origin; channel contract minimal,
  try/catch'd). The host mints the script src from ITS OWN baseURI
  (`new URL('layer.mjs', hostBase)`) — an absolute `/layer.mjs` would 404 in
  subpath deployments.
- **Cross-heap channel fan-out**: the iframe layer is a separate JS heap — a
  host-side THREADS_CHANGED emit reaches the host panel but NOT the layer.
  The host owns a channel PAIR: it emits on its own channel AND calls the
  iframe's exposed channel (direct same-origin call) on every refresh, so
  panel + layer hear every change.
- **Scrolling contract (load-bearing)**: the iframe fills the host's visible
  area — `width: content-area; height: 100%` — and the CAPTURE SCROLLS
  INSIDE the iframe. Pins are `position:fixed` against the iframe's viewport
  (the exact SB-preview shape the layer was hardened in). The host page never
  scrolls. E2E asserts: scroll the iframe → pins stay viewport-fixed.
- **Navigation guard**: on injection the host adds a capture-phase
  click/submit interceptor on `contentDocument` (`preventDefault` on
  unmodified link clicks + form submits; modifier-clicks allowed) — corpus
  keeps live hrefs, one click would destroy the session. A load-guard: if
  `load` fires with `contentWindow.location` ≠ capture URL → "away from
  capture" notice, skip injection. (~15 lines host code.)
- **z-war**: SingleFile note cards style themselves `z-index: 2147483646`;
  `.annota-root` is 2147483000 — cards would cover pins AND the composer.
  COPY-MAP'd edits: `.annota-root` → `2147483647` (in `styles.ts`), frozen
  veil → `2147483646` (round-2 correction: it lives in `snapshot.ts:204`
  cssText, not styles.ts). Ties at max-z are won by DOM order — the layer
  injects AFTER capture content, so our surface wins. Known cosmetic residual
  (documented): a `.note-selected` card (z 2147483647 in the corpus) can tie
  with our root — DOM order still favors us; pre-import selected cards over
  the veil are accepted.
- **Health-probe candidate**: a server/subpath deployment defeats mode.ts's
  two-candidate ladder (capture-dir-relative is useless in-iframe). The host
  injects a build constant (app base URL) via
  `window.__DOM_AK_APP_BASE__`; COPY-MAP'd edit in `mode.ts` adds it as the
  FIRST health candidate. Static mode unaffected (parent-aware seed ladder
  verified).
- **Freeze gate**: freeze = full-DOM clone; above the manifest's size
  threshold (20MB) freeze is disabled EVERYWHERE — the button AND the ⌥I
  hotkey AND any UI_COMMAND path (the layer refuses only when
  `frozenView===false` upstream — a button-only gate leaves the hotkey live).
  Mechanism: a `freezeEnabled` layer option (surgical layer.tsx EDIT), set
  per-capture from the manifest by the host; hint shown on all entries.
- Host shell: capture sidebar (manifest), toolbar (pin · region · freeze ·
  threads+count · show/hide), bottom-drawer panel (ported ReviewPanel),
  settings, import affordance.

### D2b — Element targeting: anchor engine with TWO scoped edits

- Rung ladder (css/finder → textQuote → fingerprint/back-scan → orphan) —
  logic unchanged. Verified: unquoted SingleFile serialization is invisible to
  the parsed DOM; `data-single-file-*` never enters identity
  (FINGERPRINT_ATTRS excludes src/srcset); hrefs stay live and stable; note
  cards can't pollute anchors (TEMPLATE-skip, shadow text isolation,
  absolute positioning = no layout impact).
- **EDIT 1 (className exclusion)**: the finder's className filter admits
  `single-file-highlight-yellow` → captured selectors embed it → a re-save
  without the highlight breaks the css rung. Add `/^single-file-/` to the
  className exclusion (one line, tested, COPY-MAP'd).
- **captureId** = relative path from the captures root, extension-stripped,
  sanitized `[^a-zA-Z0-9-] → -`; the manifest builder FAILS LOUDLY on basename
  collisions instead of silently merging. The manifest records each capture's
  embedded provenance (`Page saved with SingleFile / url: … / saved date: …`
  header comment) — free re-save detection (same url, different file →
  surface a hint; thread migration offer = PLAN). **Rename = new identity**
  (documented; threads stay keyed to the old id).

### D2c — SingleFile native annotation import

Format (verified on real captures): `<single-file-note data-note-id=N
data-note-offset-x/y>` light-DOM SIBLINGS of their targets, wrapping
`<template shadowrootmode=open>` sticky cards (`<blockquote cite='…selector(type=CssSelector,value=[data-single-file-note-refs~="N"])'><textarea dir=auto>TEXT</textarea></blockquote>`); targets carry
`data-single-file-note-refs="N …"` (space-separated multi-membership is
real: `refs="1 2 3 4"`); a separate highlight system (left rendered, not
converted in v0.1).

Design (amendments folded):

1. **Reader** — DOM-parse after iframe load. The card content is reached by
   `contentOf(note) = note.shadowRoot ?? note.querySelector('template')?.content ?? null`
   — declarative shadow DOM MOVES template children into the shadow root on
   live parse (template.content is EMPTY in the browser; the inverse is true
   in Node/jsdom fixtures). **The test matrix pins BOTH shapes**: a
   browser E2E on the real annotated capture + Node fixture tests. Parsing
   must iterate the space-separated refs list per element (one thread per
   note; cascade fans the pins).
2. **Identity & idempotency (structural, not marker-based)** — deterministic
   thread id `singlefile-<captureId>-<noteId>-<sha1(noteText)[0:8]>` via
   `ThreadInput.id` + the store's existing POST replay door (200
   `replayed:true` = no duplicate). The text hash folds in note-id RECYCLING
   (ids restart at 1 on re-save; unchanged note → replay/no-op; edited or new
   note → new thread, old one degrades honestly). **Delete-wins respected —
   at BOTH doors with their DIFFERENT shapes (round-2 correction)**: the
   server replays 409 `{deletedId:true}`, the static store's create-on-
   tombstone THROWS (staticStore:420) — the importer catches both shapes
   per-note and treats them as already-imported-and-deleted (skip, never
   resurrect; partial imports proceed note-by-note). Provenance via ONE
   additive types.ts EDIT (3 lines): `Comment.source` + `'singlefile'`;
   `TargetContext.singleFileNoteRef?: string`;
   `TargetContext.singleFileDangling?: boolean`. Provenance via ONE additive types.ts EDIT (2 lines):
   `Comment.source` extended with `'singlefile'`; `TargetContext.singleFileNoteRef?: string`.
3. **Dangling refs** (6 real cases in the corpus: target not in the saved
   DOM) — **no fabricated evidence pins**. Dangling notes import as
   panel-only threads (no canvas pin) with a "dangling SingleFile note —
   target not in capture" badge; the note text + offsets are kept in the
   thread for provenance. **Mechanism (round-2 correction): the layer PULLS
   threads via `dataRef.list` (layer.tsx:460 dev / :562 static) — the host
   cannot "filter what it hands". Instead: imported dangling/page-level
   threads carry the additive `TargetContext.singleFileDangling = true` flag,
   and a surgical layer.tsx EDIT (the 6th substitution point) filters that
   flag out of the PIN render path only (panel rows unaffected; badge keyed
   on the same field). Empty-text notes skip with a loud "N skipped (empty)"
   import notice.**
4. **Page-level targets** (`<html>`/`<body>`/scope-root targets — real in the
   corpus) — never through the plain element path (degenerate anchors); they
   import as page-level threads carrying `singleFileDangling` (the same
   render-skip flag; the context text records "page-level"): panel-only,
   "page-level SingleFile note" badge, same no-pin honesty.
   (Region-over-viewport variant = PLAN.)
5. **Strip-first invariant** — cards are layout-inert (absolute shadow
   content, empty light text) but they are ELEMENT SIBLINGS, and finder
   selectors are `:nth-child`-based: the card strip (auto or import-time)
   happens BEFORE any anchor capture on that capture, in every session.
   Pre-import pins made while cards are still present keep honest ladder
   degrade if a later import strips cards (documented).
6. **Auto-strip key** — a host-owned import flag
   (`dom-annotakit:stripped:<captureId>` in localStorage, both modes) is set
   at import; later loads auto-strip cards. If the flag is cleared, cards
   re-render and the import button re-appears — harmless: re-import is
   idempotent via the deterministic ids (delete-wins still guards deliberate
   deletes).
7. **Author** — imported comments' author: settings override → else
   `singlefile-import`.
8. z-order of pre-import cards vs our surface: covered by the D2a styles.ts
   edit (cards visible beneath our surface, never above).

## D3 — Storage, sync, exports (exact parity via wholesale copy)

### D3a — Two modes; the store owner is THE TOOL REPO

- **Server mode (primary)**: a small Node entry (`src/server/standalone.ts`)
  mounts the vendored `createMiddleware` on `http.createServer` at the origin
  root (`/annotakit/` prefix, no stripping) AND serves the app build, the
  captures dir, and `/layer.mjs`. The middleware needs only the URL prefix +
  `req.headers.host` (verified zero SB imports; access gate + loopback CORS
  inherited).
- **Wiring traps (folded)**: `standalone.ts` calls `serverChannelHook(host
  emitter)` — `emitToChannel` is the ONLY live-update path in server mode
  (broadcast is best-effort; the panel is poll-safe). The server→browser
  transport in v0.1: the host panel polls `GET /threads` every ~5s and emits
  `THREADS_CHANGED` on the host channel when the list changes (host-side,
  zero vendored edits; SSE/WS = PLAN). `standalone.ts` passes an explicit
  configDir INSIDE the tool repo (`<repoRoot>/.dom-annotakit`) + the real
  port via the `devServerHook` shape (bootstrap is not exported; port-correct
  boot matters — issue links mint from the boot origin). Default port 4310.
- **Store owner**: the dom-annotakit repo itself —
  `<git-common-dir>/annotakit-dom/threads.db`, autoSync pushes the orphan
  branch to the TOOL repo's remotes. The captures directory is DATA
  (referenced by the manifest), never the store owner. **Dual-kit isolation**
  (the GenEditor-ui case runs BOTH kits on one machine): COPY-MAP'd edits —
  store dir `annotakit-dom` (env.ts) + orphan branch `annotakit-dom` /
  fallback `annotakit-dom-store` (sync.ts) — so the two engines NEVER share a
  db, a branch, or a backfill stream. Per-kit GH config lives in each kit's
  own `annotakit.config.json` or process env (config file beats env);
  the cwd `.env` candidate is documented as a caution.
- **Static mode**: bake writes `annotakit-threads.json` (`{threads, deleted}`
  marker + tombstones) + `annotakit-gh.json` (token+repo resolve) +
  **`dom-annotakit-manifest.json`** (captures: id, relpath, title, size,
  provenance url/date, note count). The bake REQUIRES `--store` (no cwd-git
  discovery walk); host Vite builds with `base: './'`; the bake's ref-shape
  gate re-verified against the Vite build. Scope derivation verified safe:
  parent-anchored scope = host app; app-at-`/` + captures-at-`/captures/`
  works unchanged (one harmless wasted 404 per iframe probe — documented so
  nobody "fixes" it).
- Data model: `storyId` = captureId; `component` always null (renderers guard
  `if (comp)` — verified graceful in md/json/issue-body); story metadata =
  capture metadata; `getSnapshotMeta` mints `story.url` = the host capture
  view so the `?path=/story/` fallbacks (routes.ts:670, ghsync.ts:244,
  ghClient.ts:627) never fire.

### D3b — GitHub mirror

- One thread = one issue, whole lifecycle; all engine semantics copied
  (create-once adoption via `- thread id:` metaline, ghId dedupe, tombstone
  close, 401 self-heal, 404-unlink `ghUnlinkedAt`, DD-21 DETACHED,
  park/absent/transient, sentinel-notice suppression). `GH_SENTINEL` and the
  metaline stay unchanged (engine-identity, not label-scoped).
- **Default label `dom-annotakit` — 5 sites** (COPY-MAP'd, the crit-1b
  correction): routes.ts:45 `GH_LABEL` (also feeds `/health githubLabel`),
  ghsync.ts:121 `labelsOf` fallback, ghClient.ts:54 `DEFAULT_LABEL`,
  bake-static-threads.mjs:327, heal-mirrors.mjs:66. Pull filters AND-combine
  labels → the two kits' issue streams stay disjoint in one repo.
- `ANNOTAKIT_*` env names unchanged (zero drift; both kits in one consumer
  repo configure distinct labels deliberately).

### D3c — Digests, exports, agent surfaces

- `digest.ts` EDIT (enumerated): group labels story→capture (`- story:`,
  `UI review — N stories`, `storybook: ${origin}`, `story id:`, `story
  file:`, `component file:`), footer instructions reworded for capture
  reviews ("open the capture; the element/selector rows locate the target in
  the live app" — not `jsx:`/`component file:` paths that never exist here).
  The JSON export KEY `stories` STAYS (wire contract agents parse).
- `ghClient.ts` EDIT list extended: DEFAULT_LABEL (above), footer copy,
  "storybook (static deployment)"/"in Storybook" notices → host wording,
  `?path=/story/` deep-link → `?capture=` convention.
- `routes.ts` EDIT (2 lines): `groupByStory` fallback deep-link →
  `${origin}/?capture=${storyId}`; `/schema` example/notes copy story→capture
  (agent-facing). Rest of routes stays AS-IS (409 tombstone finality, replay
  flags, PATCH merge, deterministic comment-id re-hash — the contract agents
  depend on).
- User-facing "storybook" strings in vendored server code (console prefixes,
  sync README prose): ACCEPTED as provenance (one decision, documented —
  never ad-hoc reworded); only copy that INSTRUCTS SB commands gets reworded
  (manager down-state — inside the manager EDIT anyway).

### D3d — Deliberately NOT in v0.1

Per-pin DOM snapshot storage (capture file IS the evidence; `view` recall =
open capture + focus pin); highlight→thread conversion; reverse-to-stories;
viewport presets/zoom; SSE/WS live transport; multi-user auth (loopback +
`ANNOTAKIT_API_KEY` inherited); thread migration on capture rename.

## Risk table (additions)

| risk | mitigation |
|---|---|
| A future capture carries a strict CSP meta → layer script fetch/overlay blocked in-iframe | planned, NOT built: the server's static handler gains a streaming CSP-meta strip for captures (corpus has none today) |
| Delete-all + cleared localStorage → cards re-render | harmless: re-import idempotent; delete-wins (tombstone replay 409) guards deliberate deletes |
| Same-origin dual-bake on one origin | scopes are directory-anchored; distinct app dirs never collide (verified) |

## Test strategy (v0.1) — both note-DOM shapes pinned

- Copied suites green first: s6, ghclient, static-store, lattice, ghsync-fake,
  store-robust, heal-mirrors, release-check(+selftest).
- NEW: `singlefile-import-test.mjs` — Node fixture tests (template.content
  shape) incl. dangling-ref + multi-ref + root-target + recycle cases; a
  browser E2E on the REAL annotated capture (shadowRoot shape) — the pair is
  mandatory because jsdom masks the live-parse behavior; `manifest-test.mjs`
  (collision loud-fail, provenance extraction); drift-check (vendored files
  vs UPSTREAM pin + allowed-edit list).
- E2E walk on real GenEditor-ui captures (small ones): load, pin, thread,
  reply, resolve, export, import notes, scroll contract, navigation guard,
  prompt paint.
