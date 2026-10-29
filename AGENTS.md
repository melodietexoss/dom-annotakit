# AGENTS.md — dom-annotakit consumer guide (for agents in sandboxed environments)

You are an agent building/maintaining a web app, and your user reviews UIs by
**saving pages with SingleFile** — sometimes annotated at capture time, often
not. dom-annotakit gives those snapshots the full annotakit review experience:
the reviewer opens the review surface, picks an element, pins a threaded
comment; every thread mirrors to a GitHub issue on your repo; you fix the
LIVE app the capture came from, comment evidence, re-capture if needed; the
reviewer confirms or rejects (durable verdicts). This guide is the verified
path for THIS environment class (ephemeral disk, git-is-the-disk, preview
URLs proxied to localhost).

Everything below was E2E-verified in this environment (server + static modes,
real SingleFile captures incl. annotated ones, the full reviewer loop, the
import loop). The upstream contracts (envelopes, mirror semantics, merge
lattice) are inherited from storybook-annotakit v0.6.16 by copy.

## 0. What you are setting up

- The reviewer opens **`<preview-url>/`** — the capture browser sidebar; pick a
  capture; it renders in the review surface with the pin layer.
- Pins carry element identity + CSS selector + capture provenance. **Threads
  mirror to the GH Projects spec board** ("dom-annotakit — UI Spec",
  github.com/users/melodietexoss/projects/10 by default — configure your own
  via `annotakit.config.json` `"project".target`). A comment carrying
  **`@epic:` / `@story:`** line directives files the thread under that
  epic/story on the board (last directive wins — replying re-files it).
- The ISSUE mirror (`ghRepo` + token, labeled `dom-annotakit`) remains
  available for consumers who want it — set `"ghAuto": true` in
  `annotakit.config.json`. This kit's config ships `ghAuto:false` (Projects
  instead of Issues).
- SingleFile notes already embedded in a capture? One click imports them as
  threads (idempotent — re-import never duplicates; deliberate deletes win).
- Your loop: read the spec board (or the REST API in server mode) → fix the
  live app → comment evidence → reviewer verifies.

## 1. Setup — server mode (recommended; full REST + SQLite + engine mirror)

```bash
git clone https://github.com/melodietexoss/dom-annotakit-dev /tmp/dom-ak && cd /tmp/dom-ak
bun install && bun run build          # dist/ is git-tracked; rebuild only after src edits
cp /path/to/singlefile-snapshots/*.html .   # the captures folder = the directory you start the
                                      # server from (project root by default, top-level *.html);
                                      # pin it via annotakit.config.json "captures" or
                                      # DOM_AK_CAPTURES_DIR. Captures are DATA — a git-backed
                                      # deployment commits them (in-app uploads do it for you).
node dist/standalone.cjs              # :4310 — PORT + DOM_AK_CAPTURES_DIR override
```

Credentials: the repo **bakes** the melodietexoss PAT
(`src/shared/bakedCreds.ts` — user-instructed; private repos; release-check
allowlists the exact paths) AND honors the classic doors with REAL
precedence: shell env > `.env` > baked. To use YOUR own token instead, add
`ANNOTAKIT_GH_TOKEN=<PAT>` to the shell or `.env` (a `.env` token keeps the
vendored rotation path — `.env` edit + `POST /annotakit/api/gh/reload`);
`printf '.env\n' >> .gitignore` before writing it. To point the spec board
elsewhere: `.dom-annotakit/annotakit.config.json`
`"project": {"target": "https://github.com/users/<u>/projects/<n>",
"publicUrl": "<your app's public origin — board deep links>", "auto": true}`.

Verify: `curl localhost:4310/annotakit/api/health` →
`{"ok":true,"store":"sqlite","gh":{"hasToken":true,…},"git":{…}}` and
`curl localhost:4310/dom-annotakit-manifest.json` lists your captures.
The preview edge proxies ONE port — front the server accordingly (or run the
static mode below, which needs no long-lived server at all).

