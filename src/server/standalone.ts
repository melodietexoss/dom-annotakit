#!/usr/bin/env node
/**
 * dom-annotakit — standalone server entry (design D3a; COPY-MAP server row).
 *
 * Mounts the vendored review engine (createMiddleware from ./routes — zero
 * SB imports, access gate + loopback CORS inherited) on a plain node:http
 * server at the origin root, and serves the review surfaces:
 *
 *   /annotakit/*   the engine's REST API (`/annotakit/` prefix — nothing is
 *                  stripped; landing note + /annotakit/api/*)
 *   /layer.mjs     the iframe pin-layer bundle (dist/layer.mjs — the surface
 *                  port builds it; 404s gracefully until then)
 *   /captures/*    SingleFile capture files from DOM_AK_CAPTURES_DIR
 *                  (path-traversal guarded; captures are DATA, never the
 *                  store owner)
 *   /*             the review app build (dist-app/ — the host app's Vite
 *                  output; index.html SPA fallback; 404s gracefully until
 *                  the surface port lands)
 *
 * Engine wiring (the load-bearing part — see design D3a "Wiring traps"):
 *   - devServerHook(shimApp, { configDir, port }) is called on the FIRST
 *     /annotakit/ request. bootstrap() is not exported; the devServerHook
 *     shape is the one door that passes the REAL port, so the boot origin is
 *     port-correct from the very first issue link (the 6006-in-6007 bug).
 *     Lazy on purpose: the listener binds instantly; store + git durability +
 *     GH mirror boot on demand. Once booted, /health reports store:'sqlite'.
 *   - serverChannelHook(host emitter) at startup — emitToChannel is the ONLY
 *     live-update path in server mode; the channel needs on/emit per
 *     shared/events. v0.1 browser transport = the host panel polls
 *     GET /threads every ~5s and re-emits THREADS_CHANGED on its own channel
 *     (SSE/WS = PLAN). We log engine broadcasts for the operator.
 *   - configDir is INSIDE the tool repo: <repoRoot>/.dom-annotakit (per-kit
 *     annotakit.config.json / .env — dual-kit isolation with the SB addon;
 *     the db itself resolves via env.ts storeLocation into the git common
 *     dir's annotakit-dom/, checkout/clean-immune).
 *
 * Env:
 *   PORT                 listen port (default 4310)
 *   DOM_AK_CAPTURES_DIR  captures directory override (default: the server's
 *                        start directory — the "captures" config section wins
 *                        over this when set; see resolveCapturesDir)
 *
 * Graceful shutdown: SIGTERM/SIGINT close the listener and let the engine's
 * OWN signal handler do the rest — sync.ts registers it at bootstrap and it
 * runs the C14/C15 shutdown flush (ghsync drain → final git cycle → exit;
 * a hard-exit timer backstops it). We never hard-exit over a booted engine.
 * Before the first API request there is nothing to flush (no store, no git
 * sync, no GH mirror) — a short backstop exit covers that case. routes.ts
 * exports no separate close hook (the store is module-private; its
 * checkpoint rides the flush's final syncOnce).
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { devServerHook, serverChannelHook } from './routes';
import { THREADS_CHANGED } from '../shared/events';
import { captureIdOf, captureName } from '../host/capture-id';
import { parseDotEnv } from './env';
import { getStore, readConfig } from './store';
import { storeLocation } from './env';
import { BAKED_GH_TOKEN } from '../shared/bakedCreds';
import { startProjectMirror, type ProjectMirror } from './projectMirror';
import {
  createCapturesManager,
  createSpecContextStore,
  handleHostRoutes,
  isRewriteDoor,
  preloadBody,
  resolveCapturesDir,
  rewriteDoorBody,
  wrapRequestWithBody,
  type HostRoutesDeps,
} from './hostRoutes';

/* --------------------------------- config ---------------------------------- */

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 4310;
/** <repoRoot> — dist/ sits at its root in every shape this file runs in
 *  (bundled: __dirname = <repoRoot>/dist, the env.ts precedent). */
