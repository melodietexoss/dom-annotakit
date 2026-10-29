#!/usr/bin/env node
/**
 * dom-annotakit — bake a STATIC review deployment (design D3a; M5).
 *
 * Vendored + adapted from storybook-annotakit's scripts/bake-static-threads.mjs
 * @2853e32 (COPY-MAP scripts/ row: the seed/gh resolution semantics are the
 * hard-won vendored ones — reused, NOT reinvented).
 *
 * Writes a SELF-CONTAINED static site into <outDir>:
 *
 *  1. `annotakit-threads.json` = { threads, deleted } — the SEED for the
 *     client-side static store AND the static-mode marker (mode.ts probes
 *     health first; on 404 it probes this file — see src/shared/mode.ts).
 *     ALWAYS written, even when the store is empty: an empty seed still marks
 *     the build as static. `deleted` carries the store's TOMBSTONES — the
 *     seed-merge (staticStore.ts) unions them into the deployment's
 *     tombstone set (delete-wins, A1), so dev-side deletes propagate to
 *     re-baked deployments instead of resurrecting. Legacy zombie rows
 *     (live row + standing tombstone) are SUPPRESSED from `threads` — the
 *     exact vendored semantics.
 *  2. `annotakit-gh.json` = { token, repo, labels, pollMs } — CLIENT-side
 *     GitHub publishing config; only when token+repo resolve (flags → env →
 *     .env → git-origin autodetect). A stale one from a previous bake is
 *     REMOVED when they don't (build goes local-only; runtime panel settings
 *     can still configure publishing). Default label 'dom-annotakit'.
 *  3. `dom-annotakit-manifest.json` = { generatedAt, captures: [{id,
 *     relpath, title, url, savedDate, size, noteCount}] } — the SAME shape
 *     the standalone server's dynamic route serves (src/server/standalone.ts
 *     buildManifest), PLUS `noteCount`. `noteCount` is ADVISORY ONLY: a byte
 *     count of `<single-file-note` occurrences in the full file — it can
 *     include empty-text notes and can lag a re-saved capture. The ImportBar
 *     PARSES THE LIVE IFRAME DOM and never reads this field; the host lists
 *     captures from it and nothing else gates on it.
 *  4. `index.html` + `assets/*` — the host app's Vite build (--app, default
 *     ./dist-app) copied. Ref-shape gate: the copied index.html must reference
 *     only RELATIVE assets — a root-absolute src/href fails LOUDLY (the
 *     Vite build must use base './'; a static host serves files RAW, so any
 *     root-absolute ref would 404 at a subpath deployment).
 *  5. `layer.mjs` — the iframe pin-layer bundle (dist/layer.mjs). The host
 *     injects it relative to its own base (inject.ts); a static host serves
 *     it RAW, so it must sit next to index.html.
 *  6. `captures/*` — every capture from --captures, copied through the
 *     CSP-meta strip: the SAME streaming transformation the standalone
 *     server's serveCapture does (first-512KB head slice, strip
 *     `<meta … http-equiv=content-security-policy …>` case-insensitive/
 *     unquoted-tolerant, tail bytes verbatim from the original `</head>`
 *     offset). The SingleFile freeze-CSP would silently kill the injected
 *     layer on a static host (no server to strip it live). Big files
 *     STREAM — a 69MB capture is never buffered in memory. Honest loud-log +
 *     raw-copy fallback when `</head>` is not in the head slice.
 *
 *     NEVER STRIPPED: SingleFile note CARDS (`<single-file-note>` elements).
 *     Cards are IMPORTABLE DATA (M4); stripping happens live-DOM-only,
 *     flag-gated, in-memory (inject.ts stripNoteCards / import.ts). A baked
 *     capture with its cards removed would lose its notes permanently. The
 *     bake's transformation is bytes-identical to the source EXCEPT the CSP
 *     metas.
 *  7. `--base <url-path>`: when given, inject `<base href>` into index.html
 *     so the (relative-refs) build serves under a subpath even on servers
 *     that 308-strip trailing slashes. With Vite base './' this is usually
 *     the only rewriting needed; pinned by --selftest.
 *
 * Store resolution (dom-annotakit: the store is REQUIRED — the cwd git-dir /
 * config-dir discovery ladder is GONE per the vendored M2b edit):
 *   1. --store <path>              (threads.db, or its threads.json sibling)
 *   2. $ANNOTAKIT_STORE_PATH
 *   The documented default: the TOOL repo's own store (the standalone
 *   server's — configDir <repoRoot>/.dom-annotakit; the db resolves per
 *   env.ts storeLocation to <repoRoot>/.git/annotakit-dom/ or
 *   <repoRoot>/.dom-annotakit/annotakit/).
 *   Unconfigured → exit 1 LOUDLY before any file is written.
 *
 * GH config resolution (first hit wins; the vendored order):
 *   --gh-token / --gh-repo / --gh-labels (comma) / --gh-poll-sec flags
 *   → process env (ANNOTAKIT_GH_TOKEN / _REPO / _LABELS / _POLL)
 *   → .env file (--env-file, else the tool repo root .env, else ./.env)
 *   → git-origin autodetect (only when a token exists)
 * The resolved repo must be owner/name in GitHub's real charset
 * (alphanumerics, `_`, `.`, `-`); a github.com URL of any accepted form is
 * normalized first; anything else exits 1 LOUDLY BEFORE ANY WRITE (a
 * malformed repo baked into gh.json is a mirror that silently dies at
 * runtime).
 *
 * `--selftest` pins the CLI shapes with NO writes to this repo (all plants
 * live in a scratch tmpdir, subprocesses run with cwd there): bad repo
 * charset → exit 1 before any write; missing store → clear exit 1; the
 * threads.json seed shape (tombstones carried, zombies suppressed); the
 * CSP strip on a tiny fixture (note cards preserved); the raw-copy fallback;
 * the index.html relative-ref gate; --base idempotency; gh.json presence/
 * absence. Count + report, exit nonzero on failure.
 *
 * Usage: node scripts/bake-dom-annotakit.mjs <outDir> [--store <db-or-json>]
 *        [--app <dist-app dir, default ./dist-app>] [--captures <dir, default
 *        ./captures>] [--gh-token t] [--gh-repo owner/name] [--gh-labels a,b]
 *        [--gh-poll-sec 60] [--env-file path] [--base /review/] [--selftest]
 *
 * outDir is REQUIRED (positional). The bake CLEANS the outDir subtrees it
 * owns (captures/, assets/) so removed captures / re-hashed assets never
 * linger as ghosts; it never touches anything else in outDir.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
/** The vendored argv walker (audit 24-e P2): consume --flag value pairs (and
 *  --flag=value), then the first REMAINING token is the positional. A naive
 *  "first non-flag token" heuristic used to eat flag VALUES as outDir. */
const FLAG_NAMES = ['store', 'app', 'captures', 'gh-token', 'gh-repo', 'gh-labels', 'gh-poll-sec', 'env-file', 'base', 'project-target'];
const positional = (() => {
  const rest = [...args];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? '';
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0] ?? '';
      if (!a.includes('=') && FLAG_NAMES.includes(name)) i++; // consume the value token
      continue;
    }
    return a;
  }
  return undefined;
})();
/** Space-separated value, RAW (no path.resolve — tokens/repos/labels are not
 *  paths and would be mangled). */
