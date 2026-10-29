# COPY-MAP — vendored files from storybook-annotakit-dev

Upstream pin: `melodietexoss/storybook-annotakit-dev` @ **2853e32** (v0.6.16)
— recorded in the `UPSTREAM` file; `scripts/drift-check.mjs` re-diffs vendored
files against the pin and fails on unlisted deltas.

Rule: **COPY EXACTLY** — ~100 hardening rounds live in that code. Every
deviation is surgical, listed here with justification and upstream file:line
evidence, and diffable. Upstream fixes cherry-pick through this map (re-diff
the file, re-apply only the listed edits).

Legend: AS-IS = byte-identical (import paths may be re-pathed only);
EDIT = copied + listed surgical edits; REPLACE = new code replacing an
SB-bound module; SKIP = intentionally not vendored.

## src/shared/

| upstream file | verdict | edits (upstream line refs) |
|---|---|---|
| `types.ts` | EDIT (3 additive lines) | extend `Comment.source` with `'singlefile'` (L233); add optional `TargetContext.singleFileNoteRef?: string` + `TargetContext.singleFileDangling?: boolean` (L154–179). ADDITIVE only — merge-safe (spread merges carry extra context fields; validateTargetShape requires only `context.tag`, routes.ts:541) |
| `metaline.ts` | AS-IS | none |
| `describe.ts` | AS-IS | none |
| `cascade.ts` | AS-IS | none (pure; s6-pinned) |
| `hotkeys.ts` | AS-IS | none |
| `recall.ts` | AS-IS | none |
| `events.ts` | **AS-IS** (crit-1b flip) | pure constants imported by routes.ts:36, sync.ts:36, api.ts:7, layer.tsx, manager — the TRANSPORT (SB WS) is replaced by `src/host/channel.ts` implementing the same names/payloads; event names never duplicated elsewhere (grep-verified) |
| `staticStore.ts` | EDIT | (1) label strings story→capture (L720, 817–820); (2) co-vendor `server/merge.ts` (import at L38) — scope edit DROPPED (crit-1a verified parent-anchored scope works unchanged) |
| `ghClient.ts` | EDIT | (1) `DEFAULT_LABEL` 'annotakit' → 'dom-annotakit' (L54); (2) `?path=/story/` deep-link → `?capture=` (L627); (3) "storybook (static deployment)" + "in Storybook" notices + panel-copy → host wording (L212, 631, 652, 707, 711, 1173, 1307); (4) footer agent-instructions reworded for capture reviews (L640). Engine semantics unchanged |
| `mode.ts` | EDIT | add `window.__DOM_AK_APP_BASE__` (host-injected build constant) as the FIRST health candidate (crit-1a P2-9; subpath deployments otherwise degrade to read-only 'down') |
| `panelToggle.ts` | AS-IS | none (manager uses it at :1551/1612/1664; host shim trivial) |
| `legacyMirror.ts` | **AS-IS** (crit-1b flip) | live importers: ghsync.ts:56, routes.ts:1544, ghClient.ts:42 (mirror self-heal paths) — SKIP = build break or silent self-heal removal; inert for new repos (legacy candidates never byte-match) |

## src/preview/