const repoRoot = path.resolve(__dirname, '..');
/** Per-kit config home, INSIDE the tool repo (created so the documented
 *  annotakit.config.json / .env location exists before the first boot). */
const configDir = path.join(repoRoot, '.dom-annotakit');
fs.mkdirSync(configDir, { recursive: true });
/** Captures are DATA (D12, §D12+§9 fold 8): DOM_AK_CAPTURES_DIR env >
 *  annotakit.config.json "captures".{dir,recursive} > process.cwd(). The
 *  vendored deployment pins the host PROJECT ROOT via config; the default
 *  is "the directory you started the server in" — logged loudly at boot. */
const capturesCfg = resolveCapturesDir(readConfig(configDir), { repoRoot, cwd: process.cwd() });
const captures = createCapturesManager(capturesCfg, {
  captureId: captureIdOf,
  log: (...a: unknown[]) => console.log('[dom-annotakit]', ...a),
});
const capturesDir = captures.dir;
/** The host app's Vite build (surface port; absent = 404 until it lands). */
const appDir = path.join(repoRoot, 'dist-app');
/** The iframe pin-layer bundle (tsup browser output; absent = 404 for now). */
const layerFile = path.join(repoRoot, 'dist', 'layer.mjs');
/** D10: the session compose-context store (server-authoritative) — the
 *  spec endpoints + the annotation rewrite seam share this one instance. */
const specContext = createSpecContextStore();

/* --------------------------- engine wiring (lazy) --------------------------- */

type ApiHandler = (req: http.IncomingMessage, res: http.ServerResponse, next?: (err?: unknown) => void) => void;
let booted = false;
let apiHandler: ApiHandler | null = null;
/** devServerHook does bootstrap(configDir, port) + app.use(createMiddleware)
 *  — a two-method shim is all the ServerAppLike it needs. */
const shimApp = {
  use(fn: unknown): void {
    apiHandler = fn as ApiHandler;
  },
};

function bootEngine(): void {
  if (booted) return;
  booted = true;
  devServerHook(shimApp as unknown as Parameters<typeof devServerHook>[0], { configDir, port: PORT });
}

/* ---------- credential pre-apply (D6 fold P1-4 + review P2-2) — BEFORE any engine boot ----------
 * Real precedence: shell env > .env > BAKED — but the VENDORED path must own
 * the .env case: pre-setting the env var would make loadDotEnv skip the key
 * (env.ts:87), so it never registers in bootAppliedKeys and reloadDotEnv can
 * never rotate it (review P2-2 — a .env-sourced token would lose the
 * documented .env + POST /gh/reload rotation). Therefore: scan EVERY .env
 * candidate (loadDotEnv's order, env.ts:70-73); when ANY carries
 * ANNOTAKIT_GH_TOKEN we pre-apply NOTHING — bootstrap's loadDotEnv reads it,
 * registers it, and rotation works exactly as vendored. Only when no .env
 * has the token (the swept-sandbox case the bake exists for) do we apply the
 * baked constant — guarded, so shell env still wins. Recovery note for the
 * baked case stands: rotate via shell env or config "project.token" + restart. */
{
  let envFileHasToken = false;
  for (const p of [path.join(repoRoot, '.env'), path.join(configDir, '.env'), path.resolve(process.cwd(), '.env')]) {
    try {
      if (!fs.existsSync(p)) continue;
      if (parseDotEnv(fs.readFileSync(p, 'utf8')).ANNOTAKIT_GH_TOKEN) {
        envFileHasToken = true;
        console.log(`[dom-annotakit] .env at ${p} carries ANNOTAKIT_GH_TOKEN — the vendored .env loader owns it (rotation via .env + POST /gh/reload works)`);
        break;
      }
    } catch {
      /* unreadable — next candidate */
    }
  }
  if (!envFileHasToken && !process.env.ANNOTAKIT_GH_TOKEN && BAKED_GH_TOKEN) {
    process.env.ANNOTAKIT_GH_TOKEN = BAKED_GH_TOKEN;
    console.log('[dom-annotakit] applied the baked GH token (shell/.env absent) — rotate via ANNOTAKIT_GH_TOKEN (or config "project.token") + restart; .env + /gh/reload cannot override a baked-backed token');
  }
}