const rawOpt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};
/** Path-typed space-separated flag. */
const optValue = (name) => {
  const v = rawOpt(name);
  return v ? path.resolve(v) : undefined;
};
/** --name=value form OR space form — raw string either way. */
const flagValue = (name) => {
  const pre = `--${name}=`;
  const hit = args.find((a) => a.startsWith(pre));
  return hit ? hit.slice(pre.length) : rawOpt(name);
};

/* v0.6.13 (audit 44-d P2-1, ALL doors in sync): GitHub's real owner/name
 * charset — alphanumerics, `_`, `.`, `-`. Vendored verbatim from
 * bake-static-threads.mjs (the twins: src/server/env.ts ghRepoEnv,
 * src/shared/ghClient.ts's runtime gate, heal-mirrors.mjs). */
const GH_OWNER_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7) : line;
    const eq = cleaned.indexOf('=');
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    const m = value.match(/^("|')(\S|[\s\S]*)\1$/);
    if (m) value = m[2] ?? '';
    if (key) out[key] = value;
  }
  return out;
}

/** Vendored (S7-AUDIT-A2): parse a github.com remote/repository URL down to
 *  owner/name — https/ssh/git+ssh forms, optional port (the S9 parser fix),
 *  optional .git, trailing paths, + the `github:` shorthand. Byte-identical
 *  regexes with the server twin (class-sync contract). */
