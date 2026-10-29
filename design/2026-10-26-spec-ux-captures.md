# D10–D14 — spec UX (epic/story top bar + filtering), capture management, SingleFile display, sync UX

Date: 2026-10-26 (session 4). Inputs: user round-4 feedback (verbatim asks:
top-bar epic/story selectors with keyboard/typeahead/auto-create; two-level
epic→story filtering; upload+manage captures with a designated folder defaulting
to the PROJECT ROOT; hide/unhide SingleFile's own annotations, hidden by default
after import + verify element extraction; fix the "broken" GH sync; then the
exhaustive audit/hardening round).

All changes land in drift-free surface: `src/host/**`, `src/server/standalone.ts`,
NEW modules (`src/shared/specCatalog.ts`, `src/server/hostRoutes.ts`), and edits
to existing NEW files (`projectMirror.ts`, `specDirectives.ts` passive reuse,
`ghProjects.ts` additive). Vendored/engine files untouched; the bake script is
EDIT-locked and takes explicit `--captures`, so serve-side capture semantics do
not affect it (manifest JSON contract unchanged either way).

---

## D10 — Epic/Story top-bar selectors (the "better UX")

**Where**: the Toolbar, between the capture filename and the pin buttons —
two compact comboboxes: `Epic ▾` and `Story ▾`. Visible only in serve mode
(static mode: the board mirror has no compose-context seam — documented scope
line; the tip hint stays).

**Combobox contract** (one reducer, pure, isomorphic + unit-tested —
`src/shared/specCatalog.ts`):
- click / ⌥E / ⌥S opens (host-document chords; never fires while typing in an
  input; the layer keeps its own hotkeys untouched — ⌥E/⌥S are outside the
  engine's alt-set);
- typing filters options (case-insensitive substring, diacritic-insensitive via
  localeCompare sensitivity:'base' — same discipline as the sidebar sort);
- ↑/↓ move an active row (no wraparound loops — stop at edges), Enter commits
  the active row, Esc closes and reverts, Tab commits a typed-new value iff it
  is non-empty (natural flow), Backspace-to-empty + Esc clears the selection;
- the FIRST row becomes `Create “<typed>”` when the typed text has no
  case-insensitive exact match — Enter on it selects the new value (in-memory
  + persisted client-side; the board OPTION materializes lazily at the next
  mirror pass via the reconciler's existing ensureOptions — no eager API call,
  no option pollution for values never used);
- ⌫-on-chip (a selected combobox shows the value as a chip with a small ×)
  clears it. ARIA: role=combobox/listbox/option, aria-expanded, aria-activedescendant.

**Data source** — new sidecar endpoint `GET /dom-annotakit-spec.json`:
```json
{ "epics":  ["Folder UX Overhaul", …],           // board field options + thread-derived, deduped, sorted
  "stories": [{"name": "Filters panel", "epics": ["Folder UX Overhaul"]}, …],  // co-occurrence from threads (+ board options with no thread yet → epics: [])
  "captures": {"<captureId>": {"epics": {"E": 2}, "stories": {"S": 2}}},        // rollup for filtering
  "context": {"epic": "…", "story": "…"} }        // the session compose context (echo)
```
- board options: `listSpecCatalog(gql, target)` in ghProjects.ts (fields query
  only — no item read; cheap); merged with thread-derived values
  (threadSpecDirectives over comments — the local store may be ahead of the
  board between passes);
- the sidecar caches the catalog between passes and refreshes it on every
  reconcile + on PUT context (no new polling load); the host polls the
  endpoint on the same 20s cadence as the status chip.

**Compose context (the dual purpose)**: selecting an Epic and/or Story ALSO
sets the session filing context — new comments get `@epic: <sel>` / `@story:
<sel>` lines appended automatically when they carry none of their own. This
is the "comment organization" UX without forcing users to remember syntax.
- transport: `PUT /dom-annotakit-spec-context {epic?, story?}` (server-memory;
  mirrored in localStorage by the host for restore-on-reload);
- application: the sidecar intercepts engine POSTs at the standalone seam —
  `POST /annotakit/api/threads` (create: `comments[0].body`) and
  `POST /annotakit/api/threads/:id/comments` ({body}) — parses the JSON,
  checks parseSpecDirectives, appends missing directive LINES (epic first),
  and forwards a rewritten body via a wrapped request (duck-typed: url,
  method, headers with fixed content-length, on/once/removeListener over a
  pre-loaded stream — readBody (routes.ts:392) is the only body consumer).
  Escalation rules: comment-has-own-directives wins per KEY (user typed
  `@epic: X` keeps X, missing key gets the context value); context absent →
  untouched passthrough; malformed JSON → untouched passthrough (engine
  returns its own 400 — never worse than today).
- the board body keeps being "the record": injected lines are ordinary
  directive lines, visible in the panel comment (honest, editable, deletable
  like any text).

## D11 — Two-level filtering (epic → story)

One selection state in App (epic?, story?) shared by the Sidebar and the
panel. Semantics:
- **Sidebar** — captures filtered to those with ≥1 thread matching; a match
  badge shows the count (`2 threads` chip). Empty result → honest "no
  captures under this filter" row + a clear-filter button.
- **Story scoping** — selecting an Epic scopes the Story combobox options to
  that epic's stories (co-occurrence edges from threads + board stories with
  the epic pre-known). A Story can also be picked first (then Epic options
  show all epics; picking an Epic that has no edge to the picked Story
  CLEARS the story — two-level integrity, announced by the reducer state).