/* ------------------------- live-update channel stub ------------------------- */

const channel = new EventEmitter();
serverChannelHook(channel); // emitToChannel is no longer null from here on
channel.on(THREADS_CHANGED, (payload: unknown) => {
  console.log(`[dom-annotakit] threads changed: ${JSON.stringify(payload)}`);
});

/* ------------------- GH Projects spec mirror sidecar (D6) ------------------ */
/** resolveCaptureName: manifest-derived display name by storyId (fold P2-7 —
 *  NEVER thread.story.name, which carries old page <title>s on seeded
 *  threads). buildManifest's mtime cache keeps this cheap. */
function resolveCaptureName(storyId: string): string | undefined {
  const built = captures.buildManifest();
  if (!built.ok) return undefined;
  const entry = built.json.captures.find((c) => c.id === storyId);
  return entry ? captureName(entry.relpath) : undefined;
}
const mirror: ProjectMirror = startProjectMirror({
  configDir,
  port: PORT,
  channel,
  resolveCaptureName,
  publicHost: () => lastSeenPublicHost,
});

/* ----------------- capture manifest (delegated: hostRoutes manager) ---------------- */
/* D12 (2026-10-26): the scan/manifest/cache/upload/gate logic moved to (D15: delete is gone)
 * src/server/hostRoutes.ts (one source of truth — the /captures SERVE GATE is
 * the manifest itself, §9 P1-B). This section keeps ONLY the two consumers:
 * the manifest ROUTE and the storyId→name resolver the mirror needs. */

function serveManifest(res: http.ServerResponse): void {
  const built = captures.buildManifest();
  if (!built.ok) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(built.error);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(built.json));
}

/* ------------------------------ static serving ----------------------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/** Resolve `rel` (a URL path, already decoded) strictly INSIDE `root`.
 *  Returns null on traversal, absolute paths, or null bytes. */
function safeJoin(root: string, rel: string): string | null {
  if (rel.includes('\0') || path.isAbsolute(rel)) return null;
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** Serve one file (200) or return false (caller falls through). */
function serveFile(req: http.IncomingMessage, res: http.ServerResponse, abs: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(st.size), 'Cache-Control': 'no-store' });
  if ((req.method ?? 'GET') === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(abs).pipe(res);
  return true;
}

function notFound(res: http.ServerResponse, note: string): void {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(note);
}

/* CSP-meta strip (design REV 3 risk table, promoted from planned to BUILT by
 * the first live smoke — found on a REAL capture): SingleFile writes a
 * "freeze" CSP meta into saved pages,
 *   <meta http-equiv=content-security-policy content="default-src 'none';
 *    ... script-src 'unsafe-inline' data:; ...">
 * (unquoted, LOWERCASE http-equiv — a case-sensitive corpus grep misses it).
 * That CSP blocks the injected layer module script (script-src has no http:
 * source) and the layer's runtime <style>. The strip is IN-MEMORY ONLY —
 * the capture file on disk is NEVER modified — same transformation class as
 * the SingleFile note-card strip (design D2c). Only the <head> region is
 * rewritten (metas live there; captures can be 69MB — never full-file).
 * The 2026-10-23 preview E2E on the real GenEditor corpus found two boundary
 * shapes the original single 512KB slice missed (19/31 captures would have
 * shipped layer-dead): heads >512KB (inlined base64; largest boundary
 * ~1.62MB) and captures with NO literal </head> (only <body — 5/31) — the
 * scan now grows adaptively and accepts either as the head-end.
 * Honest degrade: if no boundary is found within the scan cap, serve RAW and
 * log loudly (the layer will fail to load; the host shows its notice). */
const CSP_META_RE = /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>\s*/gi;
/** Adaptive head-scan sizes: most heads are tiny, but real SingleFile
 * captures inline base64 data: URIs into <head> — the 2026-10-23 live E2E
 * on the GenEditor corpus found 16/31 captures with the head-end boundary
 * past the old 512KB single slice (largest ~1.62MB). Grow 512KB → 2MB → 4MB,
 * then give up (honest degrade below). Only the head region is ever
 * rewritten. */
