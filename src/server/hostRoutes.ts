/**
 * dom-annotakit — the D10–D14 host REST seam (NEW; mounted by standalone.ts
 * BEFORE serveStatic's method gate — §9 P1-C).
 *
 * Owns every surface the review-shell UX added on top of the vendored engine
 * (zero engine edits; the engine's own doors stay byte-identical):
 *
 *   GET    /dom-annotakit-spec.json          the merged spec catalog + the
 *                                            session compose-context echo
 *   PUT    /dom-annotakit-spec-context        set/clear the compose context
 *   POST   /dom-annotakit-captures           upload a capture (JSON
 *                                            {name, content[, overwrite]})
 *   POST   /dom-annotakit-project.json       {action:'pass'} — force a
 *                                            Projects-mirror reconcile and
 *                                            answer with the fresh status
 *
 * Plus the two pure helpers the standalone wiring consumes:
 *
 *   - resolveCapturesDir(): DOM_AK_CAPTURES_DIR env > config
 *     "captures".dir (tool-instance-relative) > process.cwd() — the
 *     designated captures folder (§D12, default = the directory you started
 *     the server in; the vendored deployment pins it via config).
 *   - the annotation REWRITE seam (§D10): the vendored composer POSTs plain
 *     JSON; when a session context is set, thread-create/comment-add bodies
 *     gain the missing @epic:/@story: directive LINES before the engine
 *     reads them. The wrapper re-emits BUFFERED bytes (the original stream
 *     is consumed exactly once) and carries `socket` + corrected
 *     content-length so the engine's loopback gate + readBody behave
 *     identically (§9 P2-4). The engine's 2MB cap is enforced at pre-load —
 *     a hostile body never buffers unbounded server-side.
 *
 * Security (§9 P1-B): with capturesDir at a PROJECT ROOT, /captures/* must
 * NEVER become a read-only server over the repo. The gate is the manifest
 * itself — a relpath is servable IFF the current manifest build lists it
 * (same non-recursive/dot-skip/denylist/extension rules, one source of
 * truth). /captures/.env, /captures/.git/…, /captures/package.json → 404.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import {
  applySpecContext,
  buildSpecIndex,
  mergeCatalog,
  type SpecCatalog,
  type SpecContext,
} from '../shared/specCatalog';
import type { ProjectMirror } from './projectMirror';

/* ------------------------- captures dir resolution -------------------------- */

export interface CapturesDirConfig {
  /** absolute captures directory */
  dir: string;
  /** recursive scan (opt-in; denylist applies) */
  recursive: boolean;
  /** where the decision came from — surfaced in boot logs + the manifest error */
  source: 'env' | 'config' | 'default-cwd';
}

/** §D12 + §9 fold 8: env > config (tool-instance-relative) > cwd default. */
export function resolveCapturesDir(
  rawConfig: Record<string, unknown> | null,
  opts: { repoRoot: string; cwd: string; env?: NodeJS.ProcessEnv },
): CapturesDirConfig {
  const env = opts.env ?? process.env;
  const section = (rawConfig?.captures ?? null) as { dir?: unknown; recursive?: unknown } | null;
  /* recursive is OPT-IN in every branch (§D12: the default scan is top-level
   * only — a project root carries dist-app/, public/, skills/ … that must
   * never become captures by accident). */
  const recursive = section?.recursive === true;
  if (typeof env?.DOM_AK_CAPTURES_DIR === 'string' && env.DOM_AK_CAPTURES_DIR.trim()) {
    return { dir: path.resolve(env.DOM_AK_CAPTURES_DIR.trim()), recursive, source: 'env' };
  }
  if (typeof section?.dir === 'string' && section.dir.trim()) {
    const dir = path.resolve(opts.repoRoot, section.dir.trim());
    return { dir, recursive, source: 'config' };
  }
  return { dir: path.resolve(opts.cwd), recursive, source: 'default-cwd' };
}

/** Recursive-scan denylist (§9 fold 6): the real host-tree hazards (68 stray
 *  html files live under skills/ + public/) + the build/vendor dirs. Dot-dirs
 *  are ALWAYS skipped by the scan itself. Non-recursive never needs this. */
export const RECURSIVE_DENY = new Set([
  'node_modules', '.next', 'dist', 'dist-app', 'build', 'out', 'coverage',
  'skills', 'public', 'examples', 'tests', 'db', 'download', 'upload', 'src',
  'prisma', 'mini-services', 'annotakit',
]);

