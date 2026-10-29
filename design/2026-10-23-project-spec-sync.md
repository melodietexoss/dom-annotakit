# Design — session 3 (2026-10-23): GH Project spec sync + shell polish

D6 project spec sync · D7 filename display · D8 sidebar sorting · D9 dark mode · config/credential fix

Written after the live API recon (commit 4935780, probes P0–P11 ALL PASS). Fresh-context audit
required before implementation; findings fold back here.

## 0. The user's asks (verbatim intent)

1. **"instead of Issues can we sync these as ui spec or features stories to GH Projects"** —
   sync target changes from repo issues to a **Projects (v2)** board; grouped by **epic /
   story** so the board reads as a *living spec*; the DOM anchor + annotation are the spec
   directives. Comments may carry `@epic:` / `@story:` to organize. Users can configure
   which project to sync. Create the project ("similar to
   github.com/users/melodietexoss/projects/1, or whatever fits best" — all three existing
   projects are untitled skeletons, so we create a proper one).
2. **"you are mixing file name and title, don't do that. always use filename (but remove
   .html)"** — display identity = filename minus extension, everywhere; the page `<title>`
   never displays (users organize captures by renaming files).
3. **"the list can sort by name or date, asc or desc"** — sidebar sort control.
4. **"add dark mode"**.
5. **"annotakit is NOT configured correctly right now (cannot sync to GH) local mode only.
   make sure you do it correctly the credential can be baked in, and note your local .env get
   sweeped constantly"** — real credentials, baked into the repo (not `.env`), sync working
   out of the box.

## 1. Root cause of "local mode only" (verified live)