Durability: the SQLite store auto-commits to the **orphan branch
`annotakit-dom`** of the tool repo and pushes (union merge, never
force-push); it is safe to lose the sandbox disk. Threads live on the
`annotakit-dom` branch, NOT on your code branches.

## 2. Setup — static mode (no server; drop into any static host / public/)

```bash
cd /tmp/dom-ak && bun run build
node scripts/bake-dom-annotakit.mjs /path/to/host/public/review \
  --captures /path/to/captures            # NO token → local-only (hand-carry exports)
# or, to arm the browser mirror:
node scripts/bake-dom-annotakit.mjs /path/to/host/public/review \
  --captures ... --gh-token <PAT> --gh-repo owner/name --gh-labels dom-annotakit
```

The bake emits the app + `layer.mjs` + CSP-stripped capture copies + the
thread seed + the manifest (+ `annotakit-gh.json` when armed). Serve
`/review` with any static host. Token safety: **anyone who can open the URL
can read `annotakit-gh.json`** — fine-grained PAT, Issues read/write on the
one feedback repo, rotate after the workstream; gitignore the bake output's
gh.json if you commit the bake.

## 3. The reviewer's surface (what they see)

Sidebar (capture list + provenance) · toolbar pin/region/freeze/threads/
show-hide + ⌥-hotkeys (⌥C pin, ⌥B region, ⌥I freeze, ⌥L layer, ⌥P panel,
? help) · bottom-drawer panel (filters open/to review/rejected/all,
latest-first, replies, confirm/reject/clear/reopen, copy-md/download-json,
GitHub links, author name) · the SingleFile **import bar** on annotated
captures. Review states: `open` → `fixed` (agent-marked, awaiting review) →
`resolved` (reviewer-confirmed) | `rejected` (durable — the re-work queue).

## 4. Your loop

1. **Read feedback**: `gh issue list --repo owner/name --label dom-annotakit`
   (bodies carry element identity, selector, capture metadata, `- thread id:`;
   never edit that line) — or, server mode: `curl
   localhost:4310/annotakit/api/threads`. `GET /schema` documents every
   endpoint.
2. **Fix the live app** the capture came from (the capture is evidence —
   the element/selector rows locate the target; there are no component-file
   rows).
3. **Comment evidence** (diff + SHA); set `fixed` via PATCH (server mode) or
   by replying and marking it addressed (static mode has no REST — the
   reviewer flips states in the panel).
4. **Re-capture** the fixed page with SingleFile, drop it in `captures/`,
   and tell the reviewer to reload (or re-bake in static mode).
5. The reviewer confirms (issue closes → thread resolves within a poll) or
   rejects (a notice comment lands; the thread enters the red re-work queue).
   **Never close an issue yourself.**

## 5. Pitfalls (each one bites)

| symptom | cause → fix |
|---|---|
| layer never loads; pins dead | capture served RAW with SingleFile's freeze-CSP meta — server mode strips it at serve time; static mode strips at bake time; if you hand-serve captures raw, that's on you. Host shows an honest "layer failed to load" notice. |
| reviewer's new pins invisible to you | no mirror armed (check `annotakit-gh.json` exists + token scopes) or you're reading the wrong repo/label |
| static threads vanished after URL change | localStorage is per-origin — the mirror is the durable copy; re-bake + reload |
| imported notes doubled | you forced a re-import after deleting the import marker — delete-wins tombstones hold; if you really cleared localStorage AND the flag, re-import is still idempotent by content hash |
| huge capture (50MB+) | loads fine (streamed); freeze button is disabled >20MB by design; pinning works |
| `/captures/x.html` 404 | wrong `DOM_AK_CAPTURES_DIR` or subpath deployments — the app mints URLs from ITS base; deploy the bake as a unit |
| port conflicts | `PORT` env (default 4310); `ss -tlnp` to find strays; one server at a time |

## 6. Where to read more

- `README.md` (this repo) — the full tool reference.
- `design/2026-10-22-design-decisions.md` — the sealed design + audit trail.
- `GET /annotakit/api/schema` — REST self-documentation (server mode).
- The upstream kit's docs for the mirror/durability contracts
  (storybook-annotakit README — same engine, same semantics).