const HEAD_SCAN_STEPS: readonly number[] = [512 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024];
/** Head-end boundary: `</head>` — or `<body` when the serializer wrote no
 * literal close tag at all (5/31 corpus captures; HTML parsers auto-close
 * the head at <body, so the bytes are still a well-formed capture). */
const HEAD_END_RE = /<\/head\s*>|<body[\s>]/i;
const HEAD_SCAN_MAX_BYTES = HEAD_SCAN_STEPS[HEAD_SCAN_STEPS.length - 1];

function serveCapture(req: http.IncomingMessage, res: http.ServerResponse, abs: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (path.extname(abs).toLowerCase() !== '.html' && path.extname(abs).toLowerCase() !== '.htm') {
    return serveFile(req, res, abs);
  }
  let headStr = '';
  let headCloseIdx = -1;
  let read = 0;
  for (const step of HEAD_SCAN_STEPS) {
    const want = Math.min(step, st.size);
    if (want <= read) break; // no new territory at this step
    const slice = Buffer.alloc(want);
    let n = 0;
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        n = fs.readSync(fd, slice, 0, want, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
    read = n;
    headStr = slice.subarray(0, n).toString('utf8');
    headCloseIdx = headStr.search(HEAD_END_RE);
    if (headCloseIdx >= 0 || n >= st.size) break; // boundary found or EOF exhausted
  }
  if (headCloseIdx < 0) {
    console.warn(
      `[dom-annotakit] capture ${abs}: no </head>/<body> within ${HEAD_SCAN_MAX_BYTES} bytes — serving RAW; a strict CSP meta (if any) will block the layer on this capture`,
    );
    return serveFile(req, res, abs);
  }
  // Honest degrade must stay LOUD (review P2-4): a <body-shaped match inside
  // a head attribute value (serializers do not escape < in attr values) is a
  // FALSE boundary — bytes stay exact, but a CSP meta beyond it survives
  // silently and blocks the layer. Warn when that combination appears.
  if (
    headStr.slice(headCloseIdx, headCloseIdx + 5).toLowerCase() === '<body' &&
    /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i.test(headStr.slice(headCloseIdx))
  ) {
    console.warn(
      `[dom-annotakit] capture ${abs}: <body boundary matched but CSP meta(s) survive beyond it (possible false boundary in a head attribute) — the layer may be blocked on this capture`,
    );
  }
  // Response = [head part, CSP metas stripped] + [original file bytes from
  // the head-end boundary offset to EOF]. The strip regex matches ASCII-only
  // meta markup, so multibyte content in the head passes byte-identical.
  const headPart = headStr.slice(0, headCloseIdx);
  let stripped = 0;
  const strippedHead = headPart.replace(CSP_META_RE, () => {
    stripped++;
    return '';
  });
  const outHeadBuf = Buffer.from(strippedHead, 'utf8');
  const restStart = Buffer.byteLength(headPart, 'utf8'); // file offset where the head-end boundary begins
  const totalLen = outHeadBuf.length + (st.size - restStart);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(totalLen),
    'Cache-Control': 'no-store',
    'X-Dom-Anotakit-Csp-Stripped': String(stripped),
  });
  if ((req.method ?? 'GET') === 'HEAD') {
    res.end();
    return true;
  }
  res.write(outHeadBuf);
  if (st.size > restStart) {
    fs.createReadStream(abs, { start: restStart }).pipe(res);
  } else {
    res.end();
  }
  return true;
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method ?? 'GET';
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    notFound(res, 'bad url');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }
  if (pathname === '/annotakit') {
    // the engine's gate only admits '/annotakit/' — hand humans the landing
    res.writeHead(308, { Location: '/annotakit/' });
    res.end();
    return;
  }
  if (pathname === '/dom-annotakit-manifest.json') {
    serveManifest(res);
    return;
  }
  if (pathname === '/dom-annotakit-project.json') {
    const st = mirror.status();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(st));
    return;
  }
  if (pathname === '/layer.mjs') {
    if (serveFile(req, res, layerFile)) return;
    notFound(res, 'dist/layer.mjs is not built yet (the surface port adds the iframe pin-layer bundle)');
    return;
  }
  if (pathname.startsWith('/captures/')) {
    /* §9 P1-B — the SERVE GATE: with capturesDir possibly at a PROJECT ROOT,
     * /captures/* must never become a read-only server over the repo (the
     * public preview proxies this prefix). A relpath is servable IFF the
     * current manifest build lists it — the same scan rules as the listing
     * (dot-skip, non-recursive/denylist, .html/.htm only), one source of
     * truth in hostRoutes. Unknown → 404, so .env / .git/* / package.json
     * are unreachable even though they sit under the captures dir. */
    const rel = pathname.slice('/captures/'.length);
    if (!captures.isServableRel(rel)) {
      notFound(res, `no such capture under ${capturesDir}`);
      return;
    }
    const abs = safeJoin(capturesDir, rel);
    if (abs && serveCapture(req, res, abs)) return;
    notFound(res, `no such capture under ${capturesDir}`);
    return;
  }
  // the review app build, with the SPA index.html fallback
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const abs = safeJoin(appDir, rel);
  if (abs && serveFile(req, res, abs)) return;
  if (serveFile(req, res, path.join(appDir, 'index.html'))) return;
  notFound(res, 'review app not built yet (dist-app/ is the surface port\'s Vite build)');
}

