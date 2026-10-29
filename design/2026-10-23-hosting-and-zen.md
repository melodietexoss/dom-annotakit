# Design decisions — 2026-10-23 session: Next.js preview hosting + maximized zero-chrome review

Scope of this session (user ask): host dom-annotakit behind the sandbox's
Next.js preview so it can be previewed live, with a variety of real captures
(the GenEditor-ui corpus), capture rendering EXACT inside an iframe or not,
and a maximized-viewport review mode with zero UI interference where a
shortcut is enough. Two decisions below, per the design protocol: written →
fresh-context audit → fold → implement.

---

## D4 — Next.js hosting architecture

### Constraints (all verified live this session)

- The sandbox fullstack kit: Next.js 16 App Router project at
  `/home/z/my-project`, dev server AUTO-managed on :3000 (never run it
  ourselves, never `bun run build`), Caddy gateway exposes ONE external port;
  the user only sees the `/` route; `next dev` auto-restarts on next.config
  edits; extra ports follow the "mini services" pattern (we start them in the
  background ourselves).
- The tool: `dist/standalone.cjs` = node:http server owning the whole URL
  surface — `/annotakit/*` (vendored engine REST; boots lazily; loopback
  access gate passes proxied requests because remoteAddress = 127.0.0.1),
  `/captures/*` (CSP-meta-strip streaming serve), `/layer.mjs`,
  `/dom-annotakit-manifest.json`, `/*` SPA fallback to `dist-app/`.
  Knobs: `PORT` (default 4310), `DOM_AK_CAPTURES_DIR`. Store resolves via
  env.ts storeLocation into the git COMMON dir `.git/annotakit-dom/` of
  whatever repo the configDir is inside (checkout/clean-immune), with the
  engine's own orphan-branch durability.
- COPY discipline: the tool must run as the exact built artifact from
  melodietexoss/dom-annotakit-dev@<commit> — no source rewrite, no server
  re-implementation. The Next layer is a harness, not a fork.

### Options weighed

1. **Native port** — re-express each engine endpoint as Next.js API routes
   importing the vendored server modules. REJECTED: ~10 glue routes must
   re-implement the streaming CSP-strip + headers byte-exactly; every ported
   route re-earns the ~100-round hardening; HMR restarts multiply processes
   against one SQLite file; drift risk for zero user-visible gain.
2. **Static bake only** — serve the baked static mode through Next. REJECTED
   for the primary preview: the bake's store is browser-localStorage (per
   browser), losing the server SQLite store + REST parity that the user's
   workflow exercises.
3. **Spawn + proxy (CHOSEN)** — Next.js owns :3000; the tool server runs
   untouched on :4310; Next rewrites map the tool's URL surface onto :4310.
   The tool runs EXACTLY as smoke-tested (same process, same CWD semantics,
   same bytes), the browser sees one same-origin, and Next glue is ~40 lines
   of config.

### Decision D4 (the shape)

- **Vendor the built tool** at `/home/z/my-project/annotakit/`:
  `dist/`, `dist-app/`, `.dom-annotakit/` (configDir the engine creates),
  `captures/` (the corpus), `UPSTREAM-COMMIT` (records the tool repo commit
  the build came from). Source of truth for the tool stays
  melodietexoss/dom-annotakit-dev; the vendored dir is a release artifact,
  refreshed by `bun run build` + copy.
- **Captures**: all 30 GenEditor-ui captures, ORIGINAL filenames (capture ids
  derive from relpath — identical filenames keep the restored dogfood store's
  thread keys valid). ~216 MB, largest file 66 MB (< GitHub's 100 MB hard
  limit). They are tracked in the next-host repo (git-is-disk; a fresh sandbox
  restores the full preview from ONE clone). A seed script can refresh from
  GenEditor-ui later.
- **Store seeding**: extract `threads.db` from the tool repo's
  `annotakit-dom` orphan branch (survives in the /home/sync backup copy; never
  made it to origin — that gap gets fixed this session by pushing the branch)
  and place it at `/home/z/my-project/.git/annotakit-dom/threads.db`. The
  engine then opens it in place; ids match the hosted filenames.