| upstream file | verdict | edits |
|---|---|---|
| `anchor.ts` | EDIT (1 line) | className exclusion += `/^single-file-/` (finder filter L116 — highlight classes would embed into css selectors and break on re-save; tested) |
| `hittest.ts` | AS-IS | none |
| `styles.ts` | EDIT (1 line) | `.annota-root` z-index → `2147483647` (SingleFile cards paint at 2147483646 — review wins the z-war; crit-1a P2-6) |
| `snapshot.ts` | EDIT | (1) drop SB portal-sweep selectors (`sb-*`, `#storybook-docs`, `#storybook-highlights-root`, `data-sb-error`); (2) scroll-root recalibration for iframe; (3) frozen-veil z → `2147483646` (L204 cssText — crit-2 correction: lives here, NOT styles.ts); (4) per-pin capture OFF in v0.1 — `sanitizeMountedView` kept for freeze/recall |
| `layer.tsx` | EDIT | the SEVEN surgical points (crit-1a + crit-2): `addons.getChannel` (L19/74) → injected channel; `storyRoot()` (L97) → captured page root; `buildStoryRef` (L23/1412) → `getSnapshotMeta`; `inspectComponent/correctSource` → null stub (already a supported layer state); **pin-render filter** — skip threads carrying `TargetContext.singleFileDangling` from the PIN path only (panel unaffected; the layer PULLS via dataRef.list L460/562 — host-side filtering impossible, crit-2 P1); **freeze gate** — `freezeEnabled` option honored at ALL freeze entries (hotkey + UI_COMMAND + internal calls; upstream refuses only when `frozenView===false`); **apiOk hint copy (M6)** — the 4 `no store` hints (upstream L896/1118/1419/1424) instruct `storybook dev`; reworded to this tool's commands (`npm run serve` / `npm run bake`) per the recorded decision (copy that INSTRUCTS SB commands is reworded). All pin/composer/freeze/recall/cascade logic otherwise unchanged |
| `api.ts` | EDIT (zero-delta today) | API base `/annotakit/api` unchanged; static branch unchanged; envelope code unchanged — the listed review found NO change needed: the file is byte-identical to upstream (drift-check enforces identity) |
| `story-meta.ts` | REPLACE | → `src/host/snapshot-meta.ts` (`getSnapshotMeta(captureId)` from manifest; MUST mint `story.url` = capture view so `?path=/story/` fallbacks never fire — precedent story-meta.ts:79) |
| `fiber.ts` | REPLACE | → null stub (`inspectComponent = () => null`) |
| `index.ts` | REPLACE | SB decorator → `src/host/inject.ts` (iframe layer injection: `<script type="module" src="/layer.mjs">` after load + navigation guard + load-guard) |

## session-4 NEW files (D10-D14, 2026-10-26 — all OUT_OF_SCOPE in drift-check)

- `src/shared/specCatalog.ts` — NEW — the pure spec-catalog module: combobox
  reducer (typeahead/keyboard/create-on-new), the D11 two-level filter model,
  rollups + board merge, the compose-context text transform. Suites:
  spec-catalog 40, host-routes, App wiring.
- `src/host/specBox.tsx` — NEW — the Epic/Story combobox DOM/a11y skin + the
  spec-endpoint hook (catalog poll, context echo-adopt, boot re-PUT,
  pending-create values).
- `src/server/hostRoutes.ts` — NEW — the D12-D14 REST seam: captures manager
  (scan + manifest cache w/ content fingerprint, the §9 P1-B SERVE GATE,
  upload w/ id-collision 409 + git durability, trash/git-rm removes), spec
  catalog/context endpoints, the forced-mirror-pass route, the D10 annotation
  rewrite wrapper (buffered re-emit, socket preserved, engine cap parity).
  Suite: host-routes 34.
- `src/shared/ghProjects.ts` — NEW (additive) — ReconcileResult.catalog +
  boardCatalog() (options + pass edges, zero extra API).
- `src/server/projectMirror.ts` — NEW (additive) — mirror.catalog() cache +
  status.issuesDisarmed.