/* --------------------------------- server --------------------------------- */

/* The last PUBLIC host seen on a request — the Host header as it survives
 * the proxy chain (gateway → Next rewrites → here), so board deep-links can
 * point at the deployment the user actually opens. Loopback/internal hosts
 * are ignored (never tracked — same discipline as the vendored origin
 * tracking, routes.ts:1440+). IPv6 Host forms ('[::1]:3000') keep their
 * brackets intact (review P3-7 — a naive split(':') would track '[' as the
 * host and new URL would throw, silently dropping board deep links). */
let lastSeenPublicHost: string | null = null;

function hostFromHeader(raw: string | undefined): string | null {
  if (!raw) return null;
  const v6 = raw.match(/^(\[[^\]]+\])(?::\d+)?$/); // [::1]:3000 / [::1]
  if (v6) return v6[1]!;
  const host = raw.split(':')[0]!;
  return host || null;
}

/** D10: safe store reads for the spec catalog — the SAME singleton shape
 * projectMirror/routes use (getStore(configDir,{dataDir}) is idempotent —
 * whichever side opens first, all share one instance). Failure → null: the
 * catalog endpoint answers with the board cache only (honest, never 500s). */
async function listThreadsSafe(): Promise<{ id: string; storyId: string; comments?: { body?: unknown }[] }[] | null> {
  try {
    const gitFlowOn = readConfig(configDir).autoSync !== false;
    const loc = storeLocation(configDir, { forceClassic: !gitFlowOn });
    const store = getStore(configDir, { dataDir: loc.dir });
    const threads = await store.listThreads();
    return Array.isArray(threads) ? (threads as unknown as { id: string; storyId: string; comments?: { body?: unknown }[] }[]) : null;
  } catch {
    return null;
  }
}

const hostRoutesDeps: HostRoutesDeps = {
  captures,
  specContext,
  mirror,
  listThreads: listThreadsSafe,
  log: (...a: unknown[]) => console.log('[dom-annotakit]', ...a),
};