- **Spawn ownership**: `instrumentation.ts` `register()` — idempotent
  (GET http://127.0.0.1:4310/annotakit/api/health first; spawn only if down),
  spawn `node annotakit/dist/standalone.cjs` with
  `PORT=4310 DOM_AK_CAPTURES_DIR=<abs>/annotakit/captures`, cwd
  `/home/z/my-project/annotakit`, stdout/err → `annotakit/server.log`,
  detached so it survives dev-server restarts; re-armed automatically at
  every dev-server boot. PLUS an immediate manual nohup spawn for the already
  running dev server (the instrumentation covers future restarts).
- **No GH mirror in the preview**: the hosted `.env` ships NO
  ANNOTAKIT_GH_TOKEN — engine runs store + git durability only. The live
  mirror walk is next-session scope (HANDOFF) against a scratch mirror repo;
  the preview must never spam the tool repo's issue stream by accident.
- **next.config rewrites (beforeFiles)**, the tool's exact surface:
  `/` → `http://127.0.0.1:4310/` (the SPA; the user's `/` IS the tool),
  `/annotakit/:path*`, `/captures/:path*`, `/layer.mjs`,
  `/dom-annotakit-manifest.json`, `/assets/:path*` (the Vite build's hashed
  assets; verified against dist-app/index.html refs at wiring time).
  Next keeps `/_next/*` and everything else. The scaffold `src/app/page.tsx`
  stays as a non-user-visible fallback.
- **Durability**: my-project git → new repo `dom-annotakit-next`
  (GH melodietexoss + GL mirror under the OTHER username + /home/sync copy).
  Commit every micro step. The store DB lives in `.git/annotakit-dom/`
  (outside the worktree) — the engine's orphan-branch snapshots make IT
  durable in the next-host repo; document the restore path.

### D4 risks to verify in E2E (not desk-check)

- Proxy streaming of a 66 MB capture (Content-Length preserved; CSP strip
  still seen via X-Dom-Anotakit-Csp-Stripped).
- Same-origin iframe through the proxy: `/captures/x.html` resolves to the
  preview origin → layer injection + `__domAnnotakit` probe land.
- HMR/config restart re-runs register() → exactly one tool server (health
  check wins).
- The engine's loopback gate + the manifest + 5s poll all pass through the
  rewrite chain (health shows `store: sqlite`, sidebar lists all captures).

---

## D5 — Maximized zero-chrome review mode ("zen")

### Requirement (user, verbatim intent)

"your ui should have zero interference with the actual ui, no ui / toolbar
etc. is okay just shortcut is enough when entering the review in maximized
viewport mode. overall layout can be similar to storybook though or whatever
you see that works best."

Parse: in maximized-viewport review mode the host chrome (sidebar, toolbar,
bars) is ABSENT — the capture alone fills the viewport, rendering exactly as
it would standalone; every review action remains reachable by keyboard; the
normal browse shell stays Storybook-like (it already is: sidebar + canvas +
drawer).

### What already holds (no work needed)

- The review loop is fully chord-driven (vendored kernel, alt-family,
  collision-free vs SB 9/10): ⌥C pin · ⌥B region · ⌥I freeze · ⌥L layer
  visibility · ⌥P threads panel (host bridge + the layer's in-canvas
  TOGGLE_THREADS_PANEL path) · ? help. All work with focus INSIDE the iframe
  (the layer binds on the iframe document) — "shortcut is enough" is native.
- Scrolling contract: the host never scrolls; the iframe already fills its
  container; in zen the container becomes the full viewport, so the capture
  renders at true standalone media-query parity (the exactness the user
  asks for).

### Decision D5 (the shape)

- **Chord**: ⌥Z (`alt+z` — 'z' zen; outside SB 9/10's collision set and our
  defaults; matched via the vendored hotkeyMatches: physical e.code, alt
  required, never with ⌘/Ctrl, isTypingTarget-guarded, `!e.repeat` like the
  drawer bridge). Same chord toggles in and out.
- **Two-document binding, zero double-fire** (the upstream bridge discipline):
  host-document keydown in App (mirrors PanelDrawer's ⌥P bridge) + an
  iframe-document keydown listener added in inject.ts's onLoad (host-context
  listener on the capture's document, same lifecycle as the navigation guard
  — dies with the document, re-armed every load) that recognizes ⌥Z and calls
  a new `InjectOptions.onHostKey?.('zen')` callback (same-origin direct call;
  no postMessage needed). inject.ts is COPY-MAP REPLACE scope (index.ts →
  this module) — the layer itself is untouched.
- **What hides in zen**: Sidebar, Toolbar, ImportBar (all chrome). What
  STAYS: the away/inject-failed alert bars (honest failure surfacing —
  they only render on failure and carry the Reload button) and the pins/
  layer inside the capture (the review content). The PanelDrawer is
  force-closed on zen entry (prior open state remembered, restored on exit);
  ⌥P still opens it during zen — the panel is on-demand review content, not
  chrome.
- **No Esc binding for zen exit** (deliberate): Esc inside the iframe belongs
  to the vendored layer's escalation ladder (armed-cancel → freeze-exit →
  composer-close); the vendored ReviewPanel may hold its own host-doc Esc
  uses. One unambiguous chord (⌥Z) + one obvious button beats a shared Esc.
- **Toolbar button parity**: the normal-mode Toolbar gains a 6th button
  (zen icon, title "Maximized review (⌥Z) — hide all UI, review in full
  viewport") — upstream's every-action-has-a-button discipline, an E2E door,
  and discoverability for non-keyboard users. It is invisible in zen (the
  toolbar is hidden) so it never interferes.
- **Transient hint on entry** (upstream freeze-hint pattern): bottom-right
  pointer-events:none toast "Maximized review — ⌥Z exits · pins live",
  auto-fade ~2.5 s, host-layer stacking (separate context from the capture's
  pins). Not persistent chrome.
- **Deep link**: `?zen=1` honored at boot (kept via the same
  history.replaceState discipline as `?capture=`), so a maximized review
  session survives reload; the URL IS the persistence (no localStorage).
  Exports' `?capture=` links are NOT modified (server export code is
  vendored/COPY-MAP scope — not worth an edit site).
- **Zen is per-review-session state**, not sticky across captures: switching
  captures (sidebar) is impossible while zen (by design — you maximize to
  review ONE capture); reload keeps it via the URL param.

### D5 edge cases (fold list for the audit to check)

- ⌥Z in a reply textarea (panel open in zen): isTypingTarget blocks ✓.
- Armed pin (⌥C) then ⌥Z: arming survives — the layer's cursor class stays,
  click → composer (inside the iframe) works chrome-free; intended.
- ⌥Z repeat-hold: `!e.repeat` mirrors the drawer bridge.
- Nested iframes inside a capture: keydowns there don't bubble to the
  capture's root document — same inherited limitation as the layer's own
  hotkeys (rare in SingleFile captures; accepted).
- Capture switch / reload during zen: the forwarder dies with the document
  and is re-armed by the next load (inject.ts lifecycle); zen host state
  persists across the reload (state + URL param).
- E2E: synthetic KeyboardEvent dispatches are isTrusted=false → the bridges
  ignore them (single-source discipline); drive the button click, or use
  the browser's real trusted-key path.
- Drift-check must stay CLEAN: App.tsx (host shell, out of drift scope),
  inject.ts (REPLACE row), Toolbar.tsx (host port of the SB tool component —
  COPY-MAP manager row is EDIT... verify before editing: the toolbar is
  listed as a port; its diff must not need a new COPY-MAP edit site beyond
  what exists — if it does, the row gets a new allowlisted edit site with
  justification, per protocol).

### Verification gates (this session)

`bun run typecheck` · `bun run build` · `npm run test:drift` CLEAN ·
`node scripts/s6-unit-test.mjs` 49 · `node scripts/release-check.mjs` CLEAN ·
browser E2E on the preview: zen toggle (button + trusted chord if
producible), pin-in-zen loop, panel ⌥P in zen, hint fade, exact-render
comparison (zen iframe at viewport W×H vs the same capture served raw and
screenshotted at W×H — pixel-identical modulo pins we placed), imports and
exports still green.

---

## Audit round 1 (fresh-context agent, Task 2-a) — verdicts + folds

**D4: APPROVE · D5: APPROVE.** Every load-bearing claim was verified against
live code (gate semantics, store path, seeding sufficiency, rewrite
completeness 30/30 ids unique, ⌥Z collision-free, two-document binding).
Folded findings:

- **P1-1 (folded)**: store durability for the next-host repo — every
  micro-step push is `git push origin main annotakit-dom` (the engine's
  orphan-branch snapshot is local-only until pushed; a fresh sandbox restores
  threads.db ONLY from `origin/annotakit-dom`:
  `git show origin/annotakit-dom:threads.db > .git/annotakit-dom/threads.db`).
- **P2-1 (folded)**: `synthetic-annotated.html` (tool fixture) seeded as the
  31st capture — 5 of the 10 restored threads are keyed to it.
- **P2-2 (decided)**: server-minted absolute export/digest links carry
  `http://localhost:4310` — ACCEPTED for v0.1 (exports readable; deep links
  dead remotely). Future: an origin-override knob would need a COPY-MAP edit
  site. Recorded in HANDOFF.
- **P2-3 (folded)**: zen must never remount the iframe subtree — implemented
  as conditional siblings only (Sidebar/Toolbar/ImportBar unmount around the
  main column; the iframe's React position is unchanged).
- **P2-4 (folded)**: panel force-close is ONE-SHOT at zen entry (remember +
  setPanelOpen(false) + restore on exit), never a derived
  `open={zen ? false : panelOpen}` prop — the derived form silently eats the
  in-zen ⌥P reopen.
- **P2-5 (folded)**: the E2E pixel-parity gate runs panel-closed.
- **P3s (folded)**: TCP port probe (not HTTP health) for the spawn doors —
  the engine boots lazily and a slow-but-alive listener must read as UP;
  `?zen=1` is STRIPPED on ⌥Z exit (replaceState, symmetric with entry);
  "capture switching is impossible in zen" was WRONG (panel rows switch via
  selectCaptureIfKnown and zen survives — the emergent behavior is good, keep
  it); zen E2E drives the toolbar button (synthetic chords are
  isTrusted-refused); the vendored-tree commit is atomic against the ~20s
  force-checkout window; favicon 404 accepted (cosmetic).
- **P3-7 (good news)**: `src/host/**` is OUT_OF_SCOPE in drift-check — no
  COPY-MAP edit site needed for App/Toolbar/inject zen changes. Verified:
  drift-check CLEAN after implementation.

Post-fold gates (all green): typecheck clean · build ok · drift-check CLEAN ·
s6 49/0 · release-check CLEAN.