- `src/singlefile/parse.ts` — NEW (D13 helpers) — hide/visible style helpers
  (BODY-END cascade — SingleFile ships `single-file-note{display:contents
  !important}` and author-origin !important is document-ordered); the strip
  helper is legacy-unused (kept for the bake's raw-shape docs + suite).
- `src/host/inject.ts` — host EDIT — hideNoteCards load path + ⌥E/⌥S capture
  -doc forwarder.
- `src/host/import.ts` — host EDIT — D13 capture-on-hidden-DOM + the anchor-v2
  legacy migration (refs ground truth; static door = store.patch — audit P1).
- Toolbar/Sidebar/App/PanelDrawer/panel/ReviewPanel/ImportBar — host EDITs —
  the comboboxes, filter + manage UX, the D14 board drawer (issues detail
  folded under issuesDisarmed), copy truth sweeps.

## src/server/ (zero SB imports — grep-verified; wholesale)

| upstream file | verdict | edits |
|---|---|---|
| `routes.ts` | EDIT (4 lines) | (1) `GH_LABEL = 'annotakit'` → `'dom-annotakit'` (L45; feeds /health githubLabel + resolveGhLabels fallback); (2) `groupByStory` fallback `?path=/story/` → `${origin}/?capture=${storyId}` (L670); (3) `/schema` example + notes copy story→capture (L475–492, 740, 745; the example's `component` also becomes `null` — captures have no live component tree — and its story slots carry capture metadata); (4) `VERSION = '0.6.16'` → `'0.1.0'` (L40 — THIS tool's version identity, matching package.json; /health reports it and release-check gates pkg↔routes↔dist agreement). REST semantics unchanged (409 tombstone finality, replay flags, PATCH merge, comment-id re-hash) |
| `store.ts` | AS-IS | none |
| `ghsync.ts` | EDIT (1 line) | `labelsOf` fallback `'annotakit'` → `'dom-annotakit'` (L121) |
| `sync.ts` | EDIT (2 sites) | (a) `BRANCH_PRIMARY 'annotakit'` → `'annotakit-dom'`, fallback `'annotakit-store'` → `'annotakit-dom-store'` (L106-107) — dual-kit isolation (crit-1b P1-1). Store marker line stays (same vendor lineage; branch name separates adoption). (b) **s6 fallback-parenting fix** (upstream bug, same code): `fetchRemote` returns `{sha, ref}` — the head sha AND the ref that supplied it (fresh fetch → cache ref; offline fallback → cached head's ref incl. the origin tracking ref); every A14 classification gate (`syncOnce` parent gate, restore adoption, C17 fallback, A4.5 re-fetch) reads the kind off THAT ref instead of the hard-coded `REMOTE_CACHE_REF`. Old shape: private-repo no-token → fetch fails → head from `refs/remotes/origin/<branch>` → gate reads the absent cache ref → `'no-readme'` → parent nulled → every snapshot a parentless root → non-FF pushes forever. Upstream issue **#21 filed** (see `.agents/upstream-issues/2026-10-29-sync-fallback-parenting.md`). |
| `merge.ts` | AS-IS | none (the lattice; staticStore's hidden dep at L38) |
| `digest.ts` | EDIT | group labels story→capture (L84, 168, 173, 183, 186–187) + footer agent-instructions reworded for capture reviews (L233–237). JSON export KEY `stories` STAYS (wire contract, routes.ts:1294) |
| `env.ts` | EDIT (1 line) | `storeLocation` git-dir join → `annotakit-dom` (L373) — dual-kit isolation. NO label edit (env has none — crit-1b correction) |
| `gh.ts` | AS-IS | none (GH_SENTINEL stays — engine identity, not label-scoped) |
| (new) `src/server/standalone.ts` | NEW | http.createServer: createMiddleware at origin root + static serving (app build, captures dir, /layer.mjs) + `serverChannelHook(host emitter)` (live updates; v0.1 = host poll transport) + explicit configDir `<repoRoot>/.dom-annotakit` + real port via devServerHook shape (bootstrap not exported; port-correct boot — issue links mint from boot origin) |

## src/manager/

| upstream file | verdict | edits |
|---|---|---|
| `index.tsx` | EDIT → `src/host/panel/` | substitutions: `addons.getChannel` (L356/400/419/447/1484) → host channel + 5s poll→emit THREADS_CHANGED; `useStorybookApi` (L183/1515) → host callbacks; `useStorybookState` → local state (storyId=captureId, drawer, dock height); `useTheme` → literal theme object (dual-shape resolution has hardcoded fallbacks); `@storybook/icons` (L19) → inline SVGs; SB registration shape (L1709–1724) → host panel mount; down-state copy (L1132) + empty-state copy (L1147–1151) → host wording; `SORT_KEY` default `'story'` → `'recent'`-equivalent for captures; `types` import (L17) retained. `AUTHOR_KEY`/`SORT_KEY` global keys kept (benign, documented). Panel logic (filters, sort, replies, verdicts, exports, sync dots, DETACHED chip) unchanged |

## scripts/

| upstream script | verdict | edits |
|---|---|---|
| `s6-unit-test.mjs` | AS-IS | none |
| `ghclient-test.mjs` | EDIT (M6 truth) | expectation renames ONLY for the ghClient.ts copy edits: 3 notice assertions `'in Storybook'` → `'in the review app'` — no test logic |
| `static-store-test.mjs` | AS-IS | none |
| `lattice-test.mjs` | AS-IS | none |
| `ghsync-fake.mjs` | EDIT (M6 truth) | F13 digest origin-line expectation `'storybook:'` → `'review app:'` — rename for the digest.ts copy edit; the legacy-candidate assertion INTENTIONALLY unchanged (legacy mirrors keep the legacy format) |
| `store-robust.mjs` | EDIT (M6 truth) | branch-name expectation renames for the sync.ts edit: `refs/heads/annotakit` → `annotakit-dom`, fallback `annotakit-store` → `annotakit-dom-store`, store dir `annotakit` → `annotakit-dom` — constant renames only, no test logic; marker line `'annotakit-store: v1'`, legacy `<configDir>/annotakit` migration dir, `REMOTE_CACHE_REF`, `'zero annotakit commits on main'` unchanged BY DESIGN |
| `store-robust-server.mjs` | AS-IS (M6 truth) | vendored VERBATIM (M2b) — spawned per instance by store-robust.mjs, zero SB deps, zero edits; was missing from this table at M2 |
| `heal-mirrors.mjs` | EDIT | (1) default `--labels 'annotakit'` → `'dom-annotakit'` (L66); (2) its usage-doc line (L42) — doc truth for (1) |
| `bake-static-threads.mjs` | EDIT | (1) default label `'annotakit'` → `'dom-annotakit'` (L327); (2) REQUIRE `--store` (drop cwd-git-discovery from the ladder — L341–350; the tool-repo store is the documented default). The manifest builder + ref-shape gate from the design draft moved to the NEW bake-dom-annotakit.mjs below (the dom bake targets the Vite app build, not an SB build) 
| (new) `bake-dom-annotakit.mjs` | NEW (M5; the vendored bake's seed/gh semantics REUSED, not reinvented) | the dom-annotakit static bake: seed `annotakit-threads.json` (zombie suppression + tombstones — vendored), `annotakit-gh.json` (vendored resolution order, stale removal, label default), `dom-annotakit-manifest.json` (the server route's shape + ADVISORY noteCount), app build copy + relative-refs-only gate (the Vite `base:'./'` equivalent of the SB ref-shape gate), `layer.mjs`, `captures/*` through the serveCapture-twin streaming CSP-meta strip (note cards NEVER stripped), `--base` subpath injection; `--selftest` 56 probes |
| `release-check.mjs` | REWRITTEN (M6 truth — re-target wholesale) | this repo's layout/gates: 6 gates (dist ghost-chunk, version agreement pkg↔routes, dist freshness incl. bump-without-rebuild, dist exact-set byte-identical, dist-app relative-refs, sensitive sweep) + 10 selftest plants; out of drift-check hunk scope |
| `api-test.mjs` | EDIT | target the standalone server (default :4310) |
| `serve-demo-3000.py`, `stage-release.mjs` | SKIP (M6 truth) | SB demo server / public-release staging pipeline — no dom-annotakit twin |
| `serve-static.py` / `detach-run.py` | AS-IS | none |
| `stress-live.mjs` | SKIP → PLAN | SB-shaped; adapt later |
| (new) `singlefile-import-test.mjs` | NEW | Node fixtures (template.content shape): parse, multi-ref, dangling, root-target, recycle, tombstone-replay; + REAL capture browser E2E (shadowRoot shape) — BOTH mandatory (jsdom masks live-parse shadow attach) |
| ~~`manifest-test.mjs`~~ | FOLDED (M6 truth) | never a separate file — collision loud-fail lives in standalone.ts's manifest route, provenance extraction in the same route + bake, id sanitization in host/capture-id.ts; covered by api-test + the E2E |
| (new) `drift-check.mjs` | NEW | vendored files vs `UPSTREAM` pin; fail on deltas beyond each file's listed edits |
| (new) `gh-projects-recon.mjs`, `gh-projects-probe.mjs` | NEW (D6) | live GH Projects v2 API recon/mutating probes (P0-P11; documented in .agents/kb/gh-projects-api.md) — recon is read-only, the probe creates + deletes a throwaway project and cleans up (`--cleanup-probes`) |
| (new) `gh-projects-bootstrap.mjs` | NEW (D6) | idempotent creator/completer of the "dom-annotakit — UI Spec" board (fields + view; GH requires >=1 option at SINGLE_SELECT creation — the inert 'General' seed) |
| (new) `project-sync-test.mjs` | NEW (D6) | offline fake-transport suite (37 checks): directive parser table, create/update/delete convergence, evidence-gated deletes, duplicate culling, >100-item paging, human-item immunity, hostile-id refusal, option-append preservation, single-flight pin |
| (new) `bakedCreds.ts`, `specDirectives.ts`, `ghProjects.ts` (src/shared) + `projectMirror.ts` (src/server) + `projectClient.ts`, `projectStatus.ts` (src/host) | NEW (D6) | the GH Projects spec mirror: user-instructed baked PAT (release-check exact-path allowlist + dist-app inverse gate enforce the boundary), @epic:/@story: parser, isomorphic stateless reconciler, serve sidecar (store-singleton + evidence-gated deletes + single-flight + coalesced triggers), static twin (probeMode-gated), chip status shape — zero vendored-file edits |

## build

| upstream | verdict | edits |
|---|---|---|
| `tsup.config.ts` | REWRITTEN (M6 truth — upstream twin superseded) | outputs: `dist/layer.mjs` (self-contained ESM iframe bundle — `<script type="module">`), `dist/server.cjs` (as upstream), the node test battery entries, host app via Vite (`dist-app/`, `base:'./'`); out of drift-check hunk scope |
| `package.json` | NEW | name `dom-annotakit`; deps: react/react-dom ^19, @medv/finder, tsup, typescript, vite |

## Decisions recorded once (never ad-hoc)

- (2026-10-23, D6 — user instruction) **The GH PAT is BAKED** in
  `src/shared/bakedCreds.ts` (deliberate, private repos, after the sandbox's
  constant .env sweeping left deployments tokenless). release-check's sensitive
  sweep allowlists exactly `src/shared/bakedCreds.ts` + `dist/server.cjs` +
  `dist/standalone.cjs`; the INVERSE gate holds dist-app to ZERO `ghp_`
  matches. Do NOT "fix" the token out of these files; a public-release
  transform (M8) scrubs + untracks them.
- (2026-10-23, D6) **This kit's default sync target is the GH Projects spec
  board** (per-instance `annotakit.config.json` `project.target`; the issues
  mirror stays SB-parity code, opted back in via `ghAuto:true` + ghRepo). The
  vendored POST /sync + POST /gh doors are intercepted at standalone when
  `ghAuto:false` (they arm on configured(), NOT enabled() — audit P1-2).
- (2026-10-23, D6) **Board deep links** mint from `project.publicUrl` (config)
  — Next rewrites forward Host: 127.0.0.1:4310, so the public origin is
  invisible to server-side tracking in the preview shape.

- User-facing "storybook" strings in vendored server code (console prefixes,
  sync README prose): ACCEPTED as provenance. Only copy that INSTRUCTS SB
  commands gets reworded (manager down-state — inside the manager EDIT).
- `ANNOTAKIT_*` env names unchanged. Per-kit GH config: each kit's own
  `annotakit.config.json` or process env (config beats env).
- Iframe probe costs one wasted 404 per probe (candidate order) — harmless,
  documented, DO NOT "fix".
- `.env` tracked (git-is-disk); `ANNOTAKIT_ENV_TRACKED_OK=1` silences the
  upstream refusal.