const HTML_RE = /\.html?$/i;

/** Top-level (or denylisted-recursive) *.html listing — relpaths relative
 *  to the captures dir, '/'-separated, sorted (the manifest contract). */
export function listCaptures(dir: string, recursive: boolean, rel = ''): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (recursive && !RECURSIVE_DENY.has(e.name)) out.push(...listCaptures(path.join(dir, e.name), recursive, relPath));
    } else if (e.isFile() && HTML_RE.test(e.name)) {
      out.push(relPath);
    }
  }
  return out.sort();
}

/* --------------------------- the manifest manager --------------------------- */

export interface ManifestCapture {
  id: string;
  relpath: string;
  title?: string;
  url?: string;
  savedDate?: string;
  size: number;
}
export interface ManifestJson {
  generatedAt: string;
  captures: ManifestCapture[];
}

const HEAD_SCAN_BYTES = 64 * 1024;

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Provenance head-scan: <title> + SingleFile's `Page saved with … / url: /
 *  saved date:` header comment (dropped-in non-SingleFile html is allowed). */
export function scanHead(abs: string): { title?: string; url?: string; savedDate?: string } {
  let head = '';
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(HEAD_SCAN_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {};
  }
  const out: { title?: string; url?: string; savedDate?: string } = {};
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  if (title) {
    const clean = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (clean) out.title = clean;
  }
  const sf = head.indexOf('Page saved with SingleFile');
  if (sf !== -1) {
    const url = /url:\s*(\S+)/.exec(head.slice(sf))?.[1];
    if (url) out.url = url;
    /* s6 zen-sweep live-find: SingleFile's real shape is MULTI-line (each
     * provenance field on its own line) but a single-line comment shape
     * (the synthetic fixture; any re-saved oddity) ran [^\n\r]+ past the
     * `-->` and swallowed the whole document into savedDate. Stop at the
     * comment close / next tag as well, then strip any bare `-->`. */
    const rawDate = /saved date:\s*([^\n\r<]+)/.exec(head.slice(sf))?.[1]?.trim().replace(/\s*-->\s*$/, '').trim();
    if (rawDate) {
      const t = Date.parse(rawDate);
      out.savedDate = Number.isFinite(t) ? new Date(t).toISOString() : rawDate;
    }
  }
  return out;
}

/** captureIdOf lives in src/host/capture-id.ts (browser-shared, pure). The
 *  server bundle re-implements the 2-liner to keep host/ imports out of the
 *  server graph (same fingerprint as capture-id.ts — see scripts tests). */
function captureIdOf(relpath: string): string {
  const noExt = relpath.replace(/\.[^./\\]+$/, '');
  return noExt.replace(/[^a-zA-Z0-9-]/g, '-');
}

export interface CapturesManager {
  readonly dir: string;
  readonly recursive: boolean;
  readonly source: CapturesDirConfig['source'];
  buildManifest(): { ok: true; json: ManifestJson } | { ok: false; error: string };
  /** §9 P1-B: the SERVE GATE — a relpath is servable iff the current
   *  manifest build lists it. Manifest failure = gate closed (404 all). */
  isServableRel(rel: string): boolean;
  /** Upload one capture. Tracked-ness decides the durability action. */
  upload(name: string, content: string, overwrite: boolean, git?: GitWorkdir): Promise<UploadResult>;
  /** Explicit cache invalidation (uploads call it; the mtime key is
   *  the fast path, this is the correctness backstop). */
  invalidate(): void;
}

export type UploadResult =
  | { ok: true; entry: ManifestCapture; durability: string }
  | { ok: false; status: number; error: string; existing?: boolean };

/** The git-is-the-disk helper (uploads on the HOST repo shape):
 *  best-effort add + commit + push; failures WARN, never block — the
 *  file operation already succeeded, durability is reported honestly. */
export interface GitWorkdir {
  /** the repo toplevel that owns the captures dir (null = no repo). */
  toplevel: string | null;
  run(args: string[]): { ok: boolean; out: string };
  /** s6 upload-durability: the ASYNC twin of run() — the upload path pays
   *  the git/push latency WITHOUT freezing the single-threaded event loop
   *  (a 30s sync push used to stall the WHOLE standalone: every API call,
   *  the panel poll, everything). Same 30s cap + SIGKILL as run(). */
  runAsync(args: string[]): Promise<{ ok: boolean; out: string }>;
}

const execFileAsync = promisify(execFile);

export function discoverGitWorkdir(capturesDir: string): GitWorkdir {
  try {
    const top = execFileSync('git', ['-C', capturesDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }).trim();
    return {
      toplevel: top || null,
      run(args) {
        try {
          /* audit round-1 P2: a NETWORK git op with no timeout freezes the
           * whole standalone (single-threaded event loop) for the push
           * duration — 30s hard cap, then the failure is a WARNING (the
           * file op already succeeded; durability reports honestly). */
          const out = execFileSync('git', ['-C', top, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL' });
          return { ok: true, out };
        } catch (e) {
          return { ok: false, out: (e as { stderr?: string })?.stderr ?? String(e) };
        }
      },
      async runAsync(args) {
        try {
          const { stdout } = await execFileAsync('git', ['-C', top, ...args], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' });
          return { ok: true, out: stdout };
        } catch (e) {
          return { ok: false, out: (e as { stderr?: string })?.stderr ?? String(e) };
        }
      },
    };
  } catch {
    return { toplevel: null, run: () => ({ ok: false, out: 'no git repo' }), runAsync: async () => ({ ok: false, out: 'no git repo' }) };
  }
}

export function createCapturesManager(cfg: CapturesDirConfig, deps: { captureId: (rel: string) => string; log?: (...a: unknown[]) => void }): CapturesManager {
  const log = deps.log ?? (() => undefined);
  /* audit round-1 P2: the cache used to be WRITE-ONLY (every request
   * rescanned + head-read all captures). It is now READ with a
   * content-aware fingerprint: dir mtime AND every file's (mtime,size) —
   * a re-save under the SAME name does not bump the dir mtime but DOES
   * bump the file's mtime, so provenance refreshes while plain serves
   * (the hot path: /captures/* gate + every board pass's resolveCaptureName)
   * cost one readdir + N stats instead of N 64KB head reads. */
  let cache: { dirMtimeMs: number; fingerprint: string; json: ManifestJson } | null = null;

  const dirMtime = (): number => {
    try {
      return fs.statSync(cfg.dir).mtimeMs;
    } catch {
      return 0;
    }
  };

  /** Cheap change-signal: per-relpath mtimeMs:size, joined (sorted rels). */
  const dirFingerprint = (): string => {
    const bits: string[] = [];
    for (const relpath of listCaptures(cfg.dir, cfg.recursive)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(cfg.dir, relpath));
      } catch {
        continue;
      }
      bits.push(`${relpath}:${st.mtimeMs}:${st.size}`);
    }
    return bits.join('|');
  };

  const buildManifest = (): { ok: true; json: ManifestJson } | { ok: false; error: string } => {
    const m = dirMtime();
    const fp = dirFingerprint();
    if (cache && cache.dirMtimeMs === m && cache.fingerprint === fp) {
      return { ok: true, json: cache.json };
    }
    const json: ManifestJson = { generatedAt: new Date().toISOString(), captures: [] };
    const seen = new Map<string, string>();
    for (const relpath of listCaptures(cfg.dir, cfg.recursive)) {
      const abs = path.join(cfg.dir, relpath);
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue; // vanished mid-scan
      }
      const id = deps.captureId(relpath);
      const clash = seen.get(id);
      if (clash) {
        return { ok: false, error: `manifest: capture id collision — '${clash}' and '${relpath}' both map to id '${id}'. Rename one of them (rename = new identity; threads stay keyed to the old id).` };
      }
      seen.set(id, relpath);
      json.captures.push({ id, relpath, size, ...scanHead(abs) });
    }
    cache = { dirMtimeMs: m, fingerprint: fp, json };
    return { ok: true, json };
  };

  const invalidate = (): void => {
    cache = null;
  };

  const isServableRel = (rel: string): boolean => {
    // fast path: the mtime-keyed cache; misses rebuild once
    const built = buildManifest();
    if (!built.ok) return false;
    return built.json.captures.some((c) => c.relpath === rel);
  };

  /* upload sanitization (§D12): basename-only, .html/.htm, ≤200 chars, no
   * leading dot (the scan skips dot-entries — an invisible upload would be
   * a lie), no control characters, content ≤ 100MB. */
  const upload = async (name: string, content: string, overwrite: boolean, git?: GitWorkdir): Promise<UploadResult> => {
    if (typeof name !== 'string' || !name.trim()) return { ok: false, status: 400, error: 'missing capture name' };
    const clean = name.trim();
    if (clean.length > 200) return { ok: false, status: 400, error: 'capture name too long (max 200 chars)' };
    if (/[\\/]|\.\./.test(clean)) return { ok: false, status: 400, error: 'capture name must be a bare file name (no path separators)' };
    if (clean.startsWith('.')) return { ok: false, status: 400, error: 'capture name may not start with a dot (dot-files are invisible to the scan)' };
    if (HTML_RE.test(clean) === false) return { ok: false, status: 400, error: 'capture name must end with .html or .htm' };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) return { ok: false, status: 400, error: 'capture name contains control characters' };
    if (typeof content !== 'string' || content.length === 0) return { ok: false, status: 400, error: 'missing capture content' };
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > 100 * 1024 * 1024) return { ok: false, status: 413, error: `capture too large (${bytes} bytes; max 100MB)` };
    const abs = path.join(cfg.dir, clean);
    if (path.dirname(abs) !== cfg.dir) return { ok: false, status: 400, error: 'bad capture name' };
    if (!overwrite && fs.existsSync(abs)) return { ok: false, status: 409, error: `a capture named '${clean}' already exists (send overwrite:true to replace it)`, existing: true };
    /* audit round-1 P2: captureIdOf strips only the LAST extension, so
     * foo.html + foo.htm (and Unicode NFC/NFD twins) map to ONE id — writing
     * the pair would 500 the manifest and close the /captures serve gate
     * until an on-disk fix. Refuse at the door instead. */
    const wantId = deps.captureId(clean);
    const built0 = buildManifest();
    if (built0.ok) {
      const clashRel = built0.json.captures.find((c) => c.id === wantId && c.relpath !== clean)?.relpath;
      if (clashRel) return { ok: false, status: 409, error: `capture id collision — '${clean}' and '${clashRel}' both map to id '${wantId}'. Rename one (rename = new identity).`, existing: false };
    }
    fs.writeFileSync(abs, content, 'utf8');
    invalidate();
    const entry: ManifestCapture = { id: deps.captureId(clean), relpath: clean, size: bytes, ...scanHead(abs) };
    /* durability: commit new captures (git-is-the-disk). Untracked-file
     * loss on a wiped sandbox is the alternative; failures stay warnings. */
    let durability = 'file written (no git repo — not backed up)';
    const g = git ?? discoverGitWorkdir(cfg.dir);
    if (g.toplevel) {
      const rel = path.relative(g.toplevel, abs);
      /* s6: the add/commit/push chain rides runAsync — the event loop keeps
       * serving (panel polls, threads, manifest) while the durability ops
       * pay their latency; THIS request still waits for the honest,
       * verbatim durability string (the UI keeps its busy state meanwhile). */
      const add = await g.runAsync(['add', '--', rel]);
      const commit = add.ok ? await g.runAsync(['commit', '-m', `capture upload: ${clean} (dom-annotakit)`, '--no-verify', '--', rel]) : add;
      const push = commit.ok ? await g.runAsync(['push', 'origin', 'HEAD:main']) : commit;
      durability = push.ok ? 'written + committed + pushed' : `written; git durability: ${push.out.slice(0, 160)}`;
      if (!push.ok) log('captures: git durability failed:', push.out.slice(0, 300));
    }
    return { ok: true, entry, durability };
  };

  return {
    dir: cfg.dir,
    recursive: cfg.recursive,
    source: cfg.source,
    buildManifest,
    isServableRel,
    upload,
    invalidate,
  };
}

/* ----------------------------- spec context store ---------------------------- */

/** The session compose context: server-authoritative (§9 fold 5). In-memory
 *  (per server process); the host re-PUTs its localStorage mirror once on
 *  boot; every GET echoes it so the chips follow the server, not stale tabs. */
export interface SpecContextStore {
  get(): SpecContext;
  set(ctx: SpecContext): void;
}

export function createSpecContextStore(): SpecContextStore {
  let current: SpecContext = {};
  const INVALID = Symbol('invalid');
  /** null = clear; string (trim/collapse, ≤60) = set; INVALID = reject. */
  const clean = (v: unknown): string | null | typeof INVALID => {
    if (v == null) return null;
    if (typeof v !== 'string') return INVALID; // invalid type → reject the PUT
    const t = v.trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, 60) : null;
  };
  return {
    get: () => ({ ...current }),
    /* FULL-SNAPSHOT semantics: the PUT carries BOTH keys (the combobox
     * sends the whole selection); an ABSENT key clears it (null-equivalent).
     * A present-but-non-string value rejects the whole PUT. */
    set(ctx) {
      const epic = clean(ctx.epic);
      const story = clean(ctx.story);
      if (epic === INVALID || story === INVALID) throw new Error('context values must be strings or null');
      current = {
        ...(epic ? { epic } : {}),
        ...(story ? { story } : {}),
      };
    },
  };
}

/* ----------------------- the annotation rewrite seam ------------------------ */

/** The engine's own body cap (routes.ts readBody) — enforced at PRE-LOAD so
 *  hostile bodies never buffer unbounded (§9 P2-4). */
const PRELOAD_CAP = 2 * 1000 * 1000;

export const THREAD_CREATE_DOOR = '/annotakit/api/threads';
const COMMENT_DOOR_RE = /^\/annotakit\/api\/threads\/[^/]+\/comments$/;

/** Does this POST need the rewrite treatment? (thread create + comment add) */
export function isRewriteDoor(urlStr: string): boolean {
  return urlStr === THREAD_CREATE_DOOR || COMMENT_DOOR_RE.test(urlStr);
}

/** Read the request body ONCE (cap enforced; 413 responds itself). */
export function preloadBody(req: http.IncomingMessage, res: http.ServerResponse, onOversize: (bytes: number) => void): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversize = false;
    req.on('data', (c: Buffer) => {
      if (oversize) return;
      size += c.length;
      if (size > PRELOAD_CAP) {
        oversize = true;
        chunks.length = 0;
        onOversize(size);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversize) return resolve(null);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(null));
    req.on('close', () => resolve(null)); // client abort mid-body: settle, never hang
    void res; // the caller writes the 413 (kept out of the pure path)
  });
}

/** Apply the session context to a buffered door body. Returns the NEW bytes —
 *  or the ORIGINAL bytes untouched (no context / malformed JSON / empty
 *  comment / per-key escalation already satisfied). Never throws. */
export function rewriteDoorBody(urlStr: string, body: Buffer, context: SpecContext): Buffer {
  if (!context.epic && !context.story) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return body; // the engine's own 400 answers honestly
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const obj = parsed as Record<string, unknown>;
  if (urlStr === THREAD_CREATE_DOOR) {
    /* createThread: ThreadInput.comments[0].body (validateThreadInput's
     * shape) — transform only when the array carries a plain first comment. */
    const comments = obj.comments;
    if (!Array.isArray(comments) || comments.length === 0) return body;
    const first = comments[0];
    if (first === null || typeof first !== 'object' || typeof (first as { body?: unknown }).body !== 'string') return body;
    const next = applySpecContext((first as { body: string }).body, context);
    if (next === (first as { body: string }).body) return body;
    const patched = { ...obj, comments: [{ ...(first as object), body: next }, ...comments.slice(1)] };
    return Buffer.from(JSON.stringify(patched), 'utf8');
  }
  /* comment add: {body, author, createdAt} */
  if (typeof obj.body !== 'string') return body;
  const next = applySpecContext(obj.body, context);
  if (next === obj.body) return body;
  return Buffer.from(JSON.stringify({ ...obj, body: next }), 'utf8');
}

/** Duck-typed req wrapper (§9 P2-4): pre-loaded stream + the ORIGINAL
 *  url/method/socket/headers (content-length corrected). The engine's
 *  complete req inventory (audited): url, method, headers,
 *  socket.remoteAddress, on('data'|'end'|'error'). */
export function wrapRequestWithBody(req: http.IncomingMessage, body: Buffer): http.IncomingMessage {
  const stream = new PassThrough();
  stream.end(body);
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers[k] = v as string | string[];
  }
  headers['content-length'] = String(body.length);
  const wrapper = Object.create(stream) as http.IncomingMessage & { __domAkWrapped?: boolean };
  Object.defineProperties(wrapper, {
    method: { value: req.method },
    url: { value: req.url },
    headers: { value: headers },
    socket: { value: req.socket },
    httpVersion: { value: req.httpVersion },
    __domAkWrapped: { value: true },
  });
  return wrapper;
}

/* ------------------------------ the route mount ----------------------------- */

export interface HostRoutesDeps {
  captures: CapturesManager;
  specContext: SpecContextStore;
  mirror: ProjectMirror;
  /** live threads for the rollup — sync array OR a promise (the vendored
   *  store's listThreads is async; the standalone passes an async safe
   *  reader). */
  listThreads: () =>
    | { id: string; storyId: string; comments?: { body?: unknown }[] }[]
    | null
    | Promise<{ id: string; storyId: string; comments?: { body?: unknown }[] }[] | null>;
  log?: (...a: unknown[]) => void;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

async function readJson(req: http.IncomingMessage, cap = PRELOAD_CAP): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversize = false;
    req.on('data', (c: Buffer) => {
      if (oversize) return;
      size += c.length;
      if (size > cap) {
        oversize = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversize) return resolve({ ok: false, status: 413, error: 'body too large' });
      if (chunks.length === 0) return resolve({ ok: true, body: {} });
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return resolve({ ok: false, status: 400, error: 'body must be a JSON object' });
        }
        resolve({ ok: true, body: parsed as Record<string, unknown> });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid JSON body' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request stream error' }));
  });
}

/** GET /dom-annotakit-spec.json → catalog + context echo. ASYNC (the store
 *  read is a promise) + NEVER THROWS (a hostile/edge store state answers the
 *  board-only catalog — a spec poll must never take the server down). */
export async function specCatalogPayload(deps: HostRoutesDeps): Promise<{ catalog: SpecCatalog; context: SpecContext }> {
  let local: SpecCatalog = { epics: [], stories: [], captures: {} };
  try {
    const threads = (await deps.listThreads()) ?? [];
    local = buildSpecIndex(Array.isArray(threads) ? threads : []);
  } catch {
    /* store unavailable → board-only catalog (honest degrade) */
  }
  const board = deps.mirror.catalog();
  return { catalog: mergeCatalog(board, local), context: deps.specContext.get() };
}

/**
 * The host-route dispatcher. Returns true when the request was HANDLED
 * (response fully written); false lets the caller fall through (serveStatic).
 * Mounted BEFORE serveStatic's GET/HEAD-only gate (§9 P3-11).
 */
export function handleHostRoutes(req: http.IncomingMessage, res: http.ServerResponse, deps: HostRoutesDeps): boolean {
  const log = deps.log ?? (() => undefined);
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return false;
  }
  const method = req.method ?? 'GET';

  if (pathname === '/dom-annotakit-spec.json') {
    if (method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end();
      return true;
    }
    void specCatalogPayload(deps)
      .then((payload) => sendJson(res, 200, payload))
      .catch((e: unknown) => {
        log('spec catalog failed:', e instanceof Error ? e.message : String(e));
        sendJson(res, 500, { error: 'spec catalog unavailable' });
      });
    return true;
  }

  if (pathname === '/dom-annotakit-spec-context') {
    if (method !== 'PUT') {
      res.writeHead(405, { Allow: 'PUT' });
      res.end();
      return true;
    }
    void (async () => {
      const read = await readJson(req);
      if (!read.ok) {
        sendJson(res, read.status, { error: read.error });
        return;
      }
      try {
        deps.specContext.set(read.body as SpecContext);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      sendJson(res, 200, { ok: true, context: deps.specContext.get() });
    })();
    return true;
  }

  if (pathname === '/dom-annotakit-captures') {
    if (method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return true;
    }
    void (async () => {
      const read = await readJson(req, 110 * 1024 * 1024);
      if (!read.ok) {
        sendJson(res, read.status, { error: read.error });
        return;
      }
      const name = typeof read.body.name === 'string' ? read.body.name : '';
      const content = typeof read.body.content === 'string' ? read.body.content : '';
      const overwrite = read.body.overwrite === true;
      const r = await deps.captures.upload(name, content, overwrite);
      if (r.ok) {
        log(`captures: uploaded ${r.entry.relpath} (${r.durability})`);
        sendJson(res, 200, r);
      } else {
        sendJson(res, r.status, r);
      }
    })();
    return true;
  }

  if (pathname === '/dom-annotakit-project.json' && method === 'POST') {
    void (async () => {
      const read = await readJson(req);
      if (!read.ok) {
        sendJson(res, read.status, { error: read.error });
        return;
      }
      if (read.body.action !== 'pass') {
        sendJson(res, 400, { error: `unknown action ${JSON.stringify(read.body.action ?? null)} — {"action":"pass"} forces a mirror reconcile` });
        return;
      }
      try {
        await deps.mirror.reconcile();
      } catch (e) {
        log('project pass failed:', e);
      }
      sendJson(res, 200, deps.mirror.status());
    })();
    return true;
  }

  return false;
}