const server = http.createServer((req, res) => {
  {
    const host = hostFromHeader(typeof req.headers.host === 'string' ? req.headers.host : undefined);
    if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::1]' && !host.endsWith('.internal')) {
      lastSeenPublicHost = host;
    }
  }
  const urlStr = req.url ?? '/';
  if (urlStr.startsWith('/annotakit/')) {
    /* D6 fold P1-2 — the issue-spam doors: with a token present (baked or
     * operator-provided) ghsync.syncAll() arms on POST /annotakit/api/sync
     * and /annotakit/api/gh EVEN when ghAuto:false (syncAll gates on
     * configured(), not enabled() — ghsync.ts:1078-1088). When this instance
     * runs the Projects mirror instead of Issues, intercept the doors at OUR
     * seam (this file fronts the engine handler) and point at the board.
     * ghAuto:true instances delegate untouched (engine parity). */
    if ((urlStr === '/annotakit/api/sync' || urlStr === '/annotakit/api/gh') && (req.method ?? 'GET') === 'POST' && mirror.issuesMirrorDisarmed()) {
      const st = mirror.status();
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        error: 'The GitHub ISSUES mirror is disarmed for this instance (ghAuto:false in annotakit.config.json) — annotations sync to the GH Projects spec board instead.',
        project: st.projectUrl ?? st.target,
        hint: 'GET /annotakit/api/sync explains the engine doors; the board mirror reconciles automatically on every thread change.',
      }));
      return;
    }
    bootEngine(); // first API request: bootstrap(configDir, PORT) + mount
    const handler = apiHandler;
    if (!handler) {
      notFound(res, 'engine failed to boot');
      return;
    }
    /* D10 — the compose-context REWRITE SEAM: the vendored composer POSTs
     * plain JSON; when a session epic/story is set, thread-create and
     * comment-add bodies gain the missing directive LINES before the engine
     * reads them. The original stream is consumed exactly once and the
     * wrapper re-emits buffered bytes (socket/headers preserved, the
     * engine's 2MB cap enforced at pre-load — §9 P2-4). No context set →
     * zero-touch passthrough. */
    const ctx = specContext.get();
    if ((req.method ?? 'GET') === 'POST' && (ctx.epic || ctx.story) && isRewriteDoor(urlStr)) {
      void (async () => {
        const buffered = await preloadBody(req, res, (bytes) => {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: `request body too large (${bytes} bytes; the engine caps door bodies at 2MB)` }));
        });
        if (buffered == null) return; // 413 answered, or the stream errod
        const rewritten = rewriteDoorBody(urlStr, buffered, ctx);
        handler(wrapRequestWithBody(req, rewritten), res, () => notFound(res, 'unknown route — GET /annotakit/api/schema documents every endpoint'));
      })();
      return;
    }
    handler(req, res, () => notFound(res, 'unknown route — GET /annotakit/api/schema documents every endpoint'));
    return;
  }
  /* D10-D14 — the host REST seam (spec catalog/context, capture upload,
   * forced mirror pass). Mounted BEFORE serveStatic's GET/HEAD-only
   * gate (§9 P3-11: serveStatic 405s every non-GET). */
  if (handleHostRoutes(req, res, hostRoutesDeps)) return;
  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dom-annotakit] server listening on http://127.0.0.1:${PORT}`);
  console.log(`[dom-annotakit] configDir: ${configDir} (annotakit.config.json / .env)`);
  console.log(`[dom-annotakit] captures: ${capturesDir} (${captures.source}${captures.recursive ? ', recursive' : ', top-level only'}) → /captures/* + /dom-annotakit-manifest.json`);
  console.log(`[dom-annotakit] app build: ${appDir}${fs.existsSync(appDir) ? '' : ' (not built yet — / 404s until the surface port)'}`);
  console.log(`[dom-annotakit] layer bundle: ${layerFile}${fs.existsSync(layerFile) ? '' : ' (not built yet — /layer.mjs 404s)'}`);
  console.log('[dom-annotakit] engine boots on the first /annotakit/ request (store + git durability + GH mirror)');
});

/* ----------------------------- graceful shutdown ---------------------------- */

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    if (!booted) process.exit(0); // never booted → nothing to flush
  });
  if (!booted) {
    // no engine signal handler exists yet — exit ourselves (short backstop;
    // close() can hang on lingering keep-alive sockets)
    setTimeout(() => process.exit(0), 1500).unref();
  }
  // booted: sync.ts's own SIGTERM/SIGINT handler (registered at bootstrap)
  // runs the shutdown flush — ghsync drain + final git cycle — and exits
  // the process with a hard-exit backstop. We never exit over it.
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