function parseGithubRepoUrl(url) {
  if (!url) return null;
  const m =
    String(url).match(/github\.com(?::\d+)?[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/\s?#].*)?$/i) ??
    String(url).match(/^github:([^/\s]+)\/([^/\s]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

/** Vendored: git-origin autodetect runs LAST (explicit config always wins)
 *  and only when a token exists — a detected repo without a token cannot arm
 *  the mirror. The root here is the TOOL repo (this script's parent). */
function detectGhRepo() {
  try {
    const remote = execFileSync('git', ['-C', toolRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const repo = parseGithubRepoUrl(remote);
    if (repo) return { repo, source: 'git remote origin' };
  } catch {
    /* no git / no origin remote */
  }
  try {
    const pkg = JSON.parse(readFileSync(path.join(toolRoot, 'package.json'), 'utf8'));
    const repoUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    if (repoUrl) {
      const repo = parseGithubRepoUrl(repoUrl);
      if (repo) return { repo, source: 'package.json repository' };
    }
  } catch {
    /* no package.json / no repository field */
  }
  return { repo: null, source: 'not found' };
}

/** Vendored (S9/E-bake): owner/name directly, or any github.com URL form the
 *  parser knows (normalized). OUTPUT re-validated against the charset gate —
 *  a 3-segment shorthand or a non-charset owner capture is REJECTED here. */
function normalizeGhRepoInput(raw) {
  const v = String(raw ?? '').trim();
  if (GH_OWNER_NAME_RE.test(v)) return v;
  const parsed = parseGithubRepoUrl(v);
  return parsed && GH_OWNER_NAME_RE.test(parsed) ? parsed : null;
}

/** Resolve the GH client config: flags → process env → .env (env-file, tool
 *  repo root, cwd) → git-origin autodetect. The vendored resolution order —
 *  the only dom-annotakit delta is the .env candidates (no .storybook
 *  config-dir; the tool repo root is the documented home). */
function resolveGhConfig() {
  let token = flagValue('gh-token') || process.env.ANNOTAKIT_GH_TOKEN;
  let repo = flagValue('gh-repo') || process.env.ANNOTAKIT_GH_REPO;
  let labels = flagValue('gh-labels') || process.env.ANNOTAKIT_GH_LABELS;
  let pollSec = flagValue('gh-poll-sec') || process.env.ANNOTAKIT_GH_POLL;
  if (!token || !repo) {
    const envFile = rawOpt('env-file');
    const envCandidates = [
      envFile ? path.resolve(envFile) : undefined,
      path.join(toolRoot, '.env'), // the tool repo root
      path.resolve('.env'),
    ].filter(Boolean);
    for (const p of envCandidates) {
      if (!existsSync(p)) continue;
      try {
        const parsed = parseDotEnv(readFileSync(p, 'utf8'));
        token = token || parsed.ANNOTAKIT_GH_TOKEN;
        repo = repo || parsed.ANNOTAKIT_GH_REPO;
        labels = labels || parsed.ANNOTAKIT_GH_LABELS;
        pollSec = pollSec || parsed.ANNOTAKIT_GH_POLL;
        console.log(`[bake-dom] gh config: loaded ANNOTAKIT_* from ${p}`);
        break;
      } catch {
        /* unreadable — next candidate */
      }
    }
    if (token && !repo) {
      const det = detectGhRepo();
      if (det.repo) {
        repo = det.repo;
        console.log(`[bake-dom] gh config: repo autodetected from ${det.source} → ${repo}`);
      }
    }
  }
  // Vendored (S9/E-bake): validate the RESOLVED repo — loud exit 1, a bad
  // value baked into gh.json kills the mirror at runtime with no hint.
  if (repo) {
    const normalized = normalizeGhRepoInput(repo);
    if (!normalized) {
      console.error(
        `[bake-dom] FATAL: invalid repo ${JSON.stringify(String(repo))} (from --gh-repo / ANNOTAKIT_GH_REPO / .env) — expected owner/name (e.g. octocat/widgets) or a github.com URL (https/ssh forms, optional port, optional .git), which is normalized to owner/name.\n` +
          `  A malformed repo would be baked into annotakit-gh.json and the client engine would silently reject it at runtime (dead mirror). Fix the value and re-run.`,
      );
      process.exit(1);
    }
    if (normalized !== String(repo).trim()) console.log(`[bake-dom] gh config: repo normalized ${repo} → ${normalized}`);
    repo = normalized;
  }
  const labelList = String(labels ?? '')
    .split(/[,; ]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pollMs = Number.parseInt(String(pollSec ?? ''), 10);
  /* D6: the project-spec section. Target: --project-target flag > env
   * ANNOTAKIT_PROJECT_URL > the BAKED default (source-regex extract of
   * src/shared/bakedCreds.ts — the ONE source of truth; the bake may read
   * the server-side module, browser code may not, P2-5). Token: the SAME
   * resolution chain as the issues mirror (flags > env > .env) with the
   * baked fallback — static deployments bake the token exactly like the
   * vendored issues mirror does ("delivery beats secrecy", explicit
   * operator choice; private repos). */
  let projectTarget = flagValue('project-target') || process.env.ANNOTAKIT_PROJECT_URL || '';
  if (!projectTarget) {
    try {
      const src = readFileSync(path.join(toolRoot, 'src', 'shared', 'bakedCreds.ts'), 'utf8');
      projectTarget = src.match(/BAKED_PROJECT_TARGET: string = '([^']*)'/)?.[1] ?? '';
    } catch {
      /* absent in this shape — project section stays off */
    }
  }
  let projectToken = token || '';
  if (!projectToken) {
    try {
      const src = readFileSync(path.join(toolRoot, 'src', 'shared', 'bakedCreds.ts'), 'utf8');
      projectToken = src.match(/BAKED_GH_TOKEN: string = '([^']*)'/)?.[1] ?? '';
    } catch {
      /* absent — no static board sync */
    }
  }
  const project = projectTarget && projectToken ? { target: projectTarget, token: projectToken } : null;
  return {
    token: token || null,
    repo: repo || null,
    labels: labelList.length ? labelList : ['dom-annotakit'],
    pollMs: Number.isFinite(pollMs) && pollMs >= 0 ? pollMs * 1000 : 60_000,
    project,
  };
}

/* ------------------------------ store (vendored) ----------------------------- */

async function readStoreThreads() {
  const explicit = optValue('store') ?? (process.env.ANNOTAKIT_STORE_PATH ? path.resolve(process.env.ANNOTAKIT_STORE_PATH) : undefined);
  // dom-annotakit (crit-1b Area D): the store is REQUIRED. The discovery
  // ladder is GONE — a walk from a CONSUMER repo could read the WRONG store
  // (its own annotakit dir, or the SB kit's db on a dual-kit machine) while
  // the tool repo owns the threads, and an unconfigured bake used to fall
  // back to an EMPTY seed (a static build that silently looks thread-less).
  // Honest exit 1, before any file is written.
  if (!explicit) {
    console.error(
      `[bake-dom] FATAL: no store configured — the bake requires it explicitly: --store <threads.db (or its threads.json sibling)> or $ANNOTAKIT_STORE_PATH.\n` +
        `  The documented tool-repo store (the standalone server's): ${path.join(toolRoot, '.git', 'annotakit-dom', 'threads.db')} (git mode) or ${path.join(toolRoot, '.dom-annotakit', 'annotakit', 'threads.db')} (classic configDir mode).\n` +
        `  There is NO silent empty-seed fallback — point at the real store.`,
    );
    process.exit(1);
  }
  const candidates = [];
  candidates.push({ db: explicit, json: explicit.replace(/threads\.db$/, 'threads.json') });

  for (const c of candidates) {
    if (existsSync(c.json)) {
      const raw = JSON.parse(readFileSync(c.json, 'utf8'));
      // JSON twin doc shape: { threads, counters, tombstones, snapshots,
      // deleted } (store.ts jsonStore Doc) — `deleted` is the tombstone list.
      const threads = Array.isArray(raw) ? raw : (raw.threads ?? []);
      const deleted = Array.isArray(raw) ? [] : (Array.isArray(raw.deleted) ? raw.deleted : []);
      return { threads, deleted, source: c.json, kind: 'json' };
    }
    if (existsSync(c.db)) {
      // read-only attach: a WAL checkpoint by the live dev server must never
      // be disturbed by the bake — mirrors store.ts readOnly usage
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(c.db, { readOnly: true });
      try {
        const rows = db.prepare('SELECT payload FROM threads').all();
        // tombstones — mirror of store.ts readStoreFile (pre-v0.5.0 schemas
        // have no deleted_threads table → zero tombstones)
        let deleted = [];
        try {
          deleted = db.prepare('SELECT id FROM deleted_threads').all().map((r) => String(r.id));
        } catch {
          /* pre-v0.5.0 schema — no tombstones yet */
        }
        return { threads: rows.map((r) => JSON.parse(r.payload)), deleted, source: c.db, kind: 'sqlite' };
      } finally {
        db.close();
      }
    }
  }
  return null;
}

/* ------------------------------ manifest bits ------------------------------- */

/** captureIdOf — TWIN of src/host/capture-id.ts (the bake is node-side .mjs;
 * the TS module has no dist export — keep the two bytes in sync; drift-check
 * reviews both). Extension-stripped relpath, sanitized [^a-zA-Z0-9-] → '-'. */
function captureIdOf(relpath) {
  const noExt = relpath.replace(/\.[^./\\]+$/, '');
  return noExt.replace(/[^a-zA-Z0-9-]/g, '-');
}

const HEAD_SCAN_BYTES = 64 * 1024;
const HTML_RE = /\.html?$/i;

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Provenance head-scan — TWIN of src/server/standalone.ts scanHead (same
 *  64KB slice, same <title> + `Page saved with SingleFile` extraction). A
 *  dropped-in non-SingleFile html is allowed — it gets a title, no
 *  provenance. */
function scanHead(abs) {
  let head = '';
  try {
    const fd = openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(HEAD_SCAN_BYTES);
      const n = readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return {};
  }
  const out = {};
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  if (title) {
    const clean = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (clean) out.title = clean;
  }
  const sf = head.indexOf('Page saved with SingleFile');
  if (sf !== -1) {
    const url = /url:\s*(\S+)/.exec(head.slice(sf))?.[1];
    if (url) out.url = url;
    const rawDate = /saved date:\s*([^\n\r]+)/.exec(head.slice(sf))?.[1]?.trim();
    if (rawDate) {
      const t = Date.parse(rawDate);
      out.savedDate = Number.isFinite(t) ? new Date(t).toISOString() : rawDate;
    }
  }
  return out;
}

/** noteCount — ADVISORY ONLY: occurrences of `<single-file-note` in the FULL
 *  file (the ImportBar parses the LIVE iframe DOM and re-counts; this byte
 *  count may include empty-text notes and can lag a re-saved file). Streams
 *  in 1MB chunks with an overlap carry so a tag straddling the boundary
 *  counts exactly once (an occurrence needs 16 bytes; the carry is 15, so a
 *  full occurrence can never sit inside the carry and double-count).
 *  latin1 keeps byte === char (the tag is ASCII; UTF-8 continuation bytes
 *  can never spell '<'). */
function countNoteTags(abs) {
  const TAG = '<single-file-note';
  let count = 0;
  let carry = '';
  let len = 0;
  const fd = openSync(abs, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    while ((len = readSync(fd, buf, 0, buf.length, null)) > 0) {
      const s = carry + buf.subarray(0, len).toString('latin1');
      let idx = s.indexOf(TAG);
      while (idx !== -1) {
        count++;
        idx = s.indexOf(TAG, idx + 1);
      }
      carry = s.slice(-(TAG.length - 1));
    }
  } finally {
    closeSync(fd);
  }
  return count;
}

/** Recursive capture listing — TWIN of standalone.ts listCaptures (relative
 *  paths, '/'-separated; dot-entries skipped; .html/.htm files only). */
function listCaptures(dir, rel = '') {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listCaptures(path.join(dir, e.name), relPath));
    else if (e.isFile() && HTML_RE.test(e.name)) out.push(relPath);
  }
  return out.sort();
}

/* --------------------------- CSP-meta strip (twin) --------------------------- */

/* TWIN of src/server/standalone.ts CSP_META_RE (the bake is node-side .mjs;
 * no dist export of this constant exists — keep the bytes in sync, the
 * selftest pins the strip behavior on the same incident shapes the live
 * smoke found: unquoted LOWERCASE http-equiv, quoted, mixed-case). SingleFile
 * writes a freeze-CSP meta into saved pages; a static host serves captures
 * RAW, so the bake must strip it at bake time (the server strips at serve
 * time). Case-insensitive + tolerant of quoted/unquoted attr values. */
const CSP_META_RE = /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>\s*/gi;
/* TWIN of src/server/standalone.ts HEAD_SCAN_STEPS + HEAD_END_RE (the bake
 * is node-side .mjs; no dist export exists — keep the bytes in sync). The
 * 2026-10-23 preview E2E found real captures with </head> past 512KB
 * (inlined base64; largest ~1.26MB) and captures with NO literal </head>
 * (only <body) — the scan grows 512KB → 2MB → 4MB and accepts either as the
 * head-end boundary. */
const HEAD_SCAN_STEPS = [512 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024];
const HEAD_END_RE = /<\/head\s*>|<body[\s>]/i;
const HEAD_SCAN_MAX_BYTES = HEAD_SCAN_STEPS[HEAD_SCAN_STEPS.length - 1];

/** Copy one capture through the CSP-meta strip — the SAME math as
 *  standalone.ts serveCapture: ADAPTIVE head scan (512KB → 2MB → 4MB),
 *  strip CSP metas from the head part, tail bytes verbatim from the ORIGINAL
 *  head-end boundary byte offset (the strip regex matches ASCII-only meta
 *  markup, so multibyte content passes byte-identical). NEVER touches note
 *  cards — the only bytes removed are the CSP metas. No boundary in the
 *  scanned region → raw copy + loud log (the layer will fail to load on this
 *  capture; a strict CSP, if any, survives). Big files stream — only the
 *  head region is ever buffered. */
async function copyCaptureStripped(src, dst) {
  const size = statSync(src).size;
  // the head region is the ONLY thing held in memory for a 69MB capture
  let headStr = '';
  let headCloseIdx = -1;
  let read = 0;
  const fd = openSync(src, 'r');
  try {
    for (const step of HEAD_SCAN_STEPS) {
      const want = Math.min(step, size);
      if (want <= read) break; // no new territory at this step
      const buf = Buffer.alloc(want);
      read = readSync(fd, buf, 0, want, 0);
      headStr = buf.subarray(0, read).toString('utf8');
      headCloseIdx = headStr.search(HEAD_END_RE);
      if (headCloseIdx >= 0 || read >= size) break; // boundary found or EOF exhausted
    }
  } finally {
    closeSync(fd);
  }
  if (headCloseIdx < 0) {
    console.warn(
      `[bake-dom] capture ${path.basename(src)}: no </head>/<body> within ${HEAD_SCAN_MAX_BYTES} bytes — RAW copy (a strict CSP meta, if any, will block the layer on this capture)`,
    );
    await pipeline(createReadStream(src), createWriteStream(dst));
    return { stripped: -1, raw: true };
  }
  // TWIN of serveCapture's honest-degrade warn (review P2-4): a <body-shaped
  // false boundary inside a head attribute value leaves CSP metas surviving
  // silently — say it loudly (bytes stay exact either way).
  if (
    headStr.slice(headCloseIdx, headCloseIdx + 5).toLowerCase() === '<body' &&
    /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i.test(headStr.slice(headCloseIdx))
  ) {
    console.warn(
      `[bake-dom] capture ${path.basename(src)}: <body boundary matched but CSP meta(s) survive beyond it (possible false boundary in a head attribute) — the layer may be blocked on this capture`,
    );
  }
  const headPart = headStr.slice(0, headCloseIdx);
  let stripped = 0;
  const strippedHead = headPart.replace(CSP_META_RE, () => {
    stripped++;
    return '';
  });
  const outHeadBuf = Buffer.from(strippedHead, 'utf8');
  const restStart = Buffer.byteLength(headPart, 'utf8'); // file offset where the head-end boundary begins
  const ws = createWriteStream(dst);
  ws.write(outHeadBuf);
  if (size > restStart) {
    await pipeline(createReadStream(src, { start: restStart }), ws);
  } else {
    ws.end();
  }
  return { stripped, raw: false };
}

/* ------------------------------- app copy ----------------------------------- */

/** Ref-shape gate (the dom-annotakit equivalent of the vendored SB bake's
 *  ref-shape check): the Vite app must build with base './' — the copied
 *  index.html may reference only RELATIVE assets. A root-absolute src/href
 *  404s on every subpath deployment of a static host, and silently "works"
 *  only at the origin root. Fail LOUDLY (agents don't read warnings). */
function assertRelativeRefs(indexPath, forBase) {
  const html = readFileSync(indexPath, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"']*)["']/gi)].map((m) => m[1]);
  const bad = refs.filter((r) => r && r !== '#' && !/^(data:|https?:|mailto:)/i.test(r) && r.startsWith('/'));
  if (bad.length) {
    console.error(
      `[bake-dom] FATAL: ${path.basename(indexPath)} references ROOT-ABSOLUTE asset(s): ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}\n` +
        `  The host app must build with Vite base './' (vite.config.ts) — a static host serves files RAW, so root-absolute refs break on every subpath deployment.\n` +
        `  Rebuild the app (\`bun run build\`) before baking.`,
    );
    process.exit(1);
  }
  return refs;
}

/** Recursive copy (preserving structure) — used for the Vite app build. */
function copyTree(srcDir, dstDir) {
  mkdirSync(dstDir, { recursive: true });
  const out = [];
  for (const e of readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    if (e.isDirectory()) out.push(...copyTree(s, d));
    else if (e.isFile()) {
      copyFileSync(s, d);
      out.push(d);
    }
  }
  return out;
}

/* ---------------------- --base (subpath serving, vendored) ------------------- */

/** Vendored v0.6.9 applyBase, adapted: with the relative-refs gate already
 *  passed, inject `<base href>` as the FIRST child of <head> — re-anchors
 *  every relative ref so the build serves under any subpath, even on servers
 *  that 308-strip trailing slashes. Root-relative only ("/x/"), no scheme;
 *  normalized to a trailing slash; idempotent (same base → byte-identical);
 *  re-targetable (different base → replaced, logged). */
function applyBase(outDir) {
  const raw = flagValue('base');
  if (raw === undefined) return;
  if (!raw.startsWith('/') || /^[a-zA-Z]+:/.test(raw) || !raw.trim()) {
    console.error(`[bake-dom] --base must be a root-relative path like /review/ (got ${JSON.stringify(raw)})`);
    process.exit(1);
  }
  const base = raw.endsWith('/') ? raw : `${raw}/`;
  if (base !== raw) console.log(`[bake-dom] --base normalized to trailing slash: ${base} (a slashless base is silently catastrophic)`);
  const indexPath = path.join(outDir, 'index.html');
  if (!existsSync(indexPath)) {
    console.error(`[bake-dom] --base needs <outDir>/index.html — was the app copied? (${indexPath})`);
    process.exit(1);
  }
  const html = readFileSync(indexPath, 'utf8');
  const existing = html.match(/<base\s+href=["']([^"']*)["']\s*\/?>/i);
  if (existing && existing[1] === base) {
    console.log(`[bake-dom] <base href="${base}"> already present — nothing to do (idempotent)`);
    return;
  }
  if (existing) console.log(`[bake-dom] replacing existing <base href="${existing[1]}"> with "${base}"`);
  const headOpen = html.match(/<head[^>]*>/i);
  if (!headOpen || headOpen.index === undefined) {
    console.error('[bake-dom] no <head> element found in index.html — cannot inject <base>');
    process.exit(1);
  }
  const at = headOpen.index + headOpen[0].length;
  let out = html.slice(0, at) + `\n    <base href="${base}">` + html.slice(at);
  if (existing) out = out.replace(existing[0], '');
  writeFileSync(indexPath, out);
  const clean = base.replace(/\/$/, '');
  console.log(`[bake-dom] injected <base href="${base}"> into index.html — the bake now serves under any subpath`);
  console.log(`[bake-dom] reverse-proxy mapping for the pretty URL:  ${clean} → this directory`);
  console.log(`[bake-dom] entry URL: <origin>${clean}  (servers that strip trailing slashes redirect ${clean}/ → ${clean} — expected)`);
}

/* --------------------------------- selftest --------------------------------- */

if (args.includes('--selftest')) {
  let stPassed = 0;
  let stFailed = 0;
  const stCheck = (label, cond, detail = '') => {
    if (cond) {
      stPassed++;
      console.log(`  ok  ${label}`);
    } else {
      stFailed++;
      console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    }
  };
  const SELF = [process.execPath, fileURLToPath(import.meta.url)];

  // ---- 1. repo-shape probes (the vendored set — the door this bake shares
  //         with the server + the client runtime gate)
  stCheck('owner/name passes through unchanged', normalizeGhRepoInput('octocat/widgets') === 'octocat/widgets');
  stCheck('charset `_`, `.`, `-` pass through', normalizeGhRepoInput('octo_cat/widgets-1.0') === 'octo_cat/widgets-1.0');
  stCheck('case passes through', normalizeGhRepoInput('Octocat/Widgets') === 'Octocat/Widgets');
  stCheck('surrounding whitespace trims', normalizeGhRepoInput('  octocat/widgets\n') === 'octocat/widgets');
  stCheck('github: shorthand NORMALIZES (the dead-mirror incident shape)', normalizeGhRepoInput('github:octocat/widgets') === 'octocat/widgets');
  stCheck('https URL normalizes', normalizeGhRepoInput('https://github.com/octocat/widgets.git') === 'octocat/widgets');
  stCheck('ssh + port URL normalizes (the S9 port fix)', normalizeGhRepoInput('ssh://git@github.com:443/octocat/widgets.git') === 'octocat/widgets');
  stCheck('trailing-path URL keeps owner/name', normalizeGhRepoInput('https://github.com/octocat/widgets/tree/main') === 'octocat/widgets');
  stCheck('3-segment shorthand REJECTED', normalizeGhRepoInput('github:octocat/widgets/extra') === null);
  stCheck('bare shorthand REJECTED', normalizeGhRepoInput('github:octocat') === null);
  stCheck('slash-less REJECTED', normalizeGhRepoInput('octocat') === null);
  stCheck('empty REJECTED', normalizeGhRepoInput('') === null);
  stCheck('parser OUTPUT re-validated (colon owner, URL form)', normalizeGhRepoInput('https://github.com/gh:octocat/widgets') === null);
  stCheck('parser OUTPUT re-validated (colon owner, shorthand form)', normalizeGhRepoInput('github:gh:octocat/widgets') === null);

  // ---- scratch tree (subprocess cwd = scratch so the cwd-relative defaults
  //      ./dist-app, ./dist/layer.mjs, ./captures resolve INSIDE the scratch)
  const os = await import('node:os');
  const scratch = path.join(mkdtempSync(path.join(os.tmpdir(), 'bake-dom-selftest-')), 'tree');
  mkdirSync(path.join(scratch, 'dist-app', 'assets'), { recursive: true });
  mkdirSync(path.join(scratch, 'dist'), { recursive: true });
  mkdirSync(path.join(scratch, 'captures', 'sub'), { recursive: true });
  mkdirSync(path.join(scratch, 'store'), { recursive: true });
  writeFileSync(path.join(scratch, 'dist', 'layer.mjs'), '// selftest layer stub\n');
  writeFileSync(path.join(scratch, 'dist-app', 'assets', 'app.js'), '// app\n');
  writeFileSync(
    path.join(scratch, 'dist-app', 'index.html'),
    '<!doctype html><html><head><title>App</title><link rel="stylesheet" href="./assets/app.css"></head><body><script type="module" src="./assets/app.js"></script></body></html>',
  );
  // capture 1: CSP meta (the REAL SingleFile shape: unquoted lowercase) +
  // provenance + 2 note cards (must SURVIVE the bake)
  const c1 =
    '<!-- Page saved with SingleFile  url: https://example.com/x  saved date: Tue Oct 21 2026 12:00:00 GMT+0000 -->\n' +
    '<!doctype html><html><head><title>Cap One</title>' +
    "<meta http-equiv=content-security-policy content=\"default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'\">" +
    '<meta charset="utf-8"></head><body><single-file-note data-note-id=1 data-note-offset-x=1 data-note-offset-y=2><template shadowrootmode=open><blockquote><textarea dir=auto>hello</textarea></blockquote></template></single-file-note>' +
    '<single-file-note data-note-id=2></single-file-note><button id="go">Go</button></body></html>';
  writeFileSync(path.join(scratch, 'captures', 'c1.html'), c1);
  // capture 2 (nested): NO </head> in the head slice → raw-copy fallback
  const c2 = '<!doctype html><html><head><title>Cap Two</title><meta charset="utf-8">';
  writeFileSync(path.join(scratch, 'captures', 'sub', 'c2.html'), c2);
  // store: one live thread + one legacy zombie (live row + standing tombstone)
  const tOk = { id: 'th_ok_1', number: 1, storyId: 'c1', status: 'open', target: { kind: 'pin', selector: {}, context: { tag: 'button' }, bbox: { x: 1, y: 1, w: 2, h: 2 } }, comments: [{ id: 'c_1', author: 'a', body: 'b' }] };
  const tZombie = { id: 'th_zombie_1', number: 2, storyId: 'c1', status: 'open', target: { kind: 'pin', selector: {}, context: { tag: 'button' }, bbox: { x: 1, y: 1, w: 2, h: 2 } }, comments: [] };
  writeFileSync(path.join(scratch, 'store', 'threads.json'), JSON.stringify({ threads: [tOk, tZombie], deleted: ['th_zombie_1'] }));

  const runSelf = (cliArgs) => {
    const r = spawnSync(SELF[0], [SELF[1], ...cliArgs], {
      encoding: 'utf8',
      cwd: scratch,
      env: { ...process.env, ANNOTAKIT_STORE_PATH: '', ANNOTAKIT_GH_TOKEN: '', ANNOTAKIT_GH_REPO: '' },
      timeout: 60_000,
    });
    return { code: r.status ?? 1, out: String(r.stdout ?? '') + String(r.stderr ?? '') };
  };

  // ---- 2. bad repo charset → exit 1 BEFORE any write (outDir untouched)
  {
    const out = path.join(scratch, 'out-badrepo');
    const r = runSelf([out, '--store', 'store/threads.json', '--gh-repo', 'github:octocat/widgets/extra']);
    stCheck('bad repo charset → exit 1', r.code === 1, `code=${r.code} out=${r.out.slice(0, 200)}`);
    stCheck('bad repo charset → exit BEFORE any write (outDir missing)', !existsSync(out));
    stCheck('bad repo message names the fix', /owner\/name/.test(r.out), r.out.slice(0, 120));
  }
  // ---- 3. missing store → clear exit 1 (no silent empty seed)
  {
    const out = path.join(scratch, 'out-nostore');
    const r = runSelf([out]);
    stCheck('missing store → exit 1', r.code === 1, `code=${r.code}`);
    stCheck('missing store message names --store + the tool-repo paths', /--store/.test(r.out) && /annotakit-dom/.test(r.out));
    stCheck('missing store → exit BEFORE any write (outDir missing)', !existsSync(out));
  }
  // ---- 4. mini bake: seed shape + gh absence + manifest + app copy +
  //         layer copy + CSP strip + note-card preservation + raw fallback
  /* s6/M8: the tokenless PUBLIC form bakes local-only (no project section);
   * the dev form resolves the baked board target+token. Probe the form. */
  const bakedTokenProbe = readFileSync(path.join(toolRoot, 'src', 'shared', 'bakedCreds.ts'), 'utf8').match(/BAKED_GH_TOKEN: string = '([^']*)'/)?.[1] ?? '';
  const DEV_BAKED_FORM = bakedTokenProbe.length > 0;
  {
    const out = path.join(scratch, 'out-main');
    const r = runSelf([out, '--store', 'store/threads.json']);
    stCheck('mini bake → exit 0', r.code === 0, `code=${r.code} out=${r.out.slice(0, 400)}`);
    const seed = existsSync(path.join(out, 'annotakit-threads.json')) ? JSON.parse(readFileSync(path.join(out, 'annotakit-threads.json'), 'utf8')) : null;
    stCheck('threads.json written (seed + static marker)', seed != null);
    if (seed) {
      stCheck('seed shape {threads, deleted}', Array.isArray(seed.threads) && Array.isArray(seed.deleted));
      stCheck('zombie row SUPPRESSED (delete-wins, A1)', seed.threads.length === 1 && seed.threads[0].id === 'th_ok_1', JSON.stringify(seed.threads.map((t) => t.id)));
      stCheck('tombstone CARRIED in deleted', seed.deleted.includes('th_zombie_1'));
    }
    stCheck(DEV_BAKED_FORM
      ? 'gh.json written PROJECT-ONLY (D6: no issues token+repo, but the baked project section resolves — target AND token)'
      : 'gh.json ABSENT (public tokenless form: no baked creds → local-only bake)', (() => {
      const p2 = path.join(out, 'annotakit-gh.json');
      if (!DEV_BAKED_FORM) return !existsSync(p2);
      if (!existsSync(p2)) return false;
      const g = JSON.parse(readFileSync(p2, 'utf8'));
      return !g.token && !g.repo && typeof g.project?.target === 'string' && /\/projects\/\d+$/.test(g.project.target) && typeof g.project?.token === 'string' && g.project.token.length > 0;
    })());
    const mf = existsSync(path.join(out, 'dom-annotakit-manifest.json')) ? JSON.parse(readFileSync(path.join(out, 'dom-annotakit-manifest.json'), 'utf8')) : null;
    stCheck('manifest written {generatedAt, captures}', mf != null && typeof mf.generatedAt === 'string' && Array.isArray(mf.captures));
    if (mf) {
      stCheck('manifest lists both captures (recursive)', mf.captures.length === 2, JSON.stringify(mf.captures.map((c) => c.relpath)));
      const c1e = mf.captures.find((c) => c.relpath === 'c1.html');
      stCheck('manifest entry: id via captureIdOf', c1e?.id === 'c1');
      stCheck('manifest entry: relpath + size', c1e?.relpath === 'c1.html' && c1e?.size === c1.length);
      stCheck('manifest entry: title via head-scan', c1e?.title === 'Cap One');
      stCheck('manifest entry: SingleFile provenance url + savedDate', c1e?.url === 'https://example.com/x' && typeof c1e?.savedDate === 'string');
      stCheck('manifest entry: noteCount ADVISORY byte count (2 tags)', c1e?.noteCount === 2, `got ${c1e?.noteCount}`);
      stCheck('manifest entry: nested relpath preserved', mf.captures.some((c) => c.relpath === 'sub/c2.html'));
    }
    stCheck('index.html copied', existsSync(path.join(out, 'index.html')) && readFileSync(path.join(out, 'index.html'), 'utf8') === readFileSync(path.join(scratch, 'dist-app', 'index.html'), 'utf8'));
    stCheck('assets/* copied', existsSync(path.join(out, 'assets', 'app.js')));
    stCheck('layer.mjs copied', existsSync(path.join(out, 'layer.mjs')));
    const bakedC1 = existsSync(path.join(out, 'captures', 'c1.html')) ? readFileSync(path.join(out, 'captures', 'c1.html'), 'utf8') : '';
    stCheck('capture baked: CSP meta STRIPPED (0 occurrences)', !/http-equiv\s*=\s*["']?content-security-policy/i.test(bakedC1));
    stCheck('capture baked: everything else intact (charset meta, title, body)', bakedC1.includes('<meta charset="utf-8">') && bakedC1.includes('Cap One') && bakedC1.includes('<button id="go">'));
    stCheck('capture baked: SingleFile note CARDS PRESERVED (2 — never stripped)', (bakedC1.match(/<single-file-note/g) || []).length === 2);
    stCheck('capture baked: byte size = source − CSP meta bytes (and < source)', statSync(path.join(out, 'captures', 'c1.html')).size === bakedC1.length && bakedC1.length < c1.length);
    const bakedC2 = existsSync(path.join(out, 'captures', 'sub', 'c2.html')) ? readFileSync(path.join(out, 'captures', 'sub', 'c2.html'), 'utf8') : '';
    stCheck('no-</head> capture: RAW-copy fallback (byte-identical)', bakedC2 === c2);
  }
  // ---- 5. index.html relative-ref gate: root-absolute refs fail LOUDLY
  {
    const badApp = path.join(scratch, 'dist-bad-app');
    mkdirSync(badApp, { recursive: true });
    writeFileSync(path.join(badApp, 'index.html'), '<!doctype html><html><head></head><body><script src="/assets/app.js"></script></body></html>');
    const r = runSelf([path.join(scratch, 'out-badapp'), '--store', 'store/threads.json', '--app', 'dist-bad-app']);
    stCheck('root-absolute asset ref → exit 1', r.code === 1, `code=${r.code}`);
    stCheck('ref-gate message names Vite base ./', /base '.\/'|base "\.\/"|root-absolute/i.test(r.out), r.out.slice(0, 200));
  }
  // ---- 6. --base: injection + idempotency (the only rewriting implemented)
  {
    const out = path.join(scratch, 'out-base');
    const r1 = runSelf([out, '--store', 'store/threads.json', '--base', '/review']);
    stCheck('--base bake → exit 0', r1.code === 0, `code=${r1.code}`);
    const html1 = existsSync(path.join(out, 'index.html')) ? readFileSync(path.join(out, 'index.html'), 'utf8') : '';
    stCheck('--base injects <base href="/review/"> (normalized trailing slash)', html1.includes('<base href="/review/">'));
    const r2 = runSelf([out, '--store', 'store/threads.json', '--base', '/review/']);
    const html2 = existsSync(path.join(out, 'index.html')) ? readFileSync(path.join(out, 'index.html'), 'utf8') : '';
    stCheck('--base idempotent (same base → byte-identical)', html1 === html2 && html2.includes('<base href="/review/">'));
    const badBase = runSelf([path.join(scratch, 'out-badbase'), '--store', 'store/threads.json', '--base', 'http://x/']);
    stCheck('--base rejects scheme/root-relative violations → exit 1', badBase.code === 1);
  }
  // ---- 7. gh.json written when token+repo resolve (labels default)
  {
    const out = path.join(scratch, 'out-gh');
    const r = runSelf([out, '--store', 'store/threads.json', '--gh-token', ['ghp_', 'selftest', 'token123'].join(''), '--gh-repo', 'github:octocat/widgets']);
    stCheck('gh bake → exit 0 (shorthand normalized)', r.code === 0, `code=${r.code}`);
    const gh = existsSync(path.join(out, 'annotakit-gh.json')) ? JSON.parse(readFileSync(path.join(out, 'annotakit-gh.json'), 'utf8')) : null;
    stCheck('gh.json written {token, repo, labels, pollMs}', gh != null && gh.token === ['ghp_', 'selftest', 'token123'].join('') && gh.repo === 'octocat/widgets');
    stCheck('gh.json default label dom-annotakit', Array.isArray(gh?.labels) && gh.labels.includes('dom-annotakit'));
    // re-bake SAME outDir without the issues token → the ISSUES keys drop out;
    // the D6 project section survives (the board target resolves from bakedCreds)
    const r2 = runSelf([out, '--store', 'store/threads.json']);
    stCheck('re-bake without token → exit 0', r2.code === 0, `code=${r2.code}`);
    stCheck(DEV_BAKED_FORM
      ? 're-bake: issues keys GONE, project section STAYS with its token (D6 + review P1)'
      : 're-bake: issues keys GONE (public tokenless form: the stale gh.json is REMOVED — local-only)', (() => {
      const p2 = path.join(out, 'annotakit-gh.json');
      if (!DEV_BAKED_FORM) return !existsSync(p2);
      if (!existsSync(p2)) return false;
      const g = JSON.parse(readFileSync(p2, 'utf8'));
      return !g.token && !g.repo && typeof g.project?.target === 'string' && typeof g.project?.token === 'string' && g.project.token.length > 0;
    })());
  }
  // ---- 8. empty captures dir → warn + succeed with an empty manifest
  {
    const emptyCaps = path.join(scratch, 'caps-empty');
    mkdirSync(emptyCaps, { recursive: true });
    const out = path.join(scratch, 'out-empty');
    const r = runSelf([out, '--store', 'store/threads.json', '--captures', 'caps-empty']);
    stCheck('empty captures dir → bake SUCCEEDS (exit 0)', r.code === 0, `code=${r.code} out=${r.out.slice(0, 200)}`);
    stCheck('empty captures dir → warns', /no .*captures/i.test(r.out));
    const mf = existsSync(path.join(out, 'dom-annotakit-manifest.json')) ? JSON.parse(readFileSync(path.join(out, 'dom-annotakit-manifest.json'), 'utf8')) : null;
    stCheck('empty captures dir → EMPTY manifest (sidebar shows "no captures")', mf != null && Array.isArray(mf.captures) && mf.captures.length === 0);
  }

  rmSync(path.join(scratch, '..'), { recursive: true, force: true });
  console.log(stFailed ? `bake-dom selftest: FAIL (${stFailed} failed, ${stPassed} passed)` : `bake-dom selftest: PASS (${stPassed} probes)`);
  process.exit(stFailed ? 1 : 0);
}

/* ------------------------------- the bake run ------------------------------- */

// outDir is REQUIRED — this bake has no single blessed output dir (unlike the
// SB examples/nimbus default); a silent default would write a deployment
// somewhere surprising.
if (positional === undefined) {
  console.error(
    `[bake-dom] FATAL: <outDir> is required.\n` +
      `  Usage: node scripts/bake-dom-annotakit.mjs <outDir> [--store <db-or-json>] [--app <dist-app dir>] [--captures <dir>] [--gh-token t] [--gh-repo owner/name] [--gh-labels a,b] [--gh-poll-sec N] [--env-file path] [--base /review/]`,
  );
  process.exit(1);
}
const outDir = path.resolve(positional);
const appDir = optValue('app') ?? path.resolve('dist-app');
const capturesDir = optValue('captures') ?? path.resolve('captures');
const layerFile = path.resolve('dist', 'layer.mjs');

// GH config resolved FIRST (vendored S9/E-bake): a malformed --gh-repo must
// exit 1 BEFORE any file is written — a half-baked outDir (fresh seed, missing
// gh.json) hides the real failure from the operator.
const gh = resolveGhConfig();

const found = await readStoreThreads();
const tombstones = new Set(found ? found.deleted : []);
// A1 delete-wins, seed-side honesty (vendored): a legacy zombie row (live row
// + standing tombstone) must not ride the seed as LIVE — a fresh visitor has
// no persisted doc, and without this filter the zombie would resurrect for
// exactly the audience the tombstone list serves.
const threads = (found ? found.threads : []).filter((t) => t && t.id != null && !tombstones.has(t.id));
const zombies = found ? found.threads.length - threads.length : 0;
const deleted = [...tombstones];

// ---- preflight: everything that can fail fails BEFORE the first write ----
if (!existsSync(appDir) || !existsSync(path.join(appDir, 'index.html'))) {
  console.error(
    `[bake-dom] FATAL: no app build at ${appDir} (index.html missing) — run \`bun run build\` first (the Vite host build lands in dist-app/). Use --app <dir> to point elsewhere.`,
  );
  process.exit(1);
}
assertRelativeRefs(path.join(appDir, 'index.html')); // the gate runs on the SOURCE; the copy is byte-identical
if (!existsSync(layerFile)) {
  console.error(`[bake-dom] FATAL: no layer bundle at ${layerFile} — run \`bun run build\` first (tsup emits dist/layer.mjs). A static bake without the layer is a review surface that cannot pin.`);
  process.exit(1);
}
const captureRelPaths = listCaptures(capturesDir);
// manifest collision check — D2b: basename collisions FAIL LOUDLY (a silent
// merge would key two captures' threads to one id). Same contract as the
// server's buildManifest.
{
  const seen = new Map();
  for (const relpath of captureRelPaths) {
    const id = captureIdOf(relpath);
    const clash = seen.get(id);
    if (clash) {
      console.error(
        `[bake-dom] FATAL: capture id collision — '${clash}' and '${relpath}' both map to id '${id}'. Rename one of them (rename = new identity; threads stay keyed to the old id).`,
      );
      process.exit(1);
    }
    seen.set(id, relpath);
  }
}

// ---- writes ----
console.log(`[bake-dom] baking into ${outDir}`);
mkdirSync(outDir, { recursive: true });

// 1. seed — ALWAYS written (even empty): the static-mode marker + the seed.
const seedOut = path.join(outDir, 'annotakit-threads.json');
writeFileSync(seedOut, JSON.stringify({ threads, deleted }, null, 2));
{
  const open = threads.filter((t) => t.status === 'open').length;
  const rejected = threads.filter((t) => t.status === 'rejected').length;
  console.log(`[bake-dom] wrote ${seedOut} (${threads.length} threads, ${open} open, ${deleted.length} tombstone(s)${rejected > 0 ? `, ${rejected} rejected` : ''}) — static-mode marker + seed`);
  if (zombies > 0) console.log(`[bake-dom] suppressed ${zombies} zombie row(s) (live row + tombstone — delete-wins, A1; they ride the seed as deleted only)`);
}

// 2. gh.json — when token+repo resolve (issues mirror), and/or when a project
// section resolves (D6 spec board); a stale one from a previous bake is
// removed only when NEITHER resolves. The vendored issues shape stays
// byte-compatible; the project section is additive (unknown fields pass the
// vendored probeBakedGhConfig cast).
const ghOut = path.join(outDir, 'annotakit-gh.json');
if ((gh.token && gh.repo) || gh.project) {
  const payload = {};
  if (gh.token && gh.repo) {
    Object.assign(payload, { token: gh.token, repo: gh.repo, labels: gh.labels, pollMs: gh.pollMs });
    const masked = gh.token.length > 8 ? `${gh.token.slice(0, 4)}…${gh.token.slice(-3)}` : '****';
    console.log(`[bake-dom] wrote ${ghOut} — client-side publishing EMBEDDED (token ${masked} — explicit operator choice: delivery beats secrecy) → ${gh.repo} · labels: ${gh.labels.join(', ')} · poll ${Math.round(gh.pollMs / 1000)}s`);
  }
  if (gh.project) {
    payload.project = gh.project;
    const masked = gh.project.token && gh.project.token.length > 8 ? `${gh.project.token.slice(0, 4)}…${gh.project.token.slice(-3)}` : '****';
    console.log(`[bake-dom] project spec section: target ${gh.project.target} + token ${masked} (static board sync arms when the deployment runs the static shape — review P1: the section must carry the token or projectClient can never arm)`);
  }
  writeFileSync(ghOut, JSON.stringify(payload, null, 2));
} else {
  if (existsSync(ghOut)) {
    rmSync(ghOut);
    console.log('[bake-dom] removed stale annotakit-gh.json (no token+repo, no project section resolved) — build is local-only again');
  } else {
    console.log('[bake-dom] no GH token+repo / project target resolved — NOT writing annotakit-gh.json (local-only build; the panel settings can configure publishing at runtime)');
  }
}

// 3. app build — index.html + assets/* (the bake owns the assets/ subtree:
// a rebuild re-hashes names; wipe it so ghosts never linger).
{
  const dstAssets = path.join(outDir, 'assets');
  const hadStale = existsSync(dstAssets) ? readdirSync(dstAssets).length : 0;
  if (hadStale) rmSync(dstAssets, { recursive: true, force: true });
  const copied = copyTree(appDir, outDir);
  const bytes = copied.reduce((n, f) => n + statSync(f).size, 0);
  console.log(`[bake-dom] copied app build ${appDir} → ${copied.length} file(s), ${(bytes / 1024).toFixed(1)}KB${hadStale ? ` (cleaned ${hadStale} stale asset(s))` : ''}`);
}

// 4. layer.mjs
copyFileSync(layerFile, path.join(outDir, 'layer.mjs'));
console.log(`[bake-dom] copied layer bundle ${layerFile} (${(statSync(layerFile).size / 1024).toFixed(1)}KB) → layer.mjs`);

// 5. captures — every capture through the CSP-meta strip; note cards NEVER touched.
{
  if (captureRelPaths.length === 0) {
    console.warn(`[bake-dom] WARNING: no .html captures in ${capturesDir} — baking with an EMPTY manifest (the sidebar will show "no captures"); the deployment is still valid.`);
  }
  // wipe the bake-owned captures subtree: a capture removed from --captures
  // must not linger as a ghost in the deployment
  const dstCaps = path.join(outDir, 'captures');
  if (existsSync(dstCaps)) rmSync(dstCaps, { recursive: true, force: true });
  let strippedTotal = 0;
  let rawTotal = 0;
  let bytesTotal = 0;
  for (const relpath of captureRelPaths) {
    const src = path.join(capturesDir, relpath);
    const dst = path.join(outDir, 'captures', relpath);
    mkdirSync(path.dirname(dst), { recursive: true });
    const res = await copyCaptureStripped(src, dst);
    if (res.raw) rawTotal++;
    else if (res.stripped > 0) {
      strippedTotal += res.stripped;
      console.log(`[bake-dom] capture ${relpath}: ${res.stripped} CSP meta(s) stripped (${(statSync(dst).size / 1024).toFixed(1)}KB) — note cards untouched`);
    }
    bytesTotal += statSync(dst).size;
  }
  console.log(`[bake-dom] captures: ${captureRelPaths.length} copied (${(bytesTotal / 1024 / 1024).toFixed(2)}MB; ${strippedTotal} CSP meta(s) stripped total${rawTotal ? `, ${rawTotal} RAW (no head-end boundary in scan — logged above)` : ''}) — SingleFile note CARDS preserved (importable data; the strip is live-DOM-only)`);
}

// 6. manifest — the SAME shape the server's dynamic route serves, + noteCount.
{
  const manifest = { generatedAt: new Date().toISOString(), captures: [] };
  for (const relpath of captureRelPaths) {
    const abs = path.join(capturesDir, relpath);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue; // vanished mid-scan — skip it this pass
    }
    manifest.captures.push({ id: captureIdOf(relpath), relpath, size, ...scanHead(abs), noteCount: countNoteTags(abs) });
  }
  const mfOut = path.join(outDir, 'dom-annotakit-manifest.json');
  writeFileSync(mfOut, JSON.stringify(manifest, null, 2));
  const withNotes = manifest.captures.filter((c) => (c.noteCount ?? 0) > 0).length;
  console.log(`[bake-dom] wrote ${mfOut} (${manifest.captures.length} capture(s)${withNotes ? `, ${withNotes} carrying SingleFile notes (noteCount is ADVISORY — the ImportBar parses the live DOM)` : ''})`);
}

// 7. --base (subpath serving) — last: it rewrites the COPIED index.html.
applyBase(outDir);

console.log(`[bake-dom] done — serve with: python3 scripts/serve-static.py ${JSON.stringify(outDir)} <port>`);
