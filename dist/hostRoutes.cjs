'use strict';

var fs = require('fs');
var path = require('path');
var child_process = require('child_process');
var util = require('util');
var stream = require('stream');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var fs__default = /*#__PURE__*/_interopDefault(fs);
var path__default = /*#__PURE__*/_interopDefault(path);

// src/server/hostRoutes.ts

// src/shared/specDirectives.ts
var DIRECTIVE_LINE_RE = /^[ \t]*@?(epic|story)[ \t]*:[ \t]*(\S.*)$/i;
var MAX_VALUE_LEN = 60;
function cleanValue(raw) {
  const v = raw.trim().replace(/\s+/g, " ");
  if (!v) return null;
  return v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) : v;
}
function parseSpecDirectives(body) {
  const lines = body.split(/\r?\n/);
  const kept = [];
  const directives = {};
  for (const line of lines) {
    const m = DIRECTIVE_LINE_RE.exec(line);
    if (m) {
      const v = cleanValue(m[2] ?? "");
      if (v) directives[m[1].toLowerCase()] = v;
    } else {
      kept.push(line);
    }
  }
  return { directives, cleaned: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}
function threadSpecDirectives(bodies) {
  const out = {};
  for (const b of bodies) {
    const { directives } = parseSpecDirectives(b);
    if (directives.epic) out.epic = directives.epic;
    if (directives.story) out.story = directives.story;
  }
  return out;
}

// src/shared/specCatalog.ts
var collator = new Intl.Collator(void 0, { sensitivity: "base" });
function specNameCompare(a, b) {
  return collator.compare(a, b);
}
function buildSpecIndex(threads) {
  const epicSet = /* @__PURE__ */ new Set();
  const storyMap = /* @__PURE__ */ new Map();
  const captures = {};
  for (const t of threads) {
    const bodies = (t.comments ?? []).map((c) => String(c.body ?? ""));
    const d = threadSpecDirectives(bodies);
    const roll = captures[t.storyId] ??= { epics: {}, stories: {}, pairs: {} };
    if (d.epic) {
      epicSet.add(d.epic);
      roll.epics[d.epic] = (roll.epics[d.epic] ?? 0) + 1;
    }
    if (d.story) {
      storyMap.set(d.story, storyMap.get(d.story) ?? /* @__PURE__ */ new Set());
      roll.stories[d.story] = (roll.stories[d.story] ?? 0) + 1;
      if (d.epic) {
        storyMap.get(d.story).add(d.epic);
        const pk = `${d.epic}\0${d.story}`;
        roll.pairs[pk] = (roll.pairs[pk] ?? 0) + 1;
      }
    }
  }
  const stories = [...storyMap.entries()].map(([name, epics]) => ({ name, epics: [...epics].sort(specNameCompare) })).sort((a, b) => specNameCompare(a.name, b.name));
  return { epics: [...epicSet].sort(specNameCompare), stories, captures };
}
function mergeCatalog(board, local) {
  const a = board ?? { epics: [], stories: []};
  const epicSet = /* @__PURE__ */ new Set([...a.epics, ...local.epics]);
  const storyMap = /* @__PURE__ */ new Map();
  for (const s of a.stories) storyMap.set(s.name, new Set(s.epics));
  for (const s of local.stories) {
    if (storyMap.has(s.name)) storyMap.get(s.name).clear();
    for (const e of s.epics) (storyMap.get(s.name) ?? /* @__PURE__ */ new Set()).add(e);
    if (!storyMap.has(s.name)) storyMap.set(s.name, new Set(s.epics));
  }
  return {
    epics: [...epicSet].sort(specNameCompare),
    stories: [...storyMap.entries()].map(([name, epics]) => ({ name, epics: [...epics].sort(specNameCompare) })).sort((x, y) => specNameCompare(x.name, y.name)),
    captures: local.captures
    // board items carry no capture rollup — the store owns it
  };
}
function applySpecContext(body, context) {
  if (!context) return body;
  const wantEpic = typeof context.epic === "string" && context.epic.trim() ? context.epic.trim() : null;
  const wantStory = typeof context.story === "string" && context.story.trim() ? context.story.trim() : null;
  if (!wantEpic && !wantStory) return body;
  if (!body.trim()) return body;
  const { directives } = parseSpecDirectives(body);
  const lines = [];
  if (wantEpic && !directives.epic) lines.push(`@epic: ${wantEpic}`);
  if (wantStory && !directives.story) lines.push(`@story: ${wantStory}`);
  if (lines.length === 0) return body;
  return `${body.replace(/\s+$/, "")}
${lines.join("\n")}`;
}

// src/server/hostRoutes.ts
function resolveCapturesDir(rawConfig, opts) {
  const env = opts.env ?? process.env;
  const section = rawConfig?.captures ?? null;
  const recursive = section?.recursive === true;
  if (typeof env?.DOM_AK_CAPTURES_DIR === "string" && env.DOM_AK_CAPTURES_DIR.trim()) {
    return { dir: path__default.default.resolve(env.DOM_AK_CAPTURES_DIR.trim()), recursive, source: "env" };
  }
  if (typeof section?.dir === "string" && section.dir.trim()) {
    const dir = path__default.default.resolve(opts.repoRoot, section.dir.trim());
    return { dir, recursive, source: "config" };
  }
  return { dir: path__default.default.resolve(opts.cwd), recursive, source: "default-cwd" };
}
var RECURSIVE_DENY = /* @__PURE__ */ new Set([
  "node_modules",
  ".next",
  "dist",
  "dist-app",
  "build",
  "out",
  "coverage",
  "skills",
  "public",
  "examples",
  "tests",
  "db",
  "download",
  "upload",
  "src",
  "prisma",
  "mini-services",
  "annotakit"
]);
var HTML_RE = /\.html?$/i;
function listCaptures(dir, recursive, rel = "") {
  let entries;
  try {
    entries = fs__default.default.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (recursive && !RECURSIVE_DENY.has(e.name)) out.push(...listCaptures(path__default.default.join(dir, e.name), recursive, relPath));
    } else if (e.isFile() && HTML_RE.test(e.name)) {
      out.push(relPath);
    }
  }
  return out.sort();
}
var HEAD_SCAN_BYTES = 64 * 1024;
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function scanHead(abs) {
  let head = "";
  try {
    const fd = fs__default.default.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(HEAD_SCAN_BYTES);
      const n = fs__default.default.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      fs__default.default.closeSync(fd);
    }
  } catch {
    return {};
  }
  const out = {};
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  if (title) {
    const clean = decodeEntities(title).replace(/\s+/g, " ").trim().slice(0, 200);
    if (clean) out.title = clean;
  }
  const sf = head.indexOf("Page saved with SingleFile");
  if (sf !== -1) {
    const url = /url:\s*(\S+)/.exec(head.slice(sf))?.[1];
    if (url) out.url = url;
    const rawDate = /saved date:\s*([^\n\r<]+)/.exec(head.slice(sf))?.[1]?.trim().replace(/\s*-->\s*$/, "").trim();
    if (rawDate) {
      const t = Date.parse(rawDate);
      out.savedDate = Number.isFinite(t) ? new Date(t).toISOString() : rawDate;
    }
  }
  return out;
}
var execFileAsync = util.promisify(child_process.execFile);
function discoverGitWorkdir(capturesDir) {
  try {
    const top = child_process.execFileSync("git", ["-C", capturesDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5e3 }).trim();
    return {
      toplevel: top || null,
      run(args) {
        try {
          const out = child_process.execFileSync("git", ["-C", top, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3e4, killSignal: "SIGKILL" });
          return { ok: true, out };
        } catch (e) {
          return { ok: false, out: e?.stderr ?? String(e) };
        }
      },
      async runAsync(args) {
        try {
          const { stdout } = await execFileAsync("git", ["-C", top, ...args], { encoding: "utf8", timeout: 3e4, killSignal: "SIGKILL" });
          return { ok: true, out: stdout };
        } catch (e) {
          return { ok: false, out: e?.stderr ?? String(e) };
        }
      }
    };
  } catch {
    return { toplevel: null, run: () => ({ ok: false, out: "no git repo" }), runAsync: async () => ({ ok: false, out: "no git repo" }) };
  }
}
function createCapturesManager(cfg, deps) {
  const log = deps.log ?? (() => void 0);
  let cache = null;
  const dirMtime = () => {
    try {
      return fs__default.default.statSync(cfg.dir).mtimeMs;
    } catch {
      return 0;
    }
  };
  const dirFingerprint = () => {
    const bits = [];
    for (const relpath of listCaptures(cfg.dir, cfg.recursive)) {
      let st;
      try {
        st = fs__default.default.statSync(path__default.default.join(cfg.dir, relpath));
      } catch {
        continue;
      }
      bits.push(`${relpath}:${st.mtimeMs}:${st.size}`);
    }
    return bits.join("|");
  };
  const buildManifest = () => {
    const m = dirMtime();
    const fp = dirFingerprint();
    if (cache && cache.dirMtimeMs === m && cache.fingerprint === fp) {
      return { ok: true, json: cache.json };
    }
    const json = { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), captures: [] };
    const seen = /* @__PURE__ */ new Map();
    for (const relpath of listCaptures(cfg.dir, cfg.recursive)) {
      const abs = path__default.default.join(cfg.dir, relpath);
      let size = 0;
      try {
        size = fs__default.default.statSync(abs).size;
      } catch {
        continue;
      }
      const id = deps.captureId(relpath);
      const clash = seen.get(id);
      if (clash) {
        return { ok: false, error: `manifest: capture id collision \u2014 '${clash}' and '${relpath}' both map to id '${id}'. Rename one of them (rename = new identity; threads stay keyed to the old id).` };
      }
      seen.set(id, relpath);
      json.captures.push({ id, relpath, size, ...scanHead(abs) });
    }
    cache = { dirMtimeMs: m, fingerprint: fp, json };
    return { ok: true, json };
  };
  const invalidate = () => {
    cache = null;
  };
  const isServableRel = (rel) => {
    const built = buildManifest();
    if (!built.ok) return false;
    return built.json.captures.some((c) => c.relpath === rel);
  };
  const upload = async (name, content, overwrite, git) => {
    if (typeof name !== "string" || !name.trim()) return { ok: false, status: 400, error: "missing capture name" };
    const clean = name.trim();
    if (clean.length > 200) return { ok: false, status: 400, error: "capture name too long (max 200 chars)" };
    if (/[\\/]|\.\./.test(clean)) return { ok: false, status: 400, error: "capture name must be a bare file name (no path separators)" };
    if (clean.startsWith(".")) return { ok: false, status: 400, error: "capture name may not start with a dot (dot-files are invisible to the scan)" };
    if (HTML_RE.test(clean) === false) return { ok: false, status: 400, error: "capture name must end with .html or .htm" };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) return { ok: false, status: 400, error: "capture name contains control characters" };
    if (typeof content !== "string" || content.length === 0) return { ok: false, status: 400, error: "missing capture content" };
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > 100 * 1024 * 1024) return { ok: false, status: 413, error: `capture too large (${bytes} bytes; max 100MB)` };
    const abs = path__default.default.join(cfg.dir, clean);
    if (path__default.default.dirname(abs) !== cfg.dir) return { ok: false, status: 400, error: "bad capture name" };
    if (!overwrite && fs__default.default.existsSync(abs)) return { ok: false, status: 409, error: `a capture named '${clean}' already exists (send overwrite:true to replace it)`, existing: true };
    const wantId = deps.captureId(clean);
    const built0 = buildManifest();
    if (built0.ok) {
      const clashRel = built0.json.captures.find((c) => c.id === wantId && c.relpath !== clean)?.relpath;
      if (clashRel) return { ok: false, status: 409, error: `capture id collision \u2014 '${clean}' and '${clashRel}' both map to id '${wantId}'. Rename one (rename = new identity).`, existing: false };
    }
    fs__default.default.writeFileSync(abs, content, "utf8");
    invalidate();
    const entry = { id: deps.captureId(clean), relpath: clean, size: bytes, ...scanHead(abs) };
    let durability = "file written (no git repo \u2014 not backed up)";
    const g = git ?? discoverGitWorkdir(cfg.dir);
    if (g.toplevel) {
      const rel = path__default.default.relative(g.toplevel, abs);
      const add = await g.runAsync(["add", "--", rel]);
      const commit = add.ok ? await g.runAsync(["commit", "-m", `capture upload: ${clean} (dom-annotakit)`, "--no-verify", "--", rel]) : add;
      const push = commit.ok ? await g.runAsync(["push", "origin", "HEAD:main"]) : commit;
      durability = push.ok ? "written + committed + pushed" : `written; git durability: ${push.out.slice(0, 160)}`;
      if (!push.ok) log("captures: git durability failed:", push.out.slice(0, 300));
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
    invalidate
  };
}
function createSpecContextStore() {
  let current = {};
  const INVALID = /* @__PURE__ */ Symbol("invalid");
  const clean = (v) => {
    if (v == null) return null;
    if (typeof v !== "string") return INVALID;
    const t = v.trim().replace(/\s+/g, " ");
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
      if (epic === INVALID || story === INVALID) throw new Error("context values must be strings or null");
      current = {
        ...epic ? { epic } : {},
        ...story ? { story } : {}
      };
    }
  };
}
var PRELOAD_CAP = 2 * 1e3 * 1e3;
var THREAD_CREATE_DOOR = "/annotakit/api/threads";
var COMMENT_DOOR_RE = /^\/annotakit\/api\/threads\/[^/]+\/comments$/;
function isRewriteDoor(urlStr) {
  return urlStr === THREAD_CREATE_DOOR || COMMENT_DOOR_RE.test(urlStr);
}
function preloadBody(req, res, onOversize) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on("data", (c) => {
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
    req.on("end", () => {
      if (oversize) return resolve(null);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => resolve(null));
    req.on("close", () => resolve(null));
  });
}
function rewriteDoorBody(urlStr, body, context) {
  if (!context.epic && !context.story) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const obj = parsed;
  if (urlStr === THREAD_CREATE_DOOR) {
    const comments = obj.comments;
    if (!Array.isArray(comments) || comments.length === 0) return body;
    const first = comments[0];
    if (first === null || typeof first !== "object" || typeof first.body !== "string") return body;
    const next2 = applySpecContext(first.body, context);
    if (next2 === first.body) return body;
    const patched = { ...obj, comments: [{ ...first, body: next2 }, ...comments.slice(1)] };
    return Buffer.from(JSON.stringify(patched), "utf8");
  }
  if (typeof obj.body !== "string") return body;
  const next = applySpecContext(obj.body, context);
  if (next === obj.body) return body;
  return Buffer.from(JSON.stringify({ ...obj, body: next }), "utf8");
}
function wrapRequestWithBody(req, body) {
  const stream$1 = new stream.PassThrough();
  stream$1.end(body);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers[k] = v;
  }
  headers["content-length"] = String(body.length);
  const wrapper = Object.create(stream$1);
  Object.defineProperties(wrapper, {
    method: { value: req.method },
    url: { value: req.url },
    headers: { value: headers },
    socket: { value: req.socket },
    httpVersion: { value: req.httpVersion },
    __domAkWrapped: { value: true }
  });
  return wrapper;
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": String(Buffer.byteLength(body)) });
  res.end(body);
}
async function readJson(req, cap = PRELOAD_CAP) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on("data", (c) => {
      if (oversize) return;
      size += c.length;
      if (size > cap) {
        oversize = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (oversize) return resolve({ ok: false, status: 413, error: "body too large" });
      if (chunks.length === 0) return resolve({ ok: true, body: {} });
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return resolve({ ok: false, status: 400, error: "body must be a JSON object" });
        }
        resolve({ ok: true, body: parsed });
      } catch {
        resolve({ ok: false, status: 400, error: "invalid JSON body" });
      }
    });
    req.on("error", () => resolve({ ok: false, status: 400, error: "request stream error" }));
  });
}
async function specCatalogPayload(deps) {
  let local = { epics: [], stories: [], captures: {} };
  try {
    const threads = await deps.listThreads() ?? [];
    local = buildSpecIndex(Array.isArray(threads) ? threads : []);
  } catch {
  }
  const board = deps.mirror.catalog();
  return { catalog: mergeCatalog(board, local), context: deps.specContext.get() };
}
function handleHostRoutes(req, res, deps) {
  const log = deps.log ?? (() => void 0);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    return false;
  }
  const method = req.method ?? "GET";
  if (pathname === "/dom-annotakit-spec.json") {
    if (method !== "GET") {
      res.writeHead(405, { Allow: "GET" });
      res.end();
      return true;
    }
    void specCatalogPayload(deps).then((payload) => sendJson(res, 200, payload)).catch((e) => {
      log("spec catalog failed:", e instanceof Error ? e.message : String(e));
      sendJson(res, 500, { error: "spec catalog unavailable" });
    });
    return true;
  }
  if (pathname === "/dom-annotakit-spec-context") {
    if (method !== "PUT") {
      res.writeHead(405, { Allow: "PUT" });
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
        deps.specContext.set(read.body);
      } catch (e) {
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      sendJson(res, 200, { ok: true, context: deps.specContext.get() });
    })();
    return true;
  }
  if (pathname === "/dom-annotakit-captures") {
    if (method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return true;
    }
    void (async () => {
      const read = await readJson(req, 110 * 1024 * 1024);
      if (!read.ok) {
        sendJson(res, read.status, { error: read.error });
        return;
      }
      const name = typeof read.body.name === "string" ? read.body.name : "";
      const content = typeof read.body.content === "string" ? read.body.content : "";
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
  if (pathname === "/dom-annotakit-project.json" && method === "POST") {
    void (async () => {
      const read = await readJson(req);
      if (!read.ok) {
        sendJson(res, read.status, { error: read.error });
        return;
      }
      if (read.body.action !== "pass") {
        sendJson(res, 400, { error: `unknown action ${JSON.stringify(read.body.action ?? null)} \u2014 {"action":"pass"} forces a mirror reconcile` });
        return;
      }
      try {
        await deps.mirror.reconcile();
      } catch (e) {
        log("project pass failed:", e);
      }
      sendJson(res, 200, deps.mirror.status());
    })();
    return true;
  }
  return false;
}

exports.RECURSIVE_DENY = RECURSIVE_DENY;
exports.THREAD_CREATE_DOOR = THREAD_CREATE_DOOR;
exports.createCapturesManager = createCapturesManager;
exports.createSpecContextStore = createSpecContextStore;
exports.discoverGitWorkdir = discoverGitWorkdir;
exports.handleHostRoutes = handleHostRoutes;
exports.isRewriteDoor = isRewriteDoor;
exports.listCaptures = listCaptures;
exports.preloadBody = preloadBody;
exports.resolveCapturesDir = resolveCapturesDir;
exports.rewriteDoorBody = rewriteDoorBody;
exports.scanHead = scanHead;
exports.specCatalogPayload = specCatalogPayload;
exports.wrapRequestWithBody = wrapRequestWithBody;