- No `annotakit.config.json` exists anywhere; no `.env` (swept by the sandbox). The engine
  therefore runs on bare git-remote detection (`dom-annotakit-next` — correct) with **no
  token** → (a) ghsync (issues) unarmed, (b) **`sync.ts` git-durability pushes fail**
  ("no ANNOTAKIT_GH_TOKEN in .env?", sync.ts:857 → "orphan branch updated locally
  (no remote to push)"). Both GH surfaces dead; store durability survived session 2 only via
  the manual `store-push.sh` ritual.
- Fix: bake the melodietexoss PAT in NEW code (`src/shared/bakedCreds.ts`, user-authorized)
  AND make it available to `sync.ts` pushes. `ghToken()` (vendored env.ts) reads
  `ANNOTAKIT_GH_TOKEN` only — we set that env var at process boot **from the baked constant**
  inside standalone.ts (NEW code, line before `devServerHook`), so every vendored consumer
  (sync.ts push/fetch, ghsync, reloadDotEnv) sees a token with ZERO vendored edits. Shell env
  and `.env` still win (they run first / fill-first semantics unchanged).
- **Issue-spam guard**: with a token present, the OLD issues engine would arm against the
  detected repo. The user asked for Projects *instead of* Issues → the per-instance
  `annotakit.config.json` sets `"ghAuto": false` (the documented, vendored-supported knob:
  routes.ts:194 `config.ghAuto !== false`). Issues mirror stays available for anyone who
  opts in (SB parity code untouched); this deployment defaults to Projects.

## 2. D6 — project spec sync (the new mirror)

### 2.1 Architecture: stateless reconciler sidecar, zero vendored edits

Same discipline as D3/D5: the vendored engine is never touched. All new code:

| new file | role |
|---|---|
| `src/shared/bakedCreds.ts` | the baked PAT + default project target (user-authorized) |
| `src/shared/specDirectives.ts` | `@epic:` / `@story:` parsing (pure, isomorphic) |
| `src/shared/ghProjects.ts` | isomorphic Projects-v2 GraphQL client + **reconcile()** (fetch-based; Node 24 + browsers) |
| `src/server/projectMirror.ts` | serve-mode sidecar: config load, engine REST poll, channel listener, debounce, status endpoint |
| `src/host/projectClient.ts` | static-mode browser twin: localStorage threads, annotakit-gh.json probe |
| `scripts/gh-projects-bootstrap.mjs` | idempotent creation of the real UI-Spec project (+ fields + view) |

Wiring (both NEW-code seams):
- **serve**: `standalone.ts` imports the sidecar. Events: `channel.on(THREADS_CHANGED)` →
  5s debounce → reconcile. Boot: after first engine REST reachability, reconcile once.
  Hourly sweep. Status: `GET /dom-annotakit-project.json` served by standalone's static
  router (NEW route in NEW file) → the host toolbar chip polls it.
- **static**: `main.tsx` imports `projectClient.ts`; it arms only when the engine REST is
  unreachable (the static shape probe — mode.ts semantics) and reads the baked
  `annotakit-gh.json` **extended** with a `project` section (the bake writes it).

### 2.2 The reconcile (stateless, marker-anchored, delete-wins)

No local mapping table AT ALL. Every pass:

1. **read local truth**: serve → `GET /annotakit/api/threads` (all captures); static →
   staticStore threads.
2. **read project truth**: `node(project){ items(first:100) }` — parse each draft body's
   marker `<!-- dom-annotakit:thread=<id> -->` → map threadId → {itemId, body, title,
   fieldValues}. Items WITHOUT our marker are **never touched** (the user's own board items).
3. **diff → converge**:
   - thread, no item → `addProjectV2DraftIssue` + set fields;
   - thread, item drifted (desired title/body/fields ≠ current) → `updateProjectV2DraftIssue`
     + field updates (idempotent — no write when equal);
   - item, thread gone (deleted/tombstoned) → `deleteProjectV2Item` — delete-wins, same
     semantics as the issues mirror;
   - epic/story option missing → `updateProjectV2Field` append (id+color preserved — P6/P8
     verified assignments survive).
4. **field upsert**: `Epic` (SINGLE_SELECT), `Story` (SINGLE_SELECT), `Capture` (TEXT),
   `DOM anchor` (TEXT) — create on first sight; the built-in `Status` field is NEVER touched
   (the board workflow belongs to the user).

Crash-safe: no mapping state exists to lose; markers rebuild the map from the project side.

### 2.3 Item shape (the "living spec" rendering)

- **title**: the thread's first comment, directive lines stripped, whitespace-collapsed,
  clipped ~80 chars; fallback `[pin] <capture display name>`.
- **body**:
  ```
  <!-- dom-annotakit:thread=<id> -->

  **Epic:** E · **Story:** S        (only when set)
  **Capture:** `filename` (no ext) · **Status:** open|fixed|rejected|resolved
  **DOM anchor:** `css-selector` — “target text snippet”
  **Spec source:** [open in dom-annotakit](<publicUrl>?capture=<captureId>)

  ## Directives
  1. **author** — full comment text (directives visible — they are the record)
  2. …
  ```
- **fields**: Epic/Story single-selects (only when specified — unset stays unset, honest);
  Capture text = display filename; DOM anchor text = `selector` (+ snippet, clipped 120).
- **publicUrl**: config `project.publicUrl` ?? engine boot origin (the PREVIEW instance sets
  the preview URL; P2-2 "origin knob" resolved for the sidecar without vendored edits).

### 2.4 Comment directives (specDirectives.ts)

- Line-start, case-insensitive, `@`-optional: `@epic: Name` / `epic: Name` / same for story.
- Value: trimmed, inner whitespace collapsed, clipped 60 chars, non-empty only.
- Scans comments in order across the whole thread; **last wins** (re-organize by replying).
- Cleaned text = directive lines removed (title uses it; bodies show full originals).

### 2.5 Config (users can configure which project)

Per-instance `annotakit.config.json` (serve) / `annotakit-gh.json` (static bake):

```jsonc
{
  "ghAuto": false,                 // issues mirror OFF for this deployment (this kit defaults to Projects)
  "project": {
    "target": "https://github.com/users/melodietexoss/projects/2",  // or owner/name? no — URL or {user|org, number}
    "token": "…",                  // optional; falls back ANNOTAKIT_GH_TOKEN → BAKED
    "publicUrl": "https://preview…",  // link origin minted into item bodies
    "auto": true                   // false = sidecar dormant (status explains)
  }
}
```

Resolution: `target` env `ANNOTAKIT_PROJECT_URL` > config > baked default. `token`:
config > env > baked. Target forms parsed: `/users/<u>/projects/<n>`, `/orgs/<o>/projects/<n>`
(resolved via GraphQL `user(login:)/organization(login:)`). Invalid/missing → sidecar
dormant + status says why (honest degrade, mirrors the vendored "local mode" messaging
discipline).

### 2.6 The project itself (bootstrap script)

`gh-projects-bootstrap.mjs --title "dom-annotakit — UI Spec"`:
- createProjectV2 → fields (Epic SINGLE_SELECT with 3 seed options? NO — empty options list
  is allowed at create; options arrive via append as directives appear; cleaner) —
  actually: `singleSelectOptions` omitted at field create = empty field, fine.
- Capture/anchor text fields + `createProjectV2View "Living spec (by Epic)" TABLE_LAYOUT`
  (grouping is one UI click, not API-settable — P9 fact; the view name tells the reader what
  to click).
- Idempotent: by title match; prints the URL + project id for the config.
- Writes NOTHING to git; the config files are hand-written afterwards (auditable diff).

## 3. D7 — filename display (no title mixing)

- NEW helper `captureName(relpath)` in `src/host/capture-id.ts`: basename minus final
  `.html?/i` — THE display identity.
- Consumers fixed (host scope only): `Sidebar` primary label (tooltip keeps relpath +
  saved-from URL + saved date — no `<title>`), `Toolbar` heading, `App` iframe `title`,
  `snapshot-meta.getSnapshotMeta` → `name`/`title` = captureName (this is what flows into
  every `Thread.story.name` → digests/exports/mirror items: one fix, all surfaces).
- The manifest KEEPS extracting `<title>` (M5 shape contract — the bake writes the same
  shape; the field simply stops being displayed anywhere).

## 4. D8 — sidebar sorting

- State `{key: 'name'|'date', dir: 'asc'|'desc'}` persisted (`dom-annotakit:sort`).
- name → `captureName` locale-compare (case-insensitive); date → `savedDate` (ISO,
  SingleFile provenance; missing sorts last, stable).
- UI: one compact header row under "Captures": [Name|Date] segmented + a ⇅ direction
  button. Native buttons, no deps, matches the existing zero-bloat shell.

## 5. D9 — dark mode

- `theme.ts` becomes the palette owner: LIGHT + DARK palettes (SB-light as shipped; dark =
  GitHub-dark-adjacent neutrals that keep the SAME accent #1EA7FD); `HostTheme` gains
  additive fields: `viewportBackdrop`, `danger`, `dangerSoft`, `hintBack`, `hintText` (all
  currently-hardcoded shell colors move into the palette).
- Swap = `Object.assign(theme, palettes[mode])` + `setColor` re-assign — components already
  read `theme.*` inline at render; App re-render on mode change re-renders the tree (no
  memoized host components — verified). **Module-level theme captures are the one bug
  class**: `App.tsx`'s module-level `barStyle` (theme captured once) becomes a function; any
  other module-level capture found by grep gets the same treatment.
- `useHostTheme()` hook: localStorage `dom-annotakit:theme` ('light'|'dark') else
  `prefers-color-scheme`; toggle button in the Toolbar (moon/sun icon — inline SVG like the
  other icons). The CAPTURE IFRAME is never themed (zero-interference rule) — only host
  chrome.

## 6. Surfacing project-sync status (the "local mode only" complaint)

- Toolbar **"Spec" chip**: dot (green ok / red error / gray dormant) + item count; click →
  opens the project URL in a new tab; tooltip = last sync time + last error. Serves both
  modes (serve: polls `/dom-annotakit-project.json`; static: `projectClient` pushes status
  via the same shape + a window event).
- The vendored panel's issue-sync section keeps rendering its own honest state (with
  `ghAuto:false` it reports the issues mirror as off — TRUE: this kit syncs to Projects
  now). No panel edits for v0.1; comment-directive hint lives in the Sidebar footer:
  "Tip: @epic: / @story: in a comment files it on the GH Project".

## 7. Gates

- New offline test `scripts/project-sync-test.mjs`: directive parser table + reconcile
  against a FAKE transport (create/update/delete/option-append counted; no network) + the
  status shape.
- Full battery re-run: typecheck, drift-check (new files documented in OUT_OF_SCOPE +
  COPY-MAP NEW rows), bake selftest (annotakit-gh.json project section), s6, release-check.
- **release-check sensitive sweep**: the PAT is DELIBERATELY baked (user instruction,
  private repos); the sweep gains an explicit allowlist entry pointing at bakedCreds.ts with
  the justification — a blanket unexplained token in dist would still fail.
- Live E2E on the preview (trusted CDP keys): pin → `@epic:`/`@story:` compose → submit →
  sidecar converge → item exists on the real project with fields set (verify via API read) →
  reply edits item body → delete removes it. Dark mode, sorting, filename display eyeballed
  + screenshotted.
- Push ritual after each green step: origin + sync (/home/z); next-host repo main +
  annotakit-dom via store-push.sh.

## 8. Risks / auditor attention

1. **Baked PAT** in a repo — authorized explicitly; repos are private; release-check
   allowlist must be surgical (only bakedCreds.ts, not a pattern-wide amnesty).
2. **Body ownership**: mirror rewrites item bodies on thread drift — user edits to item
   bodies on GH are lost. Documented ("items are mirror views; the source of truth is the
   thread"). Auditor: confirm acceptable for v0.1.
3. **Option-append race**: a human creating an option in the UI between our read and write
   → we re-read fresh options each reconcile and append only missing-by-name; the replace
   list always includes ALL current options with their ids → no human edits lost, worst
   case a no-op. (P6/P8 verified id preservation.)
4. **Rate limits**: reconcile only on THREADS_CHANGED (debounced 5s) + hourly; ~2 GraphQL
   reads + few writes per pass; far below secondary limits.
5. **Marker safety**: regex requires the exact `<!-- dom-annotakit:thread=<sha1-ish id> -->`
   shape inside the FIRST 512 bytes of the body; user-authored lookalikes in prose don't
   match (leading `<!--` anchor at body start).
6. **Static-mode token exposure**: annotakit-gh.json bakes the token — IDENTICAL exposure
   to the existing vendored issues mirror (GhClientSettings.token) — no new class of risk.
7. **`ghAuto:false` honesty**: the panel's GitHub section may read as "sync off" — the Spec
   chip + sidebar footer carry the Projects story. Auditor: is the panel wording misleading
   enough to warrant a minimal panel edit after all?
8. **Env var injection order**: standalone sets `process.env.ANNOTAKIT_GH_TOKEN` from the
   baked constant BEFORE first engine boot — must not fight `loadDotEnv` (fill-only
   semantics: shell/env-file values keep precedence) and must respect an explicit empty
   config token as "deliberately off"? — NO: empty config token falls through to baked
   (documented precedence); auditor sanity-check this choice.

## 9. AUDIT FOLD (Task 3-a, fresh context — verdict FIX-FIRST; ALL P1/P2/P3 folded)

Every finding below is folded into the implementation plan. Zero vendored edits preserved
throughout.

### P1 (all folded — independently board-destroying before the fold)

- **P1-1 items pagination**: `items(first:100)` truncates → unbounded duplicate minting past
  page 1. FOLD: paged read loop (`pageInfo{hasNextPage,endCursor}`, `after:$cursor` until
  exhausted); >100-item case added to project-sync-test.mjs.
- **P1-2 `POST /sync` + `POST /gh` are live spam doors once the token exists**:
  `ghsync.syncAll()` (routes.ts:1340/1380) gates on `configured()`, NOT on `enabled`
  (ghsync.ts:1078-1088) — the Next proxy forwards remote peers as loopback, so any preview
  visitor could mint one issue per unmapped thread. FOLD: standalone.ts (NEW file, our
  fronting seam) intercepts POST on `/annotakit/api/sync` and `/annotakit/api/gh` BEFORE
  delegating to the engine handler, answering 403 with a pointer to the Projects mirror
  when the issues mirror is disarmed (`ghAuto:false` in config). GET /sync (the explainer)
  stays. /gh/reload stays (harmless .env re-read).
- **P1-3 delete-wins needs tombstone EVIDENCE**: `GET /threads` exposes no `deletedIds` —
  a boot-reconcile racing the async engine restore (routes.ts:232-244) or a fresh store
  would wipe every marked item. FOLD: serve mode uses the process-wide `getStore()`
  singleton's `store.listDeletedIds()` (store.ts:114) as the ONLY delete authorization (an
  item is deleted only when its marker thread id is in the tombstone set — "item, thread
  gone" alone NEVER deletes); static mode reads `PersistDoc.deletedIds`
  (staticStore.ts:157-162) from the scoped key directly. Reconcile also re-arms on
  THREADS_CHANGED `reason:'restored'` so post-restore convergence is immediate; the boot
  reconcile becomes safe under any ordering (worst case: a transient item for a
  to-be-tombstoned thread, removed next pass — no data loss).
- **P1-4 env precedence was false**: loadDotEnv fills only UNSET keys AT BOOTSTRAP (after
  standalone's module init), and reloadDotEnv only touches bootAppliedKeys — an unguarded
  assignment would destroy shell precedence AND make the vendored `.env → /gh/reload`
  recovery path a dead end. FOLD: standalone pre-applies `.env` itself via the exported pure
  `parseDotEnv` over the same candidates loadDotEnv uses (root / configDir / cwd), then the
  guarded baked assignment (`if (!process.env.ANNOTAKIT_GH_TOKEN)`). Real precedence:
  **shell > .env > baked**; `loadDotEnv` is NOT called early (its `envLoaded` latch would
  null `env.file` and kill the routes.ts:178 hygiene check — the pre-apply only mirrors its
  read). Recovery copy updated: rotate via shell env or `.env` + restart (reload can't
  override baked-backed keys — documented in the Spec chip tooltip).

### P2 (folded)

- **P2-1 duplicate/quoted markers**: policy — the marker must sit at body byte 0 (generator
  writes it first); claim an item only then. Two+ items carrying the same thread id →
  canonical = oldest `createdAt` (delete the extras: machine-authored mirror views; this
  restores convergence). Write-side gate: project-sync skips threads whose id does not
  match `^th_[A-Za-z0-9_]+$` (newId() shape, store.ts:127-128 — the REST POST door accepts
  arbitrary ids, routes.ts:563-565; an id containing `-->` could otherwise forge marker
  structure).
- **P2-2 dual-instance sync**: evidence-gated deletes (P1-3) remove the data-loss case;
  documented "one project ← one store lineage" + re-bake discipline (AGENTS.md amend);
  status shape carries writer + last-sync.
- **P2-3 option-append TOCTOU**: `singleSelectOptions` is a FULL REPLACE (probe P6) — a
  human option added between read and write would be dropped. FOLD: options are re-read
  immediately before the replace write and merged fresh (smallest window); residual TOCTOU
  documented honestly (not "worst case a no-op").
- **P2-4 single-flight**: reconcile passes serialize through a promise-chain mutex
  (sync.ts `run` pattern); interleaving case added to the fake-transport test.
- **P2-5 baked-PAT artifact multiplication**: `bakedCreds.ts` is SERVER-SIDE ONLY —
  `projectClient.ts` never imports it (static mode reads annotakit-gh.json, same as the
  vendored issues mirror); the bake script resolves its token from flag > env > .env >
  config > a documented source-regex extract of bakedCreds.ts. release-check allowlist =
  `src/shared/bakedCreds.ts` + `dist/server.cjs` (exact paths, not a pattern amnesty) +
  INVERSE gate: dist-app must contain ZERO `ghp_` matches (stronger than any allowlist).
- **P2-6 `/dom-annotakit-project.json` proxy rewrite**: added to the next-host repo's
  next.config.ts (beforeFiles) + the store-push ritual checklist; E2E'd through the preview.
- **P2-7 D7 backfill**: the D6 item builder derives the Capture field + link text from the
  MANIFEST by storyId (serve: same-process buildManifest; static: baked manifest), never
  from `thread.story.name` — old threads render correctly on the board immediately. The 11
  seeded threads keep their old `story.name` in the panel/exports until touched — ACCEPTED
  (documented); no store mutation from sidecar code in v0.1.
- **P2-8 recorded-decision amendments**: AGENTS.md (issues-centric prose, `.env`-first token
  discipline), release-check.mjs docstring ("live PAT shapes must never ride a commit"),
  README — all amended in the same change with the bake rationale (user instruction,
  private repos), so the next agent doesn't "fix" the PAT out of the repo.
- **P2-9 Spec chip status content**: `{state: 'ok'|'error'|'dormant', projectUrl, projectTitle,
  target, items, threads, lastSyncAt, lastError, writer, recovery}` — the chip tooltip
  renders state/target/items/last-sync/last-error + the real recovery path (P1-4). The
  vendored panel's "sync off" wording stays honest (issues mirror IS off); chip + sidebar
  footer carry the Projects story. No panel edit.

### P3 (folded where cheap)

- P3-1 unparseable `savedDate` = missing (comparator requires `Date.parse` success).
- P3-2 dark palette carries BOTH `colorPositive/Negative` AND `color.positive/.negative`;
  count-badge + zen-hint colors stay hardcoded (read fine on both palettes).
- P3-3 dead `?capture=` deep-links for deleted capture files — documented (no cascade).
- P3-4 token precedence ALIGNED with the engine: env > config > baked (matches
  routes.ts:203 `ghToken() ?? configToken`); target: config > env > baked (no vendored
  precedent — documented).
- P3-5 #9a hygiene warning may fire misleadingly when a token is baked — accepted (cosmetic).
- P3-6 with a live token `fetchRemote` succeeds → the A14 fallback-parent bug is mostly
  sidestepped; COPY-MAP fix stays on the backlog; engine pushes now coexist with the
  store-push ritual (sync.ts already retries benign non-FF).
- P3-7 grouping NOT API-settable — CONFIRMED (UpdateProjectV2ViewInput has no groupBy;
  ProjectV2ViewConfigurationUpdate does not exist in the schema). View name carries the
  instruction; bootstrap sets layout TABLE_LAYOUT only.
- P3-8 static arming via `await probeMode() === 'static'` (never 'down'); second-serve
  process on another port → same singleton store → covered by evidence-gated deletes;
  documented.

### ghToken()-consumer inventory under the baked token (audit item D — accepted)

sync.ts:409/475 (fetch+push auth — WANTED), :793 (noCredLocalMode never latches), :838/:861
(failure accounting; the .env-reload advice is now secondary — P1-4 recovery copy), :938
(argv-auth warn, git≥2.31 present), :1046 (durability honestly reports git-push);
routes.ts:203 (ghsync getter — disarmed via enabled:false + P1-2 door interception), :766/774
(health: hasToken true, github false, reason 'disabled (ghAuto:false)' — honest), :178 (#9a —
P3-5); ghsync.ts:153 (tokenState 'unexercised' — harmless); env.ts:104/gh.ts:60-86
(help-text). `kitRepo()` is null (no repository field in package.json) — no cross-repo
warning.