- **Panel** — ReviewPanel receives {epic, story} props; threads filter
  client-side through the same threadSpecDirectives resolution (threads carry
  comments in the store payload). Filter chips render in the panel header
  with counts.
- **Canvas** — NOT filtered: the layer protocol has no filter command and
  pins are per-capture anyway; the honest surface is the sidebar + panel.
  (Documented in the combobox tooltip: "filters the list + panel".)
- "Unfiled" handling: threads without directives are NEVER matched by any
  selection; selecting an epic shows captures that have ≥1 filed thread.
  (Showing unfiled-only would need a third pseudo-option — deferred; the
  board's un-grouped tail covers it.)

## D12 — Capture upload + management

**Designated folder**: `annotakit.config.json` `"captures": {"dir": <abs or
repoRoot-relative>, "recursive": bool}`. Resolution: `DOM_AK_CAPTURES_DIR`
env (engine precedent, already wired) > config `captures.dir` > **default =
repoRoot (the PROJECT ROOT)** — the user's stated habit ("project root by
default as that's where i usually put things, any html").
- **Scan**: default NON-recursive (top-level `*.html`/`*.htm` only — the
  project root contains `dist-app/index.html`, `public/*`, `examples/*` which
  must NOT become captures); `recursive: true` adds the denylist
  `node_modules, .next, dist, dist-app, build, out, coverage` + dot-entries
  (dot-dirs are already skipped by listCaptures).
- **Vendored deployment**: `git mv annotakit/captures/*.html` → host repo
  root (captureIdOf keys on relpath — root-level relpath `x.html` keeps the
  SAME id as `x.html` had under the old dir ONLY if the old relpath was
  also bare — it was: files sat flat in `annotakit/captures`, relpath =
  basename → **ids unchanged, threads survive**). The vendored
  `.dom-annotakit/annotakit.config.json` sets `"captures": {"dir": ".."}`
  (repoRoot-relative → the host root); BOTH spawners
  (instrumentation.ts, mini-services/annotakit-server) DROP their
  DOM_AK_CAPTURES_DIR so config wins visibly.

**Upload** — `POST /dom-annotakit-captures` (JSON {name, content}):
- name sanitized: basename-only, must end `.html`/`.htm`, length cap 200,
  NUL/velocity-safe; content cap 100MB; UTF-8 enforced;
- collision → 409 `{error, existing}`; `?overwrite=1` replaces (the honest
  re-save flow: SingleFile re-saves get NEW content under the SAME name —
  overwrite is the common case, so the UI pre-checks existence and asks);
- on success: write, invalidate the manifest cache (dir mtime bumps anyway;
  belt+braces explicit invalidation), return the new manifest entry.
- UI: Sidebar header row — an upload button (multi-file picker) + drag-drop
  onto the whole sidebar (overlay highlight). Static mode: the section is
  hidden (no server) — honest.

**Manage** — `DELETE /dom-annotakit-captures/<relpath>`
(**D15 AMENDMENT, session 5: capture DELETE is REMOVED end-to-end** —
user directive 2026-10-27: removal is a git/CLI concern, never a UI click.
The route, the manager `remove()`, the sidebar trash icon and their tests
are gone; the historical design below is kept as the record.):
- moves the file to `<capturesDir>/.annotakit-trash/<epoch>-<basename>`
  (dot-dir = invisible to every scan shape, recoverable by hand);
- 404 unknown; refuses `.annotakit-trash` paths (safeJoin already blocks
  `..` but the trash prefix is explicit);
- manifest cache invalidated explicitly (a trash-dir move does NOT bump the
  captures dir mtime — the mtime cache would serve a stale listing);
- UI: per-row hover delete (trash icon) → confirm shows the capture's thread
  count (from the threads index) + "file moves to .annotakit-trash".
- Rename: deliberately NOT in-app (rename = new identity; the user's
  established workflow is renaming in the file manager — README note).
- The manifest poll: App re-fetches the manifest every 20s (matches the
  status/spec cadence) + immediately after upload/delete; drag-drop of the
  FILE itself into the sidebar reads text content client-side and POSTs
  (no FormData multipart — JSON {name, content} keeps the route testable).

## D13 — SingleFile annotations: hide/unhide + extraction audit

**Display**: replace the load-time STRIP with a load-time HIDE when the
imported flag is set, and add a toggle:
- inject.ts: `opts.hideNoteCards` (new) injects
  `<style data-dom-ak-sf-hide> single-file-note{display:none!important} </style>`
  instead of removing the cards (the strip stays ONLY inside the import flow,
  where the :nth-child correctness invariant demands real removal —
  display:none would still COUNT as a sibling for nth-child and poison
  every captured anchor);
- default state per capture: post-import (strippedFlag) = HIDDEN (the
  user's explicit ask); pre-import = visible; the user's manual toggle
  persists per-capture (`dom-annotakit:sf-visible:<id>`) and overrides the
  default in both directions;
- Toolbar toggle button (only rendered when the capture has ≥1 SF note —
  scanForNotes already counts them): eye/eye-off + label "SF notes";
  toggling flips the style element's disabled state live (no reload);
- the ImportBar offer is unaffected (parse works on display:none cards —
  the shadow DOM is attached regardless).

**Extraction audit** (the "seems questionable" report): live empirical pass
on the annotated corpus (magnific-folder-new-asset-flow-annotated,
magnific-reference-general-annotated, synthetic-annotated) via agent-browser:
- for every note: `doc.querySelector(citeSelector)` vs
  `[data-single-file-note-refs~="<id>"]` — mismatch = the importer pins the
  WRONG element (the fallback selector uses refs; the cite selector is
  SingleFile's own claim — where they disagree, the refs attribute wins as
  ground truth and the parse layer must prefer it);
- visible sanity: matched element's tag/class vs the highlight classes
  (`.single-file-highlight-*`) SingleFile paints on targets;
- bounding-box sanity: the matched element has a real box in-capture;
- dangling/page-level rates per capture — the importer's honest classes.
Fixes land in `src/singlefile/parse.ts` (selector preference) or
`import.ts` (resolution order) per findings; fixtures + the offline suite
encode every found shape.

## D14 — GH sync UX (the "seems broken" report)

Root cause confirmed: the panel's "Sync now" button POSTs the vendored
issues door → the sidecar intercepts with a 403 explaining the disarm → the
user reads an error where the actual sync (the Projects mirror) is green.
The mirror status itself is `ok 13/13` — the UX reports the wrong door.

**Fix**: ReviewPanel (host file, editable) learns the Projects shape:
- serve mode: the GH drawer renders the BOARD section when the spec
  endpoint answers — project title + link, threads/items counts, last sync,
  last error, and "Sync now" → `POST /dom-annotakit-project.json
  {action:'pass'}` (sidecar: forces a reconcile pass, resolves with the
  fresh status; single-flight + debounce semantics preserved — trigger()
  then await chain). The Issues section remains exactly as-is for
  ghAuto:true instances (engine parity);
- the interception stays as the last-resort guard for any other door caller
  (e.g. the static twin), but the panel no longer hits it in serve mode;
- the drawer copy swaps "ONE issue" for the board framing when the board
  shape is active; tooltip surfaces counts identically to the Spec chip;
- static mode: unchanged (client publishing UI is the issues path; the
  projectClient twin keeps its own status surface).

## Test plan

- `scripts/spec-catalog-test.mjs` (NEW): reducer matrix — typeahead filter,
  keyboard nav, create-on-new, story-scoping transitions, clear-on-epic-
  mismatch; rollup merge (board options ∪ thread-derived); pure, fake data.
- `scripts/host-routes-test.mjs` (NEW): upload sanitize/collision/overwrite/
  trash-delete/cache-invalidation against a temp dir + fake manifest hook;
  context PUT + echo; the request-wrap body rewriter (thread create +
  comment add, directive-presence matrix, malformed passthrough).
- `scripts/singlefile-import-test.mjs` (EDIT, allowlisted lines only if
  vendored-row... NOT vendored — singlefile/parse.ts is NEW → free edits):
  extend for the selector-preference fix + every empirical shape found.
- `scripts/project-sync-test.mjs`: extend for listSpecCatalog (fake
  transport) + the pass-trigger route handler shape.
- Live E2E (agent-browser, evidence under .agents-e2e/): combobox keyboard
  walk, filter narrow, context-filed pin → board item, upload → sidebar
  row, delete → trash, SF toggle + hidden-by-default after import,
  extraction-audit report, Sync now → board link.
- Full battery + drift + release-check + bake selftest all green.

## Decision ledger

1. Comboboxes live in the toolbar (not the sidebar): they are cross-capture
   context (filter + filing), not capture-local. Sidebar stays file-only.
2. Context applies at the SERVER seam (comment rewrite) — the composer is
   vendored and untouched; injected lines are visible text (honest record).
3. No eager option creation on "Create <new>" — lazy materialization via the
   reconciler's ensureOptions on first filed thread (no orphan options).
4. Captures default dir = PROJECT ROOT, non-recursive; recursive opt-in with
   denylist. Uploads via JSON (testable), trash-not-unlink deletes.
5. SF cards: hide-style at load (reversible), strip only at import
   (nth-child correctness); per-capture persisted visibility.
6. Panel "Sync now" re-points at the Projects mirror pass; issues UI parity
   retained for ghAuto:true.
7. Canvas pins are NOT filtered (no layer command; sidebar+panel are the
   filter surfaces) — explicit scope line.
8. No bake-script changes (EDIT-locked; explicit --captures keeps its own
   recursive twin; the manifest shape is unchanged).

---

## §9 — Audit fold (2026-10-26, fresh-context adversarial round — ALL findings folded)

**P1-A (D13 reframe — DOM-consistency, not strip-vs-hide).** `:nth-child`
counts TREE position, so hidden (display:none) and visible cards are
ANCHOR-CONSISTENT with each other; only a STRIPPED DOM is a third shape.
New invariant: **cards are ALWAYS in the tree** — import captures anchors on
the hidden-cards DOM (hide-before-capture, never strip), every later load
keeps cards present (hidden by default post-import, toggle flips display
only). The legacy corpus (11 singlefile-* threads captured on stripped
DOMs) gets a ONE-TIME anchor-v2 migration at load: re-resolve each thread
via its note's INDEPENDENT ground truth (`data-single-file-note-refs~=N`,
cite selector as cross-check) → captureAnchorFor on the cards-present DOM
→ PATCH the thread target (ids, comments, board items unchanged) → set
`anchorV2:<captureId>`. User pins (th_*) are NOT migrated (their cssSelector
cannot be re-resolved reliably; textQuote fallbacks stay their safety net) —
documented limitation. parse.ts/import.ts invariant comments rewritten.

**P1-B (D12 security).** With capturesDir = the host root, `/captures/*`
would serve `.env`, `.git/annotakit-dom/threads.db`, package.json through
the public preview. The serve gate: `/captures/<relpath>` admits ONLY
relpaths present in the current manifest build (single source of truth:
non-recursive/dot-skip/denylist/extension rules live in ONE place; unknown
→ 404). Tests: `/captures/.env`, `/captures/.git/...`,
`/captures/package.json` → 404.

**P1-C (D10/D12/D14 wiring).** next.config.ts (host repo) gains rewrites for
`/dom-annotakit-spec.json` (GET+PUT), `/dom-annotakit-captures` (POST),
`/dom-annotakit-captures/:path*` (DELETE); `/dom-annotakit-project.json`
already proxies (POST rides it). All E2E through the preview origin. The
POST/DELETE handlers mount BEFORE serveStatic's 405 gate in standalone.ts.

**P2 folds:** (4) the rewrite wrapper carries `socket` (isLoopbackPeer,
routes.ts:294), re-emits BUFFERED bytes (never re-attaches the consumed
original stream), and enforces the engine's 2MB body cap on pre-load.
(5) context is SERVER-authoritative: the chip follows the 20s echo, the
host re-PUTs the restored context once on boot, last-write-wins across
tabs is documented. (6) recursive denylist = node_modules, .next, dist,
dist-app, build, out, coverage, skills, public, examples, tests, db,
download, upload, src, prisma, mini-services, annotakit (+dot-entries);
the bake twin keeps its own explicit-dir scan (documented divergence).
(7) story→epic edges come from the reconcile pass's existing paged item
read (BoardView.selects carries both fields per item) — zero extra API;
thread-derived edges supersede pass-derived; fields-only options get
epics:[] until a pass lands. (8) default captures dir = process.cwd()
("the directory you started the server in"); the vendored deployment
always sets config so the default never fires there. (9) ⌥E/⌥S forwarded
from the capture document via inject.ts's existing forwarder (typing-guard
included); focus moves into the input on chord-open.

**P3 folds (during implementation):** wrapper/aria additions
(aria-controls, haspopup, Esc→focus-return, labelled chip ×, Tab =
commit-and-continue); story-cleared-on-mismatch gets a visible chip-fade +
live-region announcement; skip context injection for EMPTY comment bodies;
document the PATCH-door + retry-after-context-change idempotency notes;
pending created values join the LOCAL options view (not the endpoint);
delete confirm copy states threads-stay-keyed/restore-by-moving-back;
ImportBar copy updated (hidden, not removed); .gitignore gains
`.annotakit-trash/`; rationale fix (trash move DOES bump source-parent
mtime on POSIX — the explicit invalidation covers coarse-mtime filesystems
and keeps the reason honest).


## §10 — Post-audit decision (extraction audit)

The live audit (`.agents/evidence/2026-10-26-extraction-audit.md`) found
**11/11 real-capture notes with cite == refs == target** (SingleFile writes
the refs-membership selector AS the cite). The "questionable" look was anchor
drift from the old strip-flow (fixed by the D13 invariant + the v2
migration), not extraction. **cite-first with refs-fallback stands** — no
preference flip.
