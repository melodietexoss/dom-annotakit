# dom-annotakit

**Pin-comment UI review on SingleFile DOM snapshots** — the sibling of
[`storybook-annotakit`](https://github.com/melodietexoss/storybook-annotakit)
for the capture-first review workflow: you saved pages with SingleFile (maybe
without annotating at the time), and now you want the full annotakit review
experience — pick an element, pin it, thread the discussion, resolve or reject
— pinned directly **on the rendered snapshot**.

Same workflow integration as the SB kit, inherited **by copy, not re-earned**
(the engine modules are vendored byte-identical from storybook-annotakit
v0.6.16 — see `COPY-MAP.md`, enforced by `npm run test:drift`):

- every thread mirrors to **exactly one GitHub issue** for its whole lifecycle**
  (server engine in server mode; the reviewer's browser in static mode) — the
  issues mirror remains available (`"ghAuto": true`), AND since session 3
  **this kit's default mirror is a GH Projects spec board**: one thread = one
  draft item on `…/projects/10` "dom-annotakit — UI Spec", grouped by
  **`@epic:` / `@story:`** comment directives (last wins), Capture/DOM-anchor
  fields, and deep links back to the capture view (`project.publicUrl`),
- threads live in a real db — SQLite, git-orphan-branch durable
  (`annotakit-dom`) — or the reviewer's browser store (static mode),
- offline exports: markdown digests + full JSON, REST + panel,
- **SingleFile's own embedded notes import** as first-class threads when a
  capture carries them (idempotent; the sticky cards become annotakit pins),
- the same agent loop: read GH issues / the REST API → fix the live app →
  comment evidence → reviewer confirms or rejects (durable verdicts).

**Status: v0.1.1 — feature-complete, battery green** (s6 49 · lattice 576 ·
static-store 156 · ghclient 241 · engine 159 · api 161 · singlefile 50 ·
bake selftests 14/56 · store-robust 15 · project-sync 37 · release-check
CLEAN · drift-check CLEAN). Session 3 added the spec-board mirror (D6),
filename display identity (D7), sidebar sorting (D8), dark mode (D9), and
the baked-credential fix. The display name of a capture is ALWAYS its
filename (minus `.html`) — rename files to organize; the list sorts by name
or date, asc/desc; dark mode follows the system preference with a manual
toggle. This is the public release repo (staged from the dev repo —
the transform scrubs every credential: the baked-token allowlist that exists
in the dev repo does NOT apply here, and the staged tree is gated on ZERO
PAT shapes anywhere). Bring your own token via `.env` (see
`.env.example`), `annotakit.config.json`, or the panel settings — or run
the no-credential local mode.

## Quickstart — server mode (primary)

```bash
bun install
bun run build                # tsup (dist/) + vite (dist-app/) — dist IS git-tracked
cp /path/to/*.html .         # SingleFile captures — the DESIGNATED FOLDER is the
                             # directory you start the server from (the project root
                             # by default; top-level *.html only). Pin it with
                             # .dom-annotakit/annotakit.config.json
                             # {"captures":{"dir":"<path>","recursive":false}}
                             # or the DOM_AK_CAPTURES_DIR env var. Upload via the
                             # sidebar works too (files commit to git automatically).
node dist/standalone.cjs     # :4310  (PORT, DOM_AK_CAPTURES_DIR env knobs)
# or: npm run serve
```

Open `http://localhost:4310/` — pick a capture in the sidebar, pin, thread,
resolve. Optional GitHub mirror + git durability:

```bash
printf '.env\n' >> .gitignore   # CONSUMER projects: yes, gitignore the token.
echo "ANNOTAKIT_GH_TOKEN=<PAT>" >> .env
echo "ANNOTAKIT_GH_REPO=owner/name" >> .env   # your review-target repo
# restart the server — .env/config are boot-read (the token hot-reloads:
# POST /annotakit/api/gh/reload, same contract as the SB kit)
```

⚠ **This repo's own `.env`** is deliberately git-TRACKED (sandbox practice:
git is the only durable disk; `ANNOTAKIT_ENV_TRACKED_OK=1` silences the
refusal). Consumer projects should follow normal practice and gitignore it.
Use a fine-grained PAT with Issues read/write on the one feedback repo.
Default issue label: `dom-annotakit` (the SB kit's is `annotakit` — both kits
can mirror into ONE repo without mixing streams; stores and orphan branches
are isolated: `annotakit-dom/` + `refs/heads/annotakit-dom`).

## Quickstart — static mode (no server)

```bash
bun run build
node scripts/bake-dom-annotakit.mjs <outDir> --captures captures
# serve <outDir> with ANY static host (python3 scripts/serve-static.py <outDir> 4320)
```

The bake writes: `annotakit-threads.json` (the seed — always, even empty:
tombstones carried, zombie rows suppressed), `annotakit-gh.json` (mirror
config, when token+repo resolve), `dom-annotakit-manifest.json` (the capture
list: id/title/provenance/size/advisory note count), the app build +
`layer.mjs`, and `captures/*` **with SingleFile's freeze-CSP meta stripped**
(the strip is in-memory at serve time in server mode, at bake time in static
mode; the files on disk are never modified by the server; note cards are
NEVER stripped — they are importable data). The reviewer's browser owns the
store (localStorage, read-merge-write persist) and, when gh.json is baked,
the GitHub mirror (outbox + lease + self-heal — the vendored ghClient engine).

## The reviewer surface

- Sidebar: capture browser with SingleFile provenance (title, saved-from URL,
  saved date, size).
- Toolbar: pin · region · freeze (❄ — disabled with a hint above the 20MB
  clone threshold) · threads+count · show/hide. Hotkeys (any-focus, physical
  e.code): ⌥C pin · ⌥B region · ⌥I freeze · ⌥L show/hide · ⌥P panel · `?` help.
- The panel (bottom drawer): filters (open / to review / rejected / all),
  latest-first default, replies, confirm / reject / clear / reopen, exports
  (copy md / download json), per-thread GitHub links, author name
  (localStorage), sync status.
- Pins carry: element identity (tag, text, testid, form metadata), a CSS
  selector, the capture's provenance. No component/jsx rows — a capture has no
  React fiber; the composer honestly omits them (same shape as the SB kit's
  frozen-view pins).
- **SingleFile import**: when a capture carries SingleFile notes, an amber
  bar offers "Import N SingleFile notes". Import is idempotent (deterministic
  thread ids + the store's replay doors), respects deliberate deletes
  (delete-wins tombstones), hides the original sticky cards (the toolbar SF
  toggle re-shows them; the elements stay in the DOM — see the D13 display
  invariant), and
  is honest about dangling notes (target not in the saved DOM → panel-only
  thread, no fabricated pin) and page-level notes. Highlights stay rendered.

## The agent loop

- **Path A (GitHub)**: list issues labeled `dom-annotakit` on the target repo;
  the issue body carries element identity, selector, capture metadata, the
  `- thread id:` stamp (never edit it), verbatim notes. Fix the LIVE app the
  capture came from → comment evidence → the reviewer confirms (issue closes →
  thread resolves) or rejects (a notice comment lands; the thread stays
  `rejected` — your re-work queue).
- **Path B (REST, server mode)**: base `http://localhost:4310/annotakit/api` —
  `GET /health` (agentSurfaces), `GET /threads` (`?storyId=<captureId>`,
  `?status=`, `?sort=recent`), `GET /schema` (self-documenting, capture-shaped
  examples), `POST /threads` (201 / 200 replay `replayed:true`), `PATCH
  /threads/<id>` (partial JSON-merge; the status ladder + verdict notices),
  `POST /threads/<id>/comments` (retry-idempotent — send a stable createdAt),
  `DELETE /threads/<id>` (tombstone), `GET /export?format=md|json`
  (`&mode=full`), `POST /sync`, `POST /gh/reload`. Envelope contracts are the
  SB kit's, byte-for-byte.

## Known fidelity limits (documented, by design)

- Root-relative `<use xlink:href=/svg-sprite/…>` icon refs 404 on our origin
  (icon slots render empty — as-captured); 1–2 external links/imags per
  capture mean review-time network calls; content inside NESTED frames in a
  capture is unpinnable (`elementsFromPoint` cannot cross frames).
- `file://` is unsupported (same-origin requirement) — serve via the bundled
  server or any static host.
- If a capture's `<head>` has no `</head>` within the first 512KB, the CSP
  strip falls back to raw serving (loud log) and the layer will not load on
  that capture — the host shows an honest notice.
- Static mode: a preview-URL change (new origin) loses post-bake localStorage
  threads not yet mirrored — same caveat as the SB kit's static mode.

## Repo layout

```
src/shared/      vendored engine contracts (store, gh client, merge, events…)
src/preview/     vendored pin layer (anchor, hittest, layer, snapshot) + bootstrap
src/server/      vendored REST + SQLite + gh mirror + git durability + standalone
src/host/        the app shell (App, sidebar, toolbar, panel port, inject, channel)
src/singlefile/  SingleFile note parser + strip + idempotent import flow
scripts/         vendored battery + bake + NEW drift-check/bake-dom/import tests
fixtures/        real + synthetic annotated captures (tracked)
.agents/         SKILL.md runbook + explore notes + evidence shots
design/          decision records (D1–D3, both critique rounds) — read before changing shape
```

## Conventions (hard rules, inherited from the kit)

- **GIT IS THE DISK** — push after every micro step; GitHub `origin` + GitLab
  `gitlab` mirror (WAF: retry pushes ~1/3 fail) + `/home/sync` at milestones.
- **Never force-push.**
- **Vendored code changes go through `COPY-MAP.md`** and are enforced by
  `npm run test:drift` (hunk-level allowlist vs the UPSTREAM pin).
- Full battery before any seal: `npm test` per-suite + `npm run release-check`.

## License

MIT (inherited from storybook-annotakit).
