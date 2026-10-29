#!/usr/bin/env node
'use strict';

var http = require('http');
var events = require('events');
var fs3 = require('fs');
var path2 = require('path');
var crypto = require('crypto');
var child_process = require('child_process');
var os = require('os');
var util = require('util');
var stream = require('stream');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var http__default = /*#__PURE__*/_interopDefault(http);
var fs3__default = /*#__PURE__*/_interopDefault(fs3);
var path2__default = /*#__PURE__*/_interopDefault(path2);
var os__default = /*#__PURE__*/_interopDefault(os);

var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var fsSync = __require("fs");
var TombstonedIdError = class extends Error {
  deletedId = true;
  constructor(id) {
    super(`id ${id} was deleted \u2014 tombstones are final (delete-wins). POST with a new id.`);
    this.name = "TombstonedIdError";
  }
};
function readStoreFile(filePath) {
  if (!fsSync.existsSync(filePath)) return null;
  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(filePath, "utf8"));
      return { threads: parsed.threads ?? [], deletedIds: new Set(parsed.deleted ?? []) };
    } catch {
      return null;
    }
  }
  try {
    const nodeSqlite = process.getBuiltinModule?.("node:sqlite");
    const DatabaseSync = nodeSqlite?.DatabaseSync;
    if (!DatabaseSync) return null;
    const db = new DatabaseSync(filePath, { readOnly: true });
    try {
      const threads = db.prepare("SELECT payload FROM threads").all().map((r) => JSON.parse(String(r.payload)));
      let deletedIds = /* @__PURE__ */ new Set();
      try {
        deletedIds = new Set(db.prepare("SELECT id FROM deleted_threads").all().map((r) => String(r.id)));
      } catch {
      }
      return { threads, deletedIds };
    } finally {
      db.close?.();
    }
  } catch {
    return null;
  }
}
function newId() {
  return `th_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
var SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  story_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_story ON threads(story_id);
CREATE TABLE IF NOT EXISTS counters (
  story_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tombstones (
  issue INTEGER PRIMARY KEY,
  done INTEGER NOT NULL DEFAULT 0,
  repo TEXT,
  thread_id TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
  thread_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deleted_threads (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL
);
`;
function sqliteStore(db, storePath) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  {
    const cols = new Set(db.prepare("PRAGMA table_info(tombstones)").all().map((r) => String(r.name)));
    if (!cols.has("repo")) db.exec("ALTER TABLE tombstones ADD COLUMN repo TEXT");
    if (!cols.has("thread_id")) db.exec("ALTER TABLE tombstones ADD COLUMN thread_id TEXT");
  }
  const rowToThread = (row) => JSON.parse(row.payload);
  const listThreads = async (filter) => {
    const where = [];
    const args = [];
    if (filter?.storyId) {
      where.push("story_id = ?");
      args.push(filter.storyId);
    }
    if (filter?.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    const sql = `SELECT payload FROM threads ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY story_id ASC, number ASC`;
    const rows = db.prepare(sql).all(...args);
    return rows.map(rowToThread);
  };
  const getThread = async (id) => {
    const row = db.prepare("SELECT payload FROM threads WHERE id = ?").get(id);
    return row ? rowToThread(row) : null;
  };
  const nextNumber = (storyId) => {
    const row = db.prepare("SELECT next_number FROM counters WHERE story_id = ?").get(storyId);
    const n = row ? Number(row.next_number) : 1;
    db.prepare(
      "INSERT INTO counters (story_id, next_number) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET next_number = ?"
    ).run(storyId, n + 1, n + 1);
    return n;
  };
  const createThread = async (input) => {
    const id = input.id ?? newId();
    const tombstoned = db.prepare("SELECT 1 AS x FROM deleted_threads WHERE id = ?").get(id);
    if (tombstoned) throw new TombstonedIdError(id);
    const existing = db.prepare("SELECT payload FROM threads WHERE id = ?").get(id);
    if (existing) return rowToThread(existing);
    const ts = nowIso();
    const first = input.comments[0];
    const thread = {
      id,
      number: nextNumber(input.storyId),
      storyId: input.storyId,
      status: "open",
      createdAt: ts,
      updatedAt: ts,
      author: first?.author ?? "anonymous",
      story: {
        storyId: input.storyId,
        ...input.story
      },
      component: input.component ?? null,
      target: input.target,
      comments: input.comments,
      // v0.6.9 (S3): transient (frozen-capture) flag plumb-through — explicit
      // row builders drop unknown ThreadInput fields, so every create site
      // carries it (sqlite here, json store, staticStore).
      transient: input.transient === true ? true : void 0
    };
    db.prepare("INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      thread.number,
      thread.storyId,
      thread.status,
      thread.updatedAt,
      JSON.stringify(thread)
    );
    return thread;
  };
  const updateThread = async (thread) => {
    const next = { ...thread, updatedAt: nowIso() };
    const r = db.prepare("UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?").run(next.number, next.storyId, next.status, next.updatedAt, JSON.stringify(next), next.id);
    return Number(r.changes) > 0 ? next : null;
  };
  const mutateThread = async (id, fn) => {
    const row = db.prepare("SELECT payload FROM threads WHERE id = ?").get(id);
    if (!row) return null;
    const t = rowToThread(row);
    const before = JSON.stringify(t);
    const out = fn(t) ?? t;
    if (JSON.stringify(out) === before) return null;
    const next = { ...out, updatedAt: nowIso() };
    db.prepare("UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?").run(
      next.number,
      next.storyId,
      next.status,
      next.updatedAt,
      JSON.stringify(next),
      next.id
    );
    return next;
  };
  const deleteThread = async (id) => {
    const exists = db.prepare("SELECT 1 FROM threads WHERE id = ?").get(id);
    if (!exists) return false;
    db.prepare("INSERT OR REPLACE INTO deleted_threads (id, deleted_at) VALUES (?, ?)").run(id, nowIso());
    db.prepare("DELETE FROM snapshots WHERE thread_id = ?").run(id);
    db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    return true;
  };
  const countThreads = async () => {
    const row = db.prepare("SELECT COUNT(*) AS c FROM threads").get();
    return Number(row?.c ?? 0);
  };
  const checkpoint = () => {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
    }
  };
  const tombstone = async (issue, repo, threadId) => {
    if (!Number.isFinite(issue) || issue <= 0) return;
    db.prepare(
      "INSERT INTO tombstones (issue, done, repo, thread_id) VALUES (?, 0, ?, ?) ON CONFLICT(issue) DO UPDATE SET repo = excluded.repo, thread_id = excluded.thread_id"
    ).run(issue, repo ?? null, threadId ?? null);
  };
  const listOpenTombstones = async () => db.prepare("SELECT issue, repo, thread_id FROM tombstones WHERE done = 0 ORDER BY issue ASC").all().map((r) => ({ issue: Number(r.issue), repo: r.repo == null ? void 0 : String(r.repo), threadId: r.thread_id == null ? void 0 : String(r.thread_id) }));
  const tombstoneDone = async (issue) => {
    db.prepare("DELETE FROM tombstones WHERE issue = ?").run(issue);
  };
  const putSnapshot = async (threadId, snap) => {
    db.prepare(
      "INSERT INTO snapshots (thread_id, payload) VALUES (?, ?) ON CONFLICT(thread_id) DO UPDATE SET payload = ?"
    ).run(threadId, JSON.stringify(snap), JSON.stringify(snap));
  };
  const getSnapshot = async (threadId) => {
    const row = db.prepare("SELECT payload FROM snapshots WHERE thread_id = ?").get(threadId);
    return row ? JSON.parse(row.payload) : null;
  };
  const listSnapshotIds = async () => new Set(db.prepare("SELECT thread_id FROM snapshots").all().map((r) => String(r.thread_id)));
  const listDeletedIds = async () => new Set(db.prepare("SELECT id FROM deleted_threads").all().map((r) => String(r.id)));
  const upsertMergedThread = async (thread) => {
    const tomb = db.prepare("SELECT 1 AS x FROM deleted_threads WHERE id = ?").get(thread.id);
    if (tomb) return;
    const existing = db.prepare("SELECT payload, number FROM threads WHERE id = ?").get(thread.id);
    const number = existing ? Number(existing.number) : thread.number ?? 1;
    const payload = JSON.stringify({ ...thread, number });
    if (existing) {
      db.prepare("UPDATE threads SET number = ?, story_id = ?, status = ?, updated_at = ?, payload = ? WHERE id = ?").run(
        number,
        thread.storyId,
        thread.status ?? "open",
        thread.updatedAt ?? nowIso(),
        payload,
        thread.id
      );
    } else {
      db.prepare("INSERT INTO threads (id, number, story_id, status, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?)").run(
        thread.id,
        number,
        thread.storyId,
        thread.status ?? "open",
        thread.updatedAt ?? nowIso(),
        payload
      );
    }
  };
  const importTombstones = async (ids) => {
    for (const id of ids) {
      db.prepare("INSERT OR IGNORE INTO deleted_threads (id, deleted_at) VALUES (?, ?)").run(id, nowIso());
      db.prepare("DELETE FROM snapshots WHERE thread_id = ?").run(id);
      db.prepare("DELETE FROM threads WHERE id = ?").run(id);
    }
  };
  const recomputeCounters = async () => {
    const rows = db.prepare("SELECT story_id, MAX(number) AS maxn FROM threads GROUP BY story_id").all();
    for (const row of rows) {
      const next = Number(row.maxn ?? 0) + 1;
      db.prepare(
        "INSERT INTO counters (story_id, next_number) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET next_number = MAX(next_number, ?)"
      ).run(String(row.story_id), next, next);
    }
  };
  return {
    kind: "sqlite",
    storePath,
    listThreads,
    getThread,
    createThread,
    updateThread,
    mutateThread,
    deleteThread,
    countThreads,
    checkpoint,
    tombstone,
    listOpenTombstones,
    tombstoneDone,
    putSnapshot,
    getSnapshot,
    listSnapshotIds,
    listDeletedIds,
    upsertMergedThread,
    importTombstones,
    recomputeCounters,
    close: () => {
      try {
        db.close?.();
      } catch {
      }
    }
  };
}
function jsonStore(storePath) {
  let doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
  let queue = Promise.resolve();
  let loaded = false;
  let lastReadError = null;
  const load = async () => {
    let raw;
    try {
      raw = await fs3.promises.readFile(storePath, "utf8");
    } catch (err) {
      const code = err.code;
      if (code === "ENOENT") {
        doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
        lastReadError = null;
        loaded = true;
        return;
      }
      lastReadError = `store read failed (${code ?? "unknown"}): ${err instanceof Error ? err.message : String(err)}`;
      loaded = true;
      return;
    }
    if (!raw.trim()) {
      doc = { threads: [], counters: {}, tombstones: [], snapshots: {}, deleted: [] };
      lastReadError = null;
      loaded = true;
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not a store document");
      }
      doc = {
        threads: parsed.threads ?? [],
        counters: parsed.counters ?? {},
        tombstones: parsed.tombstones ?? [],
        snapshots: parsed.snapshots ?? {},
        deleted: parsed.deleted ?? []
      };
      lastReadError = null;
    } catch (err) {
      lastReadError = `store file unparsable (${raw.length} bytes): ${err instanceof Error ? err.message : String(err)}`;
    }
    loaded = true;
  };
  const persist = async () => {
    const tmp = `${storePath}.${process.pid}.tmp`;
    await fs3.promises.mkdir(path2__default.default.dirname(storePath), { recursive: true });
    await fs3.promises.writeFile(tmp, JSON.stringify(doc, null, 1));
    await fs3.promises.rename(tmp, storePath);
  };
  const mutate = (fn) => {
    const p = queue.then(async () => {
      await load();
      if (lastReadError) {
        throw Object.assign(
          new Error(`store file not safely readable \u2014 mutation refused (in-memory data intact): ${lastReadError}`),
          { status: 500 }
        );
      }
      const out = await fn();
      await persist();
      return out;
    });
    queue = p.catch(() => void 0);
    return p;
  };
  const loadRead = async () => {
    if (!loaded) await load();
  };
  return {
    kind: "json",
    storePath,
    listThreads: async (filter) => {
      await loadRead();
      return doc.threads.filter(
        (t) => (!filter?.storyId || t.storyId === filter.storyId) && (!filter?.status || t.status === filter.status)
      ).sort((a, b) => a.storyId !== b.storyId ? a.storyId < b.storyId ? -1 : 1 : (a.number ?? 0) - (b.number ?? 0));
    },
    getThread: async (id) => {
      await loadRead();
      return doc.threads.find((t) => t.id === id) ?? null;
    },
    createThread: (input) => mutate(async () => {
      const id = input.id ?? newId();
      if (doc.deleted.includes(id)) throw new TombstonedIdError(id);
      const existing = doc.threads.find((t) => t.id === id);
      if (existing) return existing;
      const ts = nowIso();
      const n = doc.counters[input.storyId] ?? 1;
      doc.counters[input.storyId] = n + 1;
      const thread = {
        id,
        number: n,
        storyId: input.storyId,
        status: "open",
        createdAt: ts,
        updatedAt: ts,
        author: input.comments[0]?.author ?? "anonymous",
        story: { storyId: input.storyId, ...input.story },
        component: input.component ?? null,
        target: input.target,
        comments: input.comments,
        // v0.6.9 (S3): transient plumb-through (json store create).
        transient: input.transient === true ? true : void 0
      };
      doc.threads.push(thread);
      return thread;
    }),
    updateThread: (thread) => mutate(async () => {
      const next = { ...thread, updatedAt: nowIso() };
      const idx = doc.threads.findIndex((t) => t.id === next.id);
      if (idx < 0) return null;
      doc.threads[idx] = next;
      return next;
    }),
    mutateThread: (id, fn) => mutate(async () => {
      const idx = doc.threads.findIndex((t2) => t2.id === id);
      if (idx < 0) return null;
      const t = JSON.parse(JSON.stringify(doc.threads[idx]));
      const before = JSON.stringify(t);
      const out = fn(t) ?? t;
      if (JSON.stringify(out) === before) return null;
      const next = { ...out, updatedAt: nowIso() };
      doc.threads[idx] = next;
      return next;
    }),
    deleteThread: (id) => mutate(async () => {
      const idx = doc.threads.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      doc.threads.splice(idx, 1);
      delete doc.snapshots[id];
      if (!doc.deleted.includes(id)) doc.deleted.push(id);
      return true;
    }),
    countThreads: async () => {
      await loadRead();
      return doc.threads.length;
    },
    checkpoint: () => void 0,
    tombstone: (issue, repo, threadId) => mutate(async () => {
      if (Number.isFinite(issue) && issue > 0) {
        const existing = doc.tombstones.find((t) => t.issue === issue);
        if (!existing) doc.tombstones.push({ issue, done: false, repo, threadId });
        else {
          existing.repo = repo;
          existing.threadId = threadId;
        }
      }
    }),
    listOpenTombstones: async () => {
      await loadRead();
      return doc.tombstones.filter((t) => !t.done).map((t) => ({ issue: t.issue, repo: t.repo, threadId: t.threadId }));
    },
    tombstoneDone: (issue) => mutate(async () => {
      doc.tombstones = doc.tombstones.filter((t) => t.issue !== issue);
    }),
    putSnapshot: (threadId, snap) => mutate(async () => {
      doc.snapshots[threadId] = snap;
    }),
    getSnapshot: async (threadId) => {
      await loadRead();
      return doc.snapshots[threadId] ?? null;
    },
    listSnapshotIds: async () => {
      await loadRead();
      return new Set(Object.keys(doc.snapshots));
    },
    listDeletedIds: async () => {
      await loadRead();
      return new Set(doc.deleted);
    },
    upsertMergedThread: (thread) => mutate(async () => {
      if (doc.deleted.includes(thread.id)) return;
      const idx = doc.threads.findIndex((t) => t.id === thread.id);
      const merged = { ...thread, number: idx >= 0 ? doc.threads[idx].number : thread.number ?? 1 };
      if (idx >= 0) doc.threads[idx] = merged;
      else doc.threads.push(merged);
    }),
    importTombstones: (ids) => mutate(async () => {
      for (const id of ids) {
        if (!doc.deleted.includes(id)) doc.deleted.push(id);
        doc.threads = doc.threads.filter((t) => t.id !== id);
        delete doc.snapshots[id];
      }
    }),
    recomputeCounters: () => mutate(async () => {
      for (const t of doc.threads) {
        const n = (t.number ?? 0) + 1;
        if (n > (doc.counters[t.storyId] ?? 1)) doc.counters[t.storyId] = n;
      }
    }),
    close: () => void 0
  };
}
var current = null;
function getStore(configDir2, opts) {
  if (current) return current;
  const dataDir = opts?.dataDir ? path2__default.default.resolve(opts.dataDir) : path2__default.default.resolve(configDir2, "annotakit");
  try {
    fsSync.mkdirSync(dataDir, { recursive: true });
    const nodeSqlite = process.getBuiltinModule?.("node:sqlite");
    if (!nodeSqlite?.DatabaseSync) throw Object.assign(new Error("node:sqlite unavailable on this Node"), { benignFallback: true });
    const dbPath = path2__default.default.join(dataDir, "threads.db");
    let db;
    try {
      db = new nodeSqlite.DatabaseSync(dbPath);
    } catch (openErr) {
      const hasData = fsSync.existsSync(dbPath) && fsSync.statSync(dbPath).size > 0;
      throw Object.assign(
        new Error(`threads.db failed to open (${openErr instanceof Error ? openErr.message : String(openErr)})${hasData ? " \u2014 refusing to silently fall back to an empty store; is another dev server running?" : ""}`),
        { status: 500 }
      );
    }
    current = sqliteStore(db, dbPath);
  } catch (err) {
    if (!err?.benignFallback) {
      throw err;
    }
    console.warn(
      `[storybook-annotakit] node:sqlite unavailable (${err instanceof Error ? err.message : String(err)}) \u2014 using JSON file store`
    );
    current = jsonStore(path2__default.default.join(dataDir, "threads.json"));
  }
  return current;
}
async function migrateLegacyStore(configDir2, store, currentDataDir) {
  const legacyDir = path2__default.default.resolve(configDir2, "annotakit");
  const legacyPaths = [path2__default.default.join(legacyDir, "threads.db"), path2__default.default.join(legacyDir, "threads.json")];
  const marker = path2__default.default.join(currentDataDir, ".legacy-mtime");
  for (const legacy of legacyPaths) {
    if (!fsSync.existsSync(legacy)) continue;
    const mtime = fsSync.statSync(legacy).mtimeMs;
    let lastMtime = 0;
    try {
      lastMtime = Number(fsSync.readFileSync(marker, "utf8")) || 0;
    } catch {
    }
    if (mtime <= lastMtime) continue;
    const doc = readStoreFile(legacy);
    if (!doc) continue;
    await store.importTombstones(doc.deletedIds);
    for (const t of doc.threads) await store.upsertMergedThread(t);
    await store.recomputeCounters();
    try {
      fsSync.mkdirSync(path2__default.default.dirname(marker), { recursive: true });
      fsSync.writeFileSync(marker, String(mtime));
    } catch {
    }
    if (doc.threads.length) {
      console.warn(
        `[storybook-annotakit] migrated ${doc.threads.length} threads from legacy ${legacy} \u2014 the old file is left untouched; remove it with \`git rm\` when convenient`
      );
    }
    return doc.threads.length;
  }
  return 0;
}
var configWarnings = [];
function readConfig(configDir2) {
  const fsSync2 = __require("fs");
  const file = path2__default.default.resolve(configDir2, "annotakit.config.json");
  let raw;
  try {
    raw = fsSync2.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = `annotakit.config.json is not valid JSON (${err instanceof Error ? err.message : String(err)}) \u2014 IGNORED, defaults apply. Fix the file to restore its settings.`;
    console.warn(`[storybook-annotakit] ${msg}`);
    configWarnings.push(msg);
    return {};
  }
}

// src/shared/types.ts
var mirrorStateOf = (status) => status === "resolved" ? "closed" : "open";
var MAX_BODY_CHARS = 64e3;
var DIGEST_CLIP_CHARS = 200;
var ISSUE_BODY_LIMIT = 6e4;
var MIRROR_VERBATIM_MARKER = "(verbatim):**";

// src/shared/describe.ts
function clip(s, n) {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}\u2026` : t;
}
function elementSummary(ctx) {
  if (!ctx || !ctx.tag) return "(unknown element)";
  const parts = [ctx.tag];
  if (ctx.id) parts.push(`#${ctx.id}`);
  if (ctx.classes) {
    const classes = ctx.classes.split(/\s+/).filter(Boolean).slice(0, 3);
    if (classes.length) parts.push(classes.map((c) => `.${c}`).join(""));
  }
  if (ctx.nth && ctx.nth > 0) parts.push(`:nth(${ctx.nth})`);
  const attrs = [];
  if (ctx.testid) attrs.push(`testid=${ctx.testid}`);
  if (ctx.name) attrs.push(`name=${ctx.name}`);
  if (ctx.label) attrs.push(`label="${clip(ctx.label, 30)}"`);
  if (ctx.placeholder) attrs.push(`placeholder="${clip(ctx.placeholder, 30)}"`);
  if (ctx.alt) attrs.push(`alt="${clip(ctx.alt, 30)}"`);
  if (ctx.value) attrs.push(`value="${clip(ctx.value, 30)}"`);
  if (ctx.ariaLabel && !ctx.text) attrs.push(`aria-label="${clip(ctx.ariaLabel, 30)}"`);
  if (attrs.length) parts.push(` [${attrs.join(" ")}]`);
  const text = ctx.text ?? null;
  if (text) parts.push(` "${clip(text.replace(/\s+/g, " "), 48)}"`);
  return `<${parts.join("")}>`;
}

// src/shared/metaline.ts
function metaLine(value, cap = 300) {
  let line = String(value ?? "").replace(/\s+/g, " ").trim();
  line = line.replace(/^(?:(?:#+|[-*]+)\s*)+/, "");
  return line.length > cap ? line.slice(0, cap) + "\u2026" : line;
}
var ENV_KEYS = ["ANNOTAKIT_GH_TOKEN", "ANNOTAKIT_GH_API", "ANNOTAKIT_GH_AUTO", "ANNOTAKIT_GH_POLL", "ANNOTAKIT_GH_INTERVAL", "ANNOTAKIT_GH_REPO", "ANNOTAKIT_GH_LABELS", "ANNOTAKIT_ENV_TRACKED_OK", "ANNOTAKIT_API_KEY"];
function projectRoot(configDir2) {
  const abs = path2__default.default.isAbsolute(configDir2) ? configDir2 : path2__default.default.resolve(process.cwd(), configDir2);
  return path2__default.default.dirname(abs);
}
function parseDotEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7) : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    let value = cleaned.slice(eq + 1).trim();
    const m = value.match(/^(["'])([\s\S]*)\1$/);
    if (m) value = m[2] ?? "";
    else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key) out[key] = value;
  }
  return out;
}
var envLoaded = false;
function loadDotEnv(configDir2) {
  if (envLoaded) return { applied: [], file: null };
  envLoaded = true;
  const root = projectRoot(configDir2);
  const candidates = [
    path2__default.default.join(root, ".env"),
    path2__default.default.isAbsolute(configDir2) ? path2__default.default.join(configDir2, ".env") : path2__default.default.resolve(process.cwd(), configDir2, ".env"),
    path2__default.default.resolve(process.cwd(), ".env")
  ];
  const file = candidates.find((p) => fs3.existsSync(p));
  if (!file) return { applied: [], file: null };
  try {
    const parsed = parseDotEnv(fs3.readFileSync(file, "utf8"));
    const applied = [];
    for (const key of ENV_KEYS) {
      const v = parsed[key];
      if (v !== void 0 && !process.env[key]) {
        process.env[key] = v;
        bootAppliedKeys.push(key);
        envFileCache = file;
        if (v) applied.push(key);
      }
    }
    if (applied.length) {
      console.warn(`[storybook-annotakit] loaded ${applied.join(", ")} from ${file}`);
    }
    return { applied, file };
  } catch {
    return { applied: [], file: null };
  }
}
function ghToken() {
  return process.env.ANNOTAKIT_GH_TOKEN || void 0;
}
var bootAppliedKeys = [];
var envFileCache = null;
function reloadDotEnv(configDir2) {
  const root = projectRoot(configDir2);
  const candidates = [
    path2__default.default.join(root, ".env"),
    path2__default.default.isAbsolute(configDir2) ? path2__default.default.join(configDir2, ".env") : path2__default.default.resolve(process.cwd(), configDir2, ".env"),
    path2__default.default.resolve(process.cwd(), ".env")
  ];
  const file = candidates.find((p) => fs3.existsSync(p)) ?? null;
  const out = { changed: [], removed: [], requiresRestart: [], file, tokenChanged: false };
  if (!file) return out;
  try {
    const parsed = parseDotEnv(fs3.readFileSync(file, "utf8"));
    const prevFile = envFileCache;
    envFileCache = file;
    for (const key of bootAppliedKeys) {
      const fresh = parsed[key];
      const cur = process.env[key];
      if (fresh && fresh !== cur) {
        process.env[key] = fresh;
        out.changed.push(key);
        if (key !== "ANNOTAKIT_GH_TOKEN") out.requiresRestart.push(key);
        else out.tokenChanged = true;
      } else if (!fresh && cur !== void 0 && prevFile === file) {
        delete process.env[key];
        out.removed.push(key);
        if (key !== "ANNOTAKIT_GH_TOKEN") out.requiresRestart.push(key);
        else out.tokenChanged = true;
      }
    }
    if (!bootAppliedKeys.includes("ANNOTAKIT_GH_TOKEN") && parsed.ANNOTAKIT_GH_TOKEN && !process.env.ANNOTAKIT_GH_TOKEN) {
      process.env.ANNOTAKIT_GH_TOKEN = parsed.ANNOTAKIT_GH_TOKEN;
      bootAppliedKeys.push("ANNOTAKIT_GH_TOKEN");
      envFileCache = file;
      out.changed.push("ANNOTAKIT_GH_TOKEN");
      out.tokenChanged = true;
    }
  } catch {
  }
  return out;
}
var GH_OWNER_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function normalizeGhRepoInput(v) {
  const t = v.trim();
  if (!t) return null;
  if (GH_OWNER_NAME_RE.test(t)) return t;
  const parsed = parseGithubRepo(t);
  return parsed && GH_OWNER_NAME_RE.test(parsed) ? parsed : null;
}
function ghRepoEnv() {
  const v = process.env.ANNOTAKIT_GH_REPO;
  return v ? normalizeGhRepoInput(v) : null;
}
function ghLabelsEnv() {
  const v = process.env.ANNOTAKIT_GH_LABELS;
  if (!v) return null;
  const labels = v.split(/[,; ]+/).map((l) => l.trim()).filter(Boolean);
  return labels.length ? labels : null;
}
var gitRootCache;
function repoRelPath(p) {
  if (!p) return void 0;
  if (gitRootCache === void 0) {
    gitRootCache = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  }
  const root = gitRootCache;
  if (!root) return p;
  const abs = path2__default.default.resolve(process.cwd(), p);
  if (abs !== root && !abs.startsWith(root + path2__default.default.sep)) return p;
  return path2__default.default.relative(root, abs).replace(/\\/g, "/");
}
function git(root, args) {
  try {
    return child_process.execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
      encoding: "utf8",
      timeout: 4e3,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}
function parseGithubRepo(url) {
  const m = url.match(/github\.com(?::\d+)?[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/\s?#].*)?$/i) ?? url.match(/^github:([^/\s]+)\/([^/\s]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}
var repoCache = null;
function detectGithubRepo(root) {
  if (repoCache) return repoCache;
  const remote = git(root, ["remote", "get-url", "origin"]);
  if (remote) {
    const repo = parseGithubRepo(remote);
    if (repo) {
      repoCache = { repo, source: "git remote origin" };
      return repoCache;
    }
  }
  try {
    const pkg = JSON.parse(fs3.readFileSync(path2__default.default.join(root, "package.json"), "utf8"));
    const repoUrl = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (repoUrl) {
      const repo = parseGithubRepo(repoUrl);
      if (repo) {
        repoCache = { repo, source: "package.json repository" };
        return repoCache;
      }
    }
  } catch {
  }
  repoCache = { repo: null, source: "not found" };
  return repoCache;
}
function isGitRepo(root) {
  return git(root, ["rev-parse", "--is-inside-work-tree"]) === "true";
}
var commonDirCache;
function gitCommonDir(root) {
  if (commonDirCache && commonDirCache.root === root) return commonDirCache.value;
  const resolve = () => {
    if (!isGitRepo(root)) return null;
    let raw = git(root, ["rev-parse", "--git-common-dir"]);
    if (!raw) return null;
    if (!path2__default.default.isAbsolute(raw)) raw = path2__default.default.resolve(root, raw);
    return raw;
  };
  const value = resolve();
  commonDirCache = { root, value };
  return value;
}
function storeLocation(configDir2, opts) {
  const root = projectRoot(configDir2);
  if (opts?.forceClassic) return { dir: path2__default.default.join(configDir2, "annotakit"), mode: "classic", gitDir: null };
  const gitDir = gitCommonDir(root);
  if (gitDir) return { dir: path2__default.default.join(gitDir, "annotakit-dom"), mode: "git", gitDir };
  return { dir: path2__default.default.join(configDir2, "annotakit"), mode: "classic", gitDir: null };
}
function pathIsIgnored(root, absPath) {
  const rel = path2__default.default.isAbsolute(absPath) ? path2__default.default.relative(root, absPath) : absPath;
  if (rel.startsWith("..")) return true;
  return git(root, ["check-ignore", "--", rel]) !== null;
}
function isPathTracked(root, absPath) {
  const rel = path2__default.default.isAbsolute(absPath) ? path2__default.default.relative(root, absPath) : absPath;
  if (rel.startsWith("..")) return false;
  return git(root, ["ls-files", "--error-unmatch", "--", rel]) !== null;
}
var kitRepoCache;
function kitRepo() {
  if (kitRepoCache !== void 0) return kitRepoCache;
  kitRepoCache = null;
  try {
    for (const p of [path2__default.default.join(__dirname, "..", "package.json"), path2__default.default.join(__dirname, "..", "..", "package.json")]) {
      try {
        const pkg = JSON.parse(fs3.readFileSync(p, "utf8"));
        const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
        if (url) {
          kitRepoCache = parseGithubRepo(url);
          break;
        }
      } catch {
      }
    }
  } catch {
  }
  return kitRepoCache;
}

// src/server/digest.ts
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return oneLine(iso).slice(0, 40);
  return d.toISOString().replace("T", " ").slice(5, 16);
}
function oneLine(body) {
  return body.replace(/\s+/g, " ").trim();
}
function firstLine(body, n = 80) {
  const line = oneLine(body.split("\n")[0] ?? "");
  return line.length > n ? line.slice(0, n) + "\u2026" : line;
}
function clip2(body) {
  const line = oneLine(body);
  return line.length > DIGEST_CLIP_CHARS ? line.slice(0, DIGEST_CLIP_CHARS) + "\u2026" : line;
}
function threadBlock(t, snapshotUrl, full) {
  const first = t.comments[0];
  const headline = first ? full ? firstLine(first.body) || "(no text)" : clip2(first.body) : "(no text)";
  const status = t.status === "fixed" ? "FIXED" : t.status === "resolved" ? "RESOLVED" : t.status === "rejected" ? "REJECTED" : "OPEN";
  const out = [];
  out.push(`### Thread ${t.number} \xB7 ${status} \u2014 ${headline}`);
  out.push("");
  if (t.story) {
    const ip = repoRelPath(t.story.importPath) ?? t.story.importPath;
    if (t.story.importPath) out.push(`- capture: ${metaLine(`${t.story.title ?? ""}/${t.story.name ?? ""} (${ip})`)}`);
  }
  out.push(`- thread id: ${metaLine(t.id)}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${metaLine(comp.name + (comp.key ? ` (key="${comp.key}")` : ""))}`);
    if (comp.source) {
      const f = repoRelPath(comp.source.file) ?? comp.source.file;
      out.push(`- jsx: ${metaLine(`${f}:${comp.source.line ?? "?"}`)}`);
    }
    if (comp.chain?.length > 1) {
      out.push(`- chain: ${metaLine(comp.chain.slice(0, 5).join(" > "))}`);
    }
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) {
      out.push(`- props: ${metaLine(props.map(([k, v]) => `${k}=${v}`).join(" "))}`);
    }
  }
  const ctx = t.target.context;
  out.push(`- element: ${metaLine(elementSummary(ctx), 400)}`);
  if (t.target.selector.cssSelector) {
    out.push(`- selector: ${metaLine(t.target.selector.cssSelector, 400)}`);
  }
  if (snapshotUrl) {
    out.push(`- dom-snapshot: ${snapshotUrl} (story DOM at pin time; append ?format=html to render)`);
  }
  const replies = t.comments.slice(1);
  if (full) {
    for (const [i, c] of t.comments.entries()) {
      const via = c.source === "github" ? " via github" : "";
      const label = i === 0 ? "note" : "reply";
      out.push(`**${label} \u2014 ${metaLine(c.author, 60)}${via} ${metaLine(fmtDate(c.createdAt), 40)} (verbatim):**`);
      out.push("");
      out.push(c.body?.trim() || "(empty)");
      out.push("");
    }
  } else {
    for (const r of replies) {
      const via = r.source === "github" ? " (via github)" : "";
      out.push(`  - ${metaLine(r.author, 60)}${via} ${metaLine(fmtDate(r.createdAt), 40)}: ${clip2(r.body)}`);
    }
  }
  if (t.status === "resolved" && t.resolvedAt) {
    out.push(`  - resolved ${fmtDate(t.resolvedAt)}`);
  } else if (t.status === "fixed") {
    out.push("  - fixed: addressed, awaiting reviewer verification (confirm \u2192 resolved, reject \u2192 rejected)");
  } else if (t.status === "rejected") {
    out.push("  - rejected: the fix was NOT accepted \u2014 re-work expected (re-address \u2192 fixed re-enters review)");
  }
  out.push("");
  return out;
}
function renderDigest(stories, opts) {
  const out = [];
  const open = stories.reduce((n, s) => n + (Number(s.counts.open) || 0), 0);
  const fixed = stories.reduce((n, s) => n + (Number(s.counts.fixed) || 0), 0);
  const rejected = stories.reduce((n, s) => n + (Number(s.counts.rejected) || 0), 0);
  const resolved = stories.reduce((n, s) => n + (Number(s.counts.resolved) || 0), 0);
  const title = stories.length === 1 ? `UI review \u2014 ${metaLine(stories[0].story.title ?? stories[0].story.storyId, 120)}` : `UI review \u2014 ${stories.length} captures`;
  out.push(`# ${title}`);
  out.push("");
  out.push(`${open} open / ${fixed} fixed (awaiting review) / ${rejected} rejected (re-work) / ${resolved} resolved \xB7 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ")}`);
  if (opts?.origin) out.push(`review app: ${opts.origin}`);
  out.push("");
  for (const s of stories) {
    const st = s.story;
    const storyTitle = [st.title ?? st.storyId, st.name].filter(Boolean).join(" / ");
    out.push(`## ${metaLine(storyTitle, 160)}`);
    out.push("");
    out.push(`capture id: \`${metaLine(st.storyId, 200)}\``);
    if (st.importPath) out.push(`capture file: ${metaLine(repoRelPath(st.importPath) ?? st.importPath)}`);
    if (st.componentPath) out.push(`component file (SB lineage): ${metaLine(repoRelPath(st.componentPath) ?? st.componentPath)}`);
    if (st.url) out.push(`open: ${metaLine(st.url, 300)}`);
    out.push("");
    if (s.threads.length === 0) {
      out.push("_no threads_");
      out.push("");
      continue;
    }
    const openThreads = s.threads.filter((t) => t.status !== "fixed" && t.status !== "rejected" && t.status !== "resolved");
    const reviewThreads = s.threads.filter((t) => t.status === "fixed");
    const reworkThreads = s.threads.filter((t) => t.status === "rejected");
    const done = s.threads.filter((t) => t.status === "resolved");
    const snapUrl = (t) => !opts?.mirror && opts?.snapshotIds?.has(t.id) ? `${opts?.origin ?? ""}/annotakit/api/threads/${encodeURIComponent(t.id)}/snapshot` : void 0;
    for (const t of openThreads) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
    if (reviewThreads.length) {
      out.push(`**${reviewThreads.length} awaiting review (agent marked fixed):**`);
      out.push("");
      for (const t of reviewThreads) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
    }
    if (reworkThreads.length) {
      out.push(`**${reworkThreads.length} rejected \u2014 re-work (the reviewer did not accept the fix):**`);
      out.push("");
      for (const t of reworkThreads) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
    }
    if (done.length) {
      out.push(`<details><summary>${done.length} resolved</summary>`);
      out.push("");
      for (const t of done) out.push(...threadBlock(t, snapUrl(t), opts?.fullText));
      out.push(`</details>`);
      out.push("");
    }
  }
  out.push("---");
  out.push("");
  const footer = opts?.mirror ? "Agent loop: open the capture (the `open:` link) \u2014 the `element:`/`selector:` rows locate the pinned target in the capture; comment with fix evidence, then mark the thread FIXED \u2014 do NOT close this issue: on this mirror, closing = the reviewer CONFIRMED your fix (they close it, or confirm in the review app drawer). A REJECTED thread means the fix was not accepted: re-work it and comment evidence again, then mark it FIXED again for re-verification." : `Agent loop: open the capture (the \`open:\` link) \u2014 the \`element:\`/\`selector:\` rows locate the pinned target in the capture; comment with fix evidence, then PATCH ${opts?.origin ?? ""}/annotakit/api/threads/<id> with {"status":"fixed"} (addressed, awaiting the reviewer's verification \u2014 {"status":"resolved"} is the reviewer's confirmation, not yours; a REJECTED thread needs re-work: fix again, then PATCH {"status":"fixed"} to re-enter review).`;
  out.push(footer);
  out.push("");
  return out.join("\n");
}

// src/server/merge.ts
function cloneThread(t) {
  return { ...t, comments: t.comments.map((c) => ({ ...c })) };
}
function later(a, b) {
  const at = Date.parse(a.updatedAt ?? "");
  const bt = Date.parse(b.updatedAt ?? "");
  const aOk = Number.isFinite(at);
  const bOk = Number.isFinite(bt);
  if (aOk && bOk) return at >= bt ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return a;
}
function fresherOf(hi, lo) {
  const h = Date.parse(hi ?? "");
  const l = Date.parse(lo ?? "");
  if (Number.isFinite(h) && Number.isFinite(l)) return l > h ? lo : hi;
  if (Number.isFinite(l)) return lo;
  return hi;
}
function instantMaxUpdatedAt(newer, older) {
  const nT = Date.parse(newer.updatedAt ?? "");
  const oT = Date.parse(older.updatedAt ?? "");
  if (Number.isFinite(nT) && Number.isFinite(oT)) return nT >= oT ? newer.updatedAt : older.updatedAt;
  if (Number.isFinite(nT)) return newer.updatedAt;
  if (Number.isFinite(oT)) return older.updatedAt;
  return String(newer.updatedAt ?? "") >= String(older.updatedAt ?? "") ? newer.updatedAt : older.updatedAt;
}
function instantMinCreatedAt(newer, older) {
  const nT = Date.parse(newer.createdAt ?? "");
  const oT = Date.parse(older.createdAt ?? "");
  if (Number.isFinite(nT) && Number.isFinite(oT)) return nT <= oT ? newer.createdAt : older.createdAt;
  if (Number.isFinite(nT)) return newer.createdAt;
  if (Number.isFinite(oT)) return older.createdAt;
  return older.createdAt ?? newer.createdAt;
}
function collapseCommentTwins(comments) {
  const seenGhIds = /* @__PURE__ */ new Map();
  const out = [];
  for (const c of comments) {
    const ghId = typeof c.ghId === "string" && c.ghId && c.ghId !== "issue-body" ? c.ghId : null;
    const twin = ghId ? seenGhIds.get(ghId) : void 0;
    if (twin) {
      if (!twin.body && c.body) twin.body = c.body;
      if (!twin.ghId && c.ghId) twin.ghId = c.ghId;
      if (!twin.source && c.source) twin.source = c.source;
      continue;
    }
    const clone = { ...c };
    if (ghId) seenGhIds.set(ghId, clone);
    out.push(clone);
  }
  return out;
}
function healThreadTwins(t) {
  const healed = collapseCommentTwins(t.comments);
  if (healed.length === t.comments.length) return t;
  return { ...t, comments: healed };
}
function unionComments(a, b) {
  const out = collapseCommentTwins(a.comments);
  const byId = new Map(out.map((c) => [c.id, c]));
  const byGhId = /* @__PURE__ */ new Map();
  for (const c of out) {
    if (c.ghId && c.ghId !== "issue-body" && !byGhId.has(c.ghId)) byGhId.set(c.ghId, c);
  }
  for (const rc of b.comments) {
    const existing = byId.get(rc.id) ?? (rc.ghId && rc.ghId !== "issue-body" ? byGhId.get(rc.ghId) : void 0);
    if (!existing) {
      out.push({ ...rc });
      byId.set(rc.id, rc);
      if (rc.ghId && rc.ghId !== "issue-body" && !byGhId.has(rc.ghId)) byGhId.set(rc.ghId, rc);
    } else {
      if (!existing.body && rc.body) existing.body = rc.body;
      if (!existing.ghId && rc.ghId) existing.ghId = rc.ghId;
      if (!existing.source && rc.source) existing.source = rc.source;
    }
  }
  out.sort((x, y) => String(x.createdAt ?? "").localeCompare(String(y.createdAt ?? "")));
  return out;
}
var STATUS_RANK = { open: 0, fixed: 1, rejected: 2, resolved: 3 };
function mergeThread(local, remote) {
  if (!local) return remote ? healThreadTwins(cloneThread(remote)) : null;
  if (!remote) return healThreadTwins(cloneThread(local));
  const newer = later(local, remote);
  const older = newer === local ? remote : local;
  const merged = cloneThread(newer);
  const rankL = STATUS_RANK[local.status];
  const rankR = STATUS_RANK[remote.status];
  const hi = rankL >= rankR ? local : remote;
  const lo = rankL >= rankR ? remote : local;
  const hiT = Date.parse(hi.updatedAt ?? "");
  const eventFresh = !Number.isFinite(hiT) || Date.parse(lo.reopenedAt ?? "") >= hiT;
  const downgradeProven = lo.reopenedAt != null && later(lo, hi) === lo && eventFresh;
  merged.status = downgradeProven ? lo.status : hi.status;
  merged.reopenedAt = downgradeProven ? lo.reopenedAt : rankL === rankR && merged.status !== "resolved" ? fresherOf(hi.reopenedAt, lo.reopenedAt) : hi.reopenedAt;
  if (merged.status === "resolved") {
    if (!merged.resolvedAt) merged.resolvedAt = local.resolvedAt ?? remote.resolvedAt;
  } else {
    delete merged.resolvedAt;
  }
  if (!merged.gh?.issue) {
    const gh = local.gh?.issue ? local.gh : remote.gh?.issue ? remote.gh : null;
    if (gh) merged.gh = { ...gh };
  }
  if (local.ghUnlinkedAt != null || remote.ghUnlinkedAt != null) {
    const markerAt = Date.parse(fresherOf(local.ghUnlinkedAt, remote.ghUnlinkedAt) ?? "");
    const ghSide = local.gh?.issue ? local : remote.gh?.issue ? remote : null;
    const reCreated = ghSide != null && Number.isFinite(markerAt) && Date.parse(ghSide.updatedAt ?? "") > markerAt;
    if (reCreated) {
      delete merged.ghUnlinkedAt;
    } else {
      delete merged.gh;
      merged.ghUnlinkedAt = fresherOf(local.ghUnlinkedAt, remote.ghUnlinkedAt);
    }
  }
  merged.comments = unionComments(newer, older);
  merged.updatedAt = instantMaxUpdatedAt(newer, older);
  merged.createdAt = instantMinCreatedAt(newer, older);
  return merged;
}
function logicalMerge(local, remote) {
  const deleted = /* @__PURE__ */ new Set([...local.deletedIds, ...remote.deletedIds]);
  const ids = /* @__PURE__ */ new Set();
  for (const t of local.threads) ids.add(t.id);
  for (const t of remote.threads) ids.add(t.id);
  const threads = [];
  for (const id of ids) {
    if (deleted.has(id)) continue;
    const merged = mergeThread(
      local.threads.find((t) => t.id === id),
      remote.threads.find((t) => t.id === id)
    );
    if (merged) threads.push(merged);
  }
  threads.sort((a, b) => a.storyId !== b.storyId ? a.storyId < b.storyId ? -1 : 1 : (a.number ?? 0) - (b.number ?? 0));
  return { threads, deletedIds: deleted };
}

// src/server/gh.ts
var DEFAULT_API = "https://api.github.com";
var FETCH_TIMEOUT_MS = 15e3;
var GH_SENTINEL = "<!-- annotakit -->";
function ghApiBase() {
  const raw = (process.env.ANNOTAKIT_GH_API || "").trim().replace(/\/+$/, "");
  const base = raw || DEFAULT_API;
  if (!/^https?:\/\/[^/\s]+(\/[^\s]*)?$/i.test(base)) {
    throw new Error(`ANNOTAKIT_GH_API must be an http(s) origin like https://github.example.com/api/v3 (got ${JSON.stringify(process.env.ANNOTAKIT_GH_API)})`);
  }
  return base;
}
function missingTokenMessage(configPath) {
  return [
    "no GitHub token found. Fix with ONE of:",
    '  a) echo "ANNOTAKIT_GH_TOKEN=<your PAT>" >> .env   (dev server auto-loads it)',
    "  b) ANNOTAKIT_GH_TOKEN=<your PAT> bun run storybook  (env var at start)",
    `  c) {"ghToken": "<your PAT>"} in ${configPath}`,
    "then POST /annotakit/api/gh/reload (applies without restart \u2014 v0.6.6) or restart storybook dev.",
    "No token? The review loop still works 100% locally: REST + markdown digests on this server (see /annotakit/api/export)."
  ].join("\n");
}
function missingRepoMessage(configPath) {
  return [
    "no GitHub repo configured. Fix with ONE of:",
    "  a) git remote add origin https://github.com/<owner>/<name>.git  (auto-detected)",
    `  b) {"ghRepo":"<owner>/<name>"} in ${configPath}`,
    '  c) echo "ANNOTAKIT_GH_REPO=<owner>/<name>" >> .env',
    "then RESTART storybook dev (repo detection runs once at boot)."
  ].join("\n");
}
function invalidTokenMessage(detail) {
  return [
    `GitHub rejected the token (401: ${detail.slice(0, 160)}). Fix:`,
    "  a) regenerate the PAT at github.com/settings/tokens (classic: repo scope for private repos)",
    "  b) update .env \u2192 ANNOTAKIT_GH_TOKEN=<new PAT>",
    "  c) POST /annotakit/api/gh/reload (applies without restart \u2014 v0.6.6) or restart storybook dev.",
    "Until then: local review (threads/digests/resolve) keeps working; GH mirroring is paused."
  ].join("\n");
}
function retryAfterMs(res) {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const n = Number.parseInt(ra, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n * 1e3, 9e5);
  }
  const reset = res.headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n) && n > 0) {
      const waitMs = (n - Math.floor(Date.now() / 1e3)) * 1e3;
      if (waitMs > 0) return Math.min(waitMs, 9e5);
    }
  }
  return void 0;
}
async function ghError(res, method, pathname) {
  const text = await res.text().catch(() => "");
  const retryMs = retryAfterMs(res);
  const isRate = res.status === 429 || res.status === 403 && /rate limit|abuse/i.test(text);
  if (res.status === 401) {
    throw Object.assign(new Error(invalidTokenMessage(text)), { status: 401 });
  }
  if (isRate) {
    throw Object.assign(
      new Error(`GitHub rate-limited ${method} ${pathname}${retryMs ? ` \u2014 retrying in ~${Math.round(retryMs / 1e3)}s` : ""} (${text.slice(0, 160)})`),
      { status: 429, retryMs: retryMs ?? 6e4, transient: true }
    );
  }
  if (res.status === 404) {
    throw Object.assign(new Error(`GitHub 404 on ${method} ${pathname} (${text.slice(0, 160)})`), { status: 404 });
  }
  if (res.status === 422) {
    throw Object.assign(
      new Error(`GitHub rejected the request body (422: ${text.slice(0, 200)}) \u2014 not retried automatically; the offending thread's body needs editing`),
      { status: 422 }
    );
  }
  throw Object.assign(
    new Error(`GitHub API ${res.status} on ${method} ${pathname}: ${text.slice(0, 300)}`),
    { status: 502, transient: true }
  );
}
async function ghJson(token, method, pathname, body) {
  let res;
  try {
    res = await fetch(`${ghApiBase()}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      ...body !== void 0 ? { body: JSON.stringify(body) } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      // one hung request must never wedge the engine
    });
  } catch (err) {
    throw Object.assign(
      new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
      { status: 503, transient: true }
    );
  }
  if (!res.ok) throw await ghError(res, method, pathname);
  if (res.status === 204 || method === "HEAD") return {};
  return await res.json();
}
async function ghJsonPaged(token, pathname, maxPages = 10) {
  const out = [];
  let url = `${ghApiBase()}${pathname}`;
  let res = null;
  let truncated = false;
  for (let page = 0; page < maxPages && url; page++) {
    if (page === maxPages - 1) {
      truncated = true;
    }
    try {
      res = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
    } catch (err) {
      throw Object.assign(
        new Error(`GitHub unreachable (${pathname}): ${err instanceof Error ? err.message : String(err)}`),
        { status: 503, transient: true }
      );
    }
    if (!res.ok) throw await ghError(res, "GET", pathname);
    const data = await res.json();
    out.push(...data);
    const link = res.headers.get("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    if (!next) {
      url = null;
      truncated = false;
    } else {
      try {
        url = new URL(next[1]).origin === new URL(ghApiBase()).origin ? next[1] : null;
        if (!url) truncated = true;
      } catch {
        url = null;
        truncated = true;
      }
    }
  }
  if (truncated) {
    console.warn(
      truncated && url ? `[storybook-annotakit] \u26A0 GitHub pagination cap hit (${maxPages} pages) on ${pathname} \u2014 results truncated; raise the cap if this repo really has more data` : `[storybook-annotakit] \u26A0 GitHub pagination stopped early on ${pathname} (cross-origin/malformed next link) \u2014 results truncated`
    );
  }
  return out;
}
function createIssue(token, repo, input) {
  return ghJson(token, "POST", `/repos/${repo}/issues`, {
    title: input.title,
    body: input.body,
    labels: input.labels ?? ["annotakit"]
  });
}
function addIssueComment(token, repo, issue, body) {
  return ghJson(token, "POST", `/repos/${repo}/issues/${issue}/comments`, { body });
}
function setIssueState(token, repo, issue, state) {
  return ghJson(token, "PATCH", `/repos/${repo}/issues/${issue}`, { state });
}
function editIssue(token, repo, issue, fields) {
  return ghJson(token, "PATCH", `/repos/${repo}/issues/${issue}`, fields);
}
function getIssue(token, repo, issue) {
  return ghJson(token, "GET", `/repos/${repo}/issues/${issue}`);
}
function listLabeledIssues(token, repo, label = "annotakit") {
  const labels = Array.isArray(label) ? label.join(",") : label;
  return ghJsonPaged(
    token,
    `/repos/${repo}/issues?labels=${encodeURIComponent(labels)}&state=all&per_page=100&sort=updated&direction=desc`,
    10
  );
}
function listIssueComments(token, repo, issue, since) {
  const q = since ? `?per_page=100&since=${encodeURIComponent(since)}` : "?per_page=100";
  return ghJsonPaged(token, `/repos/${repo}/issues/${issue}/comments${q}`, 10);
}

// src/shared/legacyMirror.ts
function fmtDate2(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").slice(5, 16);
}
function oneLine2(body) {
  return body.replace(/\s+/g, " ").trim();
}
function clip200(body) {
  const line = oneLine2(body);
  return line.length > 200 ? line.slice(0, 200) + "\u2026" : line;
}
function mirrorBodyCommentsOf(t) {
  const stamped = t.comments.filter((c) => c.ghId === "issue-body");
  if (stamped.length) return stamped;
  return t.comments.filter((c) => !c.ghId && c.source !== "github");
}
function dateNorm(body) {
  return body.replace(/· \d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "\xB7 <date>");
}
function legacyMirrorTitle(t) {
  const storyLabel = t.story?.name ?? t.story?.title ?? t.storyId;
  const headline = (t.comments[0]?.body ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `[review] ${storyLabel} \u2014 #${t.number} ${headline || "(no text)"}`.slice(0, 100);
}
function legacyThreadBlock(t, comments, o) {
  const rel = o.relPath ?? ((p) => p);
  const first = comments[0];
  const headline = first ? (o.variant === "B" ? clip200(first.body) : oneLine2(first.body)) || "(no text)" : "(no text)";
  const status = o.status === "open" ? "OPEN" : "resolved";
  const out = [];
  out.push(`### #${t.number} ${status} \u2014 ${headline}`);
  out.push("");
  if (t.story) {
    if (t.story.importPath) out.push(`- story: ${t.story.title ?? ""}/${t.story.name ?? ""} (${rel(t.story.importPath)})`);
  }
  out.push(`- thread id: ${t.id}`);
  if (o.storageNote) out.push(`- storage: ${o.storageNote}`);
  const comp = t.component;
  if (comp) {
    if (comp.name) out.push(`- component: ${comp.name}${comp.key ? ` (key="${comp.key}")` : ""}`);
    if (comp.source) out.push(`- jsx: ${rel(comp.source.file)}:${comp.source.line ?? "?"}`);
    if (comp.chain?.length > 1) out.push(`- chain: ${comp.chain.slice(0, 5).join(" > ")}`);
    const props = comp.props ? Object.entries(comp.props).slice(0, 6) : [];
    if (props.length) out.push(`- props: ${props.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  const ctx = t.target?.context;
  out.push(`- element: ${ctx ? elementSummary(ctx) : "?"}`);
  if (t.target?.selector?.cssSelector) out.push(`- selector: ${t.target.selector.cssSelector}`);
  for (const r of comments.slice(1)) {
    const via = o.variant === "B" && r.source === "github" ? " (via github)" : "";
    const body = o.variant === "B" ? clip200(r.body) : oneLine2(r.body).slice(0, 200);
    out.push(`  - ${r.author}${via} ${fmtDate2(r.createdAt)}: ${body}`);
  }
  if (o.status === "resolved" && t.resolvedAt) out.push(`  - resolved ${fmtDate2(t.resolvedAt)}`);
  out.push("");
  return out;
}
var LEGACY_SERVER_FOOTER = "Agent loop: fix the code at the `jsx:`/`component file:` paths, comment with fix evidence, then resolve the thread \u2014 close this issue (the Storybook review thread mirrors it automatically). Note: `jsx: file:line` points at the component definition (may be a few lines off); the `element:`/`selector:` lines pinpoint the exact pinned node.";
function legacyServerBodyCandidates(t, opts) {
  const comments = mirrorBodyCommentsOf(t);
  if (!comments.length) return [];
  const st = { ...t.story, url: t.story?.url ?? `${opts.origin}/?path=/story/${t.storyId}` };
  const candidates = [];
  for (const status of ["open", "resolved"]) {
    const open = status === "open" ? 1 : 0;
    const resolved = status === "open" ? 0 : 1;
    for (const variant of ["A", "B"]) {
      const out = [];
      out.push(`# UI review \u2014 ${st.title ?? st.storyId}`);
      out.push("");
      out.push(`${open} open / ${resolved} resolved \xB7 ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ")}`);
      out.push(`storybook: ${opts.origin}`);
      out.push("");
      const storyTitle = variant === "B" ? [st.title ?? st.storyId, st.name].filter(Boolean).join(" / ") : `${st.title ?? st.storyId} / ${st.name ?? ""}`;
      out.push(`## ${storyTitle}`);
      out.push("");
      out.push(`story id: \`${st.storyId}\``);
      if (st.importPath) out.push(`story file: ${opts.relPath(st.importPath)}`);
      if (st.componentPath) out.push(`component file: ${opts.relPath(st.componentPath)}`);
      out.push(`open: ${st.url}`);
      out.push("");
      if (status === "open") {
        out.push(...legacyThreadBlock(t, comments, { variant, relPath: opts.relPath, status }));
      } else {
        out.push(`<details><summary>1 resolved</summary>`);
        out.push("");
        out.push(...legacyThreadBlock(t, comments, { variant, relPath: opts.relPath, status }));
        out.push(`</details>`);
        out.push("");
      }
      out.push("---");
      out.push("");
      out.push(LEGACY_SERVER_FOOTER);
      out.push("");
      candidates.push(out.join("\n"));
    }
  }
  return candidates;
}
function decideMirrorHeal(args) {
  const fields = {};
  if (typeof args.remote.title === "string" && args.remote.title) {
    if (args.remote.title === args.legacyTitle && args.wantedTitle !== args.remote.title) {
      fields.title = args.wantedTitle;
    }
  }
  if (typeof args.remote.body === "string" && args.remote.body) {
    const machineWritten = args.remote.body.includes(`- thread id: ${args.threadId}`) && !args.remote.body.includes(MIRROR_VERBATIM_MARKER) && !args.remote.body.includes("\u2026 (clipped at ");
    if (machineWritten && args.wantedBody !== args.remote.body && args.legacyBodies.some((c) => dateNorm(c) === dateNorm(args.remote.body))) {
      fields.body = args.wantedBody;
    } else if (machineWritten && typeof process !== "undefined" && process.env?.ANNOTAKIT_HEAL_DEBUG) {
      const remote = dateNorm(args.remote.body);
      for (const c of args.legacyBodies) {
        const want = dateNorm(c).split("\n");
        const got = remote.split("\n");
        let li = 0;
        while (li < Math.max(want.length, got.length) && want[li] === got[li]) li++;
        console.error(`[heal-debug] no match vs candidate: first diff line ${li}
  want: ${JSON.stringify(want[li])}
  got:  ${JSON.stringify(got[li])}`);
      }
    }
  }
  return Object.keys(fields).length ? fields : null;
}
`n_${Math.random().toString(36).slice(2, 10)}`;
function ghMappingRepo(ref) {
  if (!ref) return null;
  if (typeof ref.repo === "string" && ref.repo) return ref.repo;
  if (typeof ref.url === "string" && ref.url) {
    try {
      const segs = new URL(ref.url).pathname.split("/").filter(Boolean);
      const owner = segs[segs.length - 4];
      const name = segs[segs.length - 3];
      if (segs[segs.length - 2] === "issues" && /^[A-Za-z0-9_.-]+$/.test(owner ?? "") && /^[A-Za-z0-9_.-]+$/.test(name ?? "")) {
        return `${owner}/${name}`;
      }
    } catch {
    }
  }
  return null;
}

// src/server/ghsync.ts
var RETRY_LIMIT = 4;
var RETRY_MAX_DELAY_MS = 3e4;
var STALLED_SWEEP_MS = 10 * 6e4;
var PULL_401_BACKOFF_MS2 = 5 * 6e4;
var SKEW_REPAIR_MS2 = 5 * 6e4;
function createGhSync(opts) {
  const { store, repo, token, configPath } = opts;
  const intervalMs = opts.intervalMs ?? 700;
  const labelsOf = opts.labels ?? (() => ["dom-annotakit"]);
  const queue = [];
  const queued = /* @__PURE__ */ new Set();
  const inflight = /* @__PURE__ */ new Set();
  const touchedDuringFlight = /* @__PURE__ */ new Set();
  const retries = /* @__PURE__ */ new Map();
  const notBefore = /* @__PURE__ */ new Map();
  let started = false;
  let workerTimer = null;
  let pollTimer = null;
  let chain = Promise.resolve();
  let lastPushAt = null;
  let lastPullAt = null;
  let lastError = null;
  let backoffUntil = 0;
  let tokenState = token() ? "unexercised" : "missing";
  let lastAuthError = null;
  let lastTokenSeen = token();
  const noteAuthFailure = (err) => {
    if (err?.status === 401) {
      tokenState = "rejected";
      lastAuthError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }
  };
  const noteTokenRotation = () => {
    const tk = token();
    if (tk !== lastTokenSeen) {
      const wasRejected = tokenState === "rejected";
      lastTokenSeen = tk;
      if (tk) {
        if (tokenState === "rejected" || tokenState === "missing") tokenState = "unexercised";
      } else {
        tokenState = "missing";
        lastAuthError = null;
      }
      if (wasRejected) backoffUntil = 0;
    }
  };
  let lastStalledSweep = Date.now();
  const parkedTombstoneWarned = /* @__PURE__ */ new Set();
  const configured = () => {
    const t = token();
    if (!t) return { error: missingTokenMessage(configPath) };
    if (!repo) return { error: missingRepoMessage(configPath) };
    return { token: t, repo };
  };
  function run(fn) {
    const exec = () => fn();
    const p = chain.then(exec, exec);
    chain = p.catch(() => void 0);
    return p;
  }
  const failTask = (id, err) => {
    const e = err;
    const n = (retries.get(id) ?? 0) + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
    noteAuthFailure(err);
    if (n <= RETRY_LIMIT && (e.status ?? 0) !== 401 && (e.status ?? 0) !== 404 && (e.status ?? 0) !== 422) {
      retries.set(id, n);
      notBefore.set(id, Date.now() + Math.min(intervalMs * 2 ** (n - 1), RETRY_MAX_DELAY_MS));
      queue.push(id);
      queued.add(id);
      return;
    }
    retries.delete(id);
    notBefore.delete(id);
    lastError = `thread ${id.slice(0, 12)}\u2026 sync failed after ${n} tries: ${message.slice(0, 300)}`;
    console.warn(`[storybook-annotakit] gh-sync: ${lastError}`);
  };
  function issueTitle(t) {
    const storyLabel = metaLine(t.story?.name ?? t.story?.title ?? t.storyId, 120);
    const headline = metaLine(t.comments[0]?.body ?? "", 100);
    return `[review] ${storyLabel} \u2014 #${t.number} ${headline || "(no text)"}`.slice(0, 160);
  }
  function issueBody(t) {
    const origin = opts.origin();
    const storyUrl = t.story?.url ?? `${origin}/?path=/story/${t.storyId}`;
    const body = renderDigest(
      // v0.6.15 (55-c P3-4, the THIRD counts builder): unknown → open (the
      // H-B-15 count twin — a mirror issue body must not say "0 open / 0
      // resolved" while its own thread block renders the thread OPEN)
      [{ story: { ...t.story, url: storyUrl }, counts: { open: t.status !== "fixed" && t.status !== "rejected" && t.status !== "resolved" ? 1 : 0, fixed: t.status === "fixed" ? 1 : 0, rejected: t.status === "rejected" ? 1 : 0, resolved: t.status === "resolved" ? 1 : 0 }, threads: [t] }],
      { origin, mirror: true, fullText: true }
    );
    if (body.length > ISSUE_BODY_LIMIT) {
      return body.slice(0, ISSUE_BODY_LIMIT) + `

\u2026 (clipped at ${ISSUE_BODY_LIMIT} chars \u2014 GitHub caps issue bodies at 65,536; full thread: GET ${origin}/annotakit/api/threads/${encodeURIComponent(t.id)})`;
    }
    return body;
  }
  const SENTINEL_RE = /<!--\s*annotakit:c_(\S+?)\s*-->/;
  const mirrorBody = (c) => `**${metaLine(c.author, 60)}:** ${c.body}
<!-- annotakit:c_${metaLine(c.id)} -->`;
  const parseSentinel = (body) => {
    const m = body.match(SENTINEL_RE);
    return m ? m[1] : null;
  };
  function mirrorHealFields(t, remote) {
    return decideMirrorHeal({
      threadId: t.id,
      remote,
      wantedTitle: issueTitle(t),
      wantedBody: issueBody(t),
      legacyTitle: legacyMirrorTitle(t),
      legacyBodies: legacyServerBodyCandidates(t, { origin: opts.origin(), relPath: (p) => repoRelPath(p) ?? p })
    });
  }
  function orphanIndexOf(issues, threads) {
    const cfgNow = configured();
    const activeRepo = cfgNow.error ? null : cfgNow.repo;
    const mapped = new Set(
      threads.filter((t) => t.gh && (activeRepo === null || !isDetached(t.gh, activeRepo))).map((t) => t.gh?.issue)
    );
    const unmappedById = new Map(threads.filter((t) => !t.gh).map((t) => [t.id, t]));
    const out = /* @__PURE__ */ new Map();
    for (const issue of issues) {
      if (mapped.has(issue.number)) continue;
      if (typeof issue.body !== "string" || !issue.body) continue;
      const stamp = issue.body.match(/^- thread id: (.+)$/m);
      if (!stamp) continue;
      const victim = unmappedById.get(stamp[1].trim());
      if (victim && !out.has(victim.id)) out.set(victim.id, issue);
    }
    return out;
  }
  function isDetached(ref, activeRepo) {
    const r = ghMappingRepo(ref);
    return r !== null && r !== activeRepo;
  }
  async function verifyMappingRepo(id, t, rp, body) {
    const m = body !== null ? body.match(/^- thread id: (.+)$/m) : null;
    if (m?.[1]?.trim() !== t.id) return false;
    const after = await store.mutateThread(id, (cur) => {
      if (cur.gh && !cur.gh.repo) cur.gh.repo = rp;
    });
    if (after) opts.onEngineMutation(after, "updated");
    return true;
  }
  let warnedDetached = false;
  async function syncThread(id, orphanIndex) {
    const cfg = configured();
    if (cfg.error) throw Object.assign(new Error(cfg.error), { status: 400 });
    const t = await store.getThread(id);
    if (!t) return "noop";
    const { token: tk, repo: rp } = cfg;
    if (t.gh) {
      const mapRepo = ghMappingRepo(t.gh);
      if (mapRepo === null) {
        let body = null;
        try {
          const issue = await getIssue(tk, rp, t.gh.issue);
          body = typeof issue.body === "string" ? issue.body : null;
        } catch {
          body = null;
        }
        if (!await verifyMappingRepo(id, t, rp, body)) {
          console.warn(`[storybook-annotakit] gh-sync: issue #${t.gh.issue} (thread ${id.slice(0, 12)}\u2026) is not this thread's mirror on ${rp} \u2014 mapping DETACHED, push skipped (restore the repo config or unlink the thread to re-mirror)`);
          return "noop";
        }
      } else if (mapRepo !== rp) {
        if (!warnedDetached) {
          warnedDetached = true;
          console.warn(`[storybook-annotakit] gh-sync: mappings exist for issues on ${mapRepo} but the mirror targets ${rp} \u2014 those threads are DETACHED (frozen, not synced); restore the repo config or unlink them to re-mirror`);
        }
        return "noop";
      }
    }
    if (!t.gh) {
      let orphan = orphanIndex?.get(id);
      if (!orphan && orphanIndex === void 0) {
        try {
          orphan = orphanIndexOf(await listLabeledIssues(tk, rp, labelsOf()), [t]).get(id);
        } catch {
        }
      }
      if (orphan) {
        const adopted = await store.mutateThread(id, (cur) => {
          if (cur.gh) return;
          cur.gh = { issue: orphan.number, url: orphan.html_url, repo: rp, state: orphan.state, syncedAt: orphan.updated_at ?? nowIso() };
          delete cur.ghUnlinkedAt;
          adoptOrphanState(cur, orphan);
        });
        if (adopted) {
          opts.onEngineMutation(adopted, "updated");
          lastPushAt = nowIso();
          enqueue(adopted.id);
          console.warn(`[storybook-annotakit] gh-sync: adopted orphaned mirror issue #${orphan.number} for thread ${id.slice(0, 12)}\u2026 (create-crash recovery)`);
          return "pushed";
        }
        if ((await store.getThread(id))?.gh) return "pushed";
      }
      const created = await createIssue(tk, rp, { title: issueTitle(t), body: issueBody(t), labels: labelsOf() });
      const still = await store.mutateThread(id, (cur) => {
        if (cur.gh) return;
        cur.gh = { issue: created.number, url: created.html_url, repo: rp, state: "open", syncedAt: created.updated_at ?? nowIso() };
        delete cur.ghUnlinkedAt;
        for (const c of cur.comments) {
          if (!c.ghId && c.source !== "github") c.ghId = "issue-body";
        }
      });
      if (!still || still.gh?.issue !== created.number) {
        await addIssueComment(tk, rp, created.number, `${GH_SENTINEL}
thread deleted in Storybook \u2014 closing.`);
        await setIssueState(tk, rp, created.number, "closed");
        return "created";
      }
      let after = still;
      if (still.status === "resolved") {
        await addIssueComment(tk, rp, created.number, resolutionNotice(still));
        await setIssueState(tk, rp, created.number, "closed");
        after = await store.mutateThread(id, (cur) => {
          if (cur.gh) cur.gh.state = "closed";
        });
      }
      if (after) opts.onEngineMutation(after, "updated");
      lastPushAt = nowIso();
      return "created";
    }
    let pushed = 0;
    let remoteStamp;
    for (const c of t.comments) {
      if (c.ghId || c.source === "github") continue;
      const gh = await addIssueComment(tk, rp, t.gh.issue, mirrorBody(c));
      remoteStamp = gh.updated_at ?? gh.created_at ?? remoteStamp;
      const after = await store.mutateThread(id, (cur) => {
        const target = cur.comments.find((x) => x.id === c.id);
        if (target && !target.ghId) target.ghId = String(gh.id);
      });
      if (after) opts.onEngineMutation(after, "updated");
      pushed++;
    }
    const want = mirrorStateOf(t.status);
    if (t.gh.state !== want) {
      await addIssueComment(tk, rp, t.gh.issue, want === "closed" ? resolutionNotice(t) : reopenNotice(t));
      const flipped = await setIssueState(tk, rp, t.gh.issue, want);
      remoteStamp = flipped.updated_at ?? remoteStamp;
      const after = await store.mutateThread(id, (cur) => {
        if (cur.gh) {
          cur.gh.state = want;
          cur.gh.syncedAt = flipped.updated_at ?? nowIso();
        }
      });
      if (after) opts.onEngineMutation(after, "updated");
      pushed++;
    } else if (pushed > 0) {
      const after = await store.mutateThread(id, (cur) => {
        if (cur.gh) cur.gh.syncedAt = remoteStamp ?? nowIso();
      });
      if (after) opts.onEngineMutation(after, "updated");
    }
    if (pushed > 0) lastPushAt = nowIso();
    return pushed > 0 ? "pushed" : "noop";
  }
  function resolutionNotice(t) {
    const who = t.comments[t.comments.length - 1]?.author ?? t.author;
    return `${GH_SENTINEL}
resolved in Storybook \u2014 thread #${t.number} (by ${who}${t.resolvedAt ? `, ${t.resolvedAt.slice(0, 16).replace("T", " ")}` : ""}). Fix evidence is in the replies above.`;
  }
  function reopenNotice(t) {
    return `${GH_SENTINEL}
reopened in Storybook \u2014 thread #${t.number}.`;
  }
  async function drainQueue() {
    if (Date.now() < backoffUntil) return;
    let hadFailure = false;
    let guard = 0;
    while (queue.length && guard++ < 1e4) {
      if (Date.now() < backoffUntil) {
        queue.unshift();
        break;
      }
      const id = queue.shift();
      const nb = notBefore.get(id);
      if (nb && Date.now() < nb) {
        queue.push(id);
        if (queue.every((q) => {
          const n = notBefore.get(q);
          return n !== void 0 && Date.now() < n;
        })) break;
        continue;
      }
      queued.delete(id);
      inflight.add(id);
      try {
        await syncThread(id);
        retries.delete(id);
        notBefore.delete(id);
        if (touchedDuringFlight.delete(id)) {
          queued.add(id);
          queue.push(id);
        }
      } catch (err) {
        hadFailure = true;
        failTask(id, err);
        touchedDuringFlight.delete(id);
      } finally {
        inflight.delete(id);
      }
    }
    if (!hadFailure && queue.length === 0 && Date.now() >= backoffUntil) lastError = null;
  }
  const tick = () => {
    if (queue.length === 0 || Date.now() < backoffUntil) return;
    void run(() => drainQueue()).catch(() => void 0);
  };
  function systemComment(t, ghId, author, body) {
    if (t.comments.some((c) => c.ghId === ghId)) return;
    t.comments.push({ id: newId().replace(/^th_/, "c_"), author, body, createdAt: nowIso(), ghId, source: "github" });
  }
  function adoptOrphanState(cur, issue) {
    if (String(issue.state) === "closed" && cur.status !== "resolved") {
      cur.status = "resolved";
      cur.resolvedAt = issue.closed_at ?? nowIso();
      delete cur.reopenedAt;
      systemComment(cur, `gh-close-${issue.number}`, issue.closed_by?.login ?? "github", "closed on GitHub");
    }
  }
  async function stalledThreads() {
    if (!opts.enabled || configured().error) return [];
    const threads = await store.listThreads();
    const cfgNow = configured();
    const activeRepo = cfgNow.error ? null : cfgNow.repo;
    return threads.filter((t) => {
      if (queued.has(t.id) || inflight.has(t.id)) return false;
      if (t.gh && activeRepo !== null && isDetached(t.gh, activeRepo)) return false;
      const unmirrored = t.comments.some((c) => !c.ghId && c.source !== "github");
      const stateDrift = t.gh ? t.gh.state !== mirrorStateOf(t.status) : true;
      return unmirrored || stateDrift;
    });
  }
  const pullOnceRaw = async () => {
    const cfg = configured();
    if (cfg.error) return { pulled: 0, closedTombstones: 0, healed: 0 };
    if (Date.now() < backoffUntil) return { pulled: 0, closedTombstones: 0, healed: 0 };
    const { token: tk, repo: rp } = cfg;
    const pullStartedAt = nowIso();
    let pulled = 0;
    let closedTombstones = 0;
    let healed = 0;
    let pullHadError = false;
    const threads = await store.listThreads();
    const remote = new Map((await listLabeledIssues(tk, rp, labelsOf())).map((i) => [i.number, i]));
    for (const t of threads) {
      if (!t.gh) continue;
      if (queued.has(t.id) || inflight.has(t.id)) continue;
      const mir = t.gh;
      {
        const mapRepo = ghMappingRepo(mir);
        if (mapRepo === null) {
          const listed = remote.get(mir.issue);
          let body = listed && typeof listed.body === "string" ? listed.body : null;
          if (body === null) {
            try {
              const got = await getIssue(tk, rp, mir.issue);
              body = typeof got.body === "string" ? got.body : null;
            } catch {
              body = null;
            }
          }
          if (!await verifyMappingRepo(t.id, t, rp, body)) {
            continue;
          }
        } else if (mapRepo !== rp) {
          continue;
        }
      }
      let issue = remote.get(mir.issue);
      if (!issue) {
        try {
          issue = await getIssue(tk, rp, mir.issue);
        } catch (err) {
          if (err?.status === 404) {
            const after = await store.mutateThread(t.id, (cur) => {
              delete cur.gh;
              cur.ghUnlinkedAt = nowIso();
              const noteId = `gh-deleted-${mir.issue}`;
              if (!cur.comments.some((c) => c.ghId === noteId)) {
                cur.comments.push({
                  id: newId().replace(/^th_/, "c_"),
                  author: "annotakit",
                  body: "GitHub issue deleted remotely \u2014 the mirror will be re-created on the next sync.",
                  createdAt: nowIso(),
                  ghId: noteId,
                  source: "local"
                });
              }
            });
            if (after) {
              opts.onEngineMutation(after, "updated");
              pulled++;
              enqueue(after.id);
            }
            continue;
          }
          throw err;
        }
      }
      try {
        const heal = mirrorHealFields(t, issue);
        if (heal) {
          await editIssue(tk, rp, mir.issue, heal);
          healed++;
          console.warn(
            `[storybook-annotakit] gh-sync: healed mirror issue #${mir.issue} (${[
              heal.title ? "full title" : null,
              heal.body ? "verbatim body" : null
            ].filter(Boolean).join(" + ")}) \u2014 pre-v0.6.3 clip (issue #16)`
          );
        }
      } catch (err) {
        console.warn(
          `[storybook-annotakit] gh-sync: mirror heal failed (issue #${mir.issue}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      let statusChange = null;
      if (issue.state === "closed" && t.status !== "resolved") statusChange = "resolved";
      else if (issue.state === "open" && t.status === "resolved") statusChange = "reopen";
      const since = mir.syncedAt;
      const futureStamp = Boolean(since) && Date.parse(String(since)) > Date.now() + SKEW_REPAIR_MS2;
      const issueActive = futureStamp || !since || !issue.updated_at || issue.updated_at > since;
      let fresh = [];
      if (issueActive) {
        const ghComments = await listIssueComments(tk, rp, mir.issue, futureStamp ? void 0 : since);
        const known = new Set(t.comments.map((c) => c.ghId).filter((x) => Boolean(x)));
        let malformed = 0;
        for (const c of ghComments) {
          if (typeof c?.body !== "string" || c.created_at !== void 0 && typeof c.created_at !== "string") {
            malformed++;
            continue;
          }
          if (!known.has(String(c.id)) && !String(c.body ?? "").trimStart().startsWith(GH_SENTINEL)) fresh.push(c);
        }
        if (malformed > 0) {
          console.warn(`[storybook-annotakit] pull: skipped ${malformed} malformed remote comment(s) on issue #${mir.issue} (non-string body/created_at) \u2014 treated as untrusted input, not imported`);
        }
        fresh.sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
      }
      if (statusChange || fresh.length > 0 || mir.state !== issue.state || issueActive) {
        let reason = null;
        if (statusChange) reason = statusChange === "resolved" ? "resolved" : "reopened";
        else if (fresh.length > 0) reason = "commented";
        const after = await store.mutateThread(t.id, (cur) => {
          if (statusChange === "resolved" && cur.status !== "resolved") {
            cur.status = "resolved";
            cur.resolvedAt = issue.closed_at ?? nowIso();
            systemComment(cur, `gh-close-${mir.issue}`, issue.closed_by?.login ?? "github", "closed on GitHub");
          } else if (statusChange === "reopen" && cur.status === "resolved") {
            cur.status = "open";
            delete cur.resolvedAt;
            cur.reopenedAt = nowIso();
            systemComment(cur, `gh-reopen-${mir.issue}`, "github", "reopened on GitHub");
          }
          if (cur.status === "resolved") delete cur.reopenedAt;
          const knownNow = new Set(cur.comments.map((c) => c.ghId).filter((x) => Boolean(x)));
          for (const c of fresh) {
            if (knownNow.has(String(c.id))) continue;
            const localId = parseSentinel(c.body);
            const target = localId ? cur.comments.find((x) => x.id === localId && !x.ghId) : void 0;
            if (target) {
              target.ghId = String(c.id);
              continue;
            }
            cur.comments.push({
              id: newId().replace(/^th_/, "c_"),
              author: c.user?.login ?? "github",
              body: c.body.replace(SENTINEL_RE, "").trimEnd(),
              createdAt: typeof c.created_at === "string" && c.created_at ? c.created_at : nowIso(),
              ghId: String(c.id),
              source: "github"
            });
          }
          if (cur.gh) {
            cur.gh.state = issue.state;
            if (issueActive) cur.gh.syncedAt = issue.updated_at ?? pullStartedAt;
          }
        });
        if (after && reason) {
          opts.onEngineMutation(after, reason);
          pulled++;
        } else if (after && (statusChange || fresh.length > 0)) {
          pulled++;
        }
      }
    }
    const mappedIssues = new Set(threads.filter((t) => t.gh && !isDetached(t.gh, rp)).map((t) => t.gh?.issue));
    const unmappedById = new Map(threads.filter((t) => !t.gh).map((t) => [t.id, t]));
    for (const issue of remote.values()) {
      if (mappedIssues.has(issue.number)) continue;
      if (typeof issue.body !== "string" || !issue.body) continue;
      const stamp = issue.body.match(/^- thread id: (.+)$/m);
      if (!stamp) continue;
      const victim = unmappedById.get(stamp[1].trim());
      if (!victim || queued.has(victim.id) || inflight.has(victim.id)) continue;
      const after = await store.mutateThread(victim.id, (cur) => {
        if (cur.gh) return;
        cur.gh = { issue: issue.number, url: issue.html_url, repo: rp, state: issue.state, syncedAt: issue.updated_at ?? pullStartedAt };
        delete cur.ghUnlinkedAt;
        adoptOrphanState(cur, issue);
      });
      if (after) {
        opts.onEngineMutation(after, "updated");
        healed++;
        enqueue(after.id);
        console.warn(
          `[storybook-annotakit] gh-sync: remapped orphaned mirror issue #${issue.number} to thread ${victim.id.slice(0, 12)}\u2026 (create-crash recovery)`
        );
      }
    }
    const deletedIds = await store.listDeletedIds();
    for (const ts of await store.listOpenTombstones()) {
      const issueNumber = ts.issue;
      try {
        if (ts.repo && ts.repo !== rp) {
          if (!parkedTombstoneWarned.has(issueNumber)) {
            parkedTombstoneWarned.add(issueNumber);
            console.warn(`[storybook-annotakit] gh-sync: close of issue #${issueNumber} PARKED \u2014 it lives on ${ts.repo}, the mirror now targets ${rp} (restoring the repo setting will land this close on the original issue)`);
          }
          continue;
        }
        let target = null;
        try {
          target = await getIssue(tk, rp, issueNumber);
        } catch (err) {
          if (err?.status === 404) {
            await store.tombstoneDone(issueNumber);
            closedTombstones++;
            continue;
          }
          throw err;
        }
        const m = typeof target.body === "string" ? target.body.match(/^- thread id: (.+)$/m) : null;
        const bodyStamp = m?.[1]?.trim() ?? null;
        if (bodyStamp === null || !deletedIds.has(bodyStamp)) {
          console.warn(`[storybook-annotakit] gh-sync: tombstone close of issue #${issueNumber} SKIPPED \u2014 ${bodyStamp === null ? "its body carries no thread-id stamp (not ours?)" : `its body stamp (${bodyStamp.slice(0, 24)}\u2026) is not one of our deleted threads`} on ${rp}`);
          await store.tombstoneDone(issueNumber);
          continue;
        }
        if (target.state !== "closed") {
          await addIssueComment(tk, rp, issueNumber, `${GH_SENTINEL}
thread deleted in Storybook \u2014 closing.`);
          await setIssueState(tk, rp, issueNumber, "closed");
        }
        await store.tombstoneDone(issueNumber);
        closedTombstones++;
      } catch (err) {
        lastError = `tombstone close failed (issue #${issueNumber}): ${err instanceof Error ? err.message : String(err)}`;
        pullHadError = true;
      }
    }
    if (Date.now() - lastStalledSweep > STALLED_SWEEP_MS) {
      lastStalledSweep = Date.now();
      for (const t of await stalledThreads()) enqueue(t.id);
    }
    if (!pullHadError) lastError = null;
    lastPullAt = nowIso();
    return { pulled, closedTombstones, healed };
  };
  const enqueue = (threadId) => {
    if (!opts.enabled) return;
    if (!token() || !repo) return;
    if (inflight.has(threadId)) {
      touchedDuringFlight.add(threadId);
      return;
    }
    if (queued.has(threadId)) return;
    queued.add(threadId);
    queue.push(threadId);
  };
  const enqueueDelete = (issue, tombRepo, threadId) => {
    void store.tombstone(issue, tombRepo, threadId).then(() => {
      if (opts.enabled && token() && repo) {
        void run(pullOnceRaw).catch((err) => {
          const e = err;
          if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
          noteAuthFailure(err);
          lastError = err instanceof Error ? err.message : String(err);
        });
      }
    });
  };
  const syncAllRaw = async () => {
    await drainQueue();
    const threadsNow = await store.listThreads();
    let orphanIndex;
    if (threadsNow.some((t) => !t.gh)) {
      try {
        const cfg0 = configured();
        if (!cfg0.error) {
          const { token: tk0, repo: rp0 } = cfg0;
          orphanIndex = orphanIndexOf(await listLabeledIssues(tk0, rp0, labelsOf()), threadsNow);
        }
      } catch {
      }
    }
    let created = 0;
    let pushed = 0;
    let pushError = null;
    if (Date.now() >= backoffUntil) {
      for (const t of threadsNow) {
        if (Date.now() < backoffUntil) break;
        try {
          const r = await syncThread(t.id, orphanIndex);
          if (r === "created") created++;
          if (r === "pushed") pushed++;
        } catch (err) {
          pushError = err instanceof Error ? err.message : String(err);
          const e = err;
          if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
        }
      }
    }
    let pulled = 0;
    let closedTombstones = 0;
    let healed = 0;
    try {
      const r = await pullOnceRaw();
      pulled = r.pulled;
      closedTombstones = r.closedTombstones;
      healed = r.healed;
      if (tokenState === "unexercised") tokenState = "ok";
    } catch (err) {
      const e = err;
      if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
      noteAuthFailure(err);
      if (e.status === 401) backoffUntil = Math.max(backoffUntil, Date.now() + PULL_401_BACKOFF_MS2);
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (pushError) lastError = pushError;
    const stalled = (await stalledThreads()).length;
    return { ok: true, created, pushed, pulled, healed, closedTombstones, issuesTotal: created + threadsNow.filter((t) => t.gh).length, stalled, backoffActive: Date.now() < backoffUntil, lastError: lastError || void 0 };
  };
  const syncAll = async () => {
    const cfg = configured();
    const threads = await store.listThreads();
    const issuesTotal = threads.filter((t) => t.gh).length;
    if (cfg.error) {
      return { ok: true, noop: true, reason: cfg.error, created: 0, pushed: 0, pulled: 0, healed: 0, closedTombstones: 0, issuesTotal };
    }
    return run(syncAllRaw);
  };
  const status = async () => {
    noteTokenRotation();
    const list = await store.listThreads();
    const cfg = configured();
    const mode = !opts.enabled ? "off" : cfg.error ? "unconfigured" : "auto";
    const note = mode === "off" ? "auto-sync disabled (ghAuto:false / ANNOTAKIT_GH_AUTO=0) \u2014 POST /sync still reconciles on demand (when configured)" : mode === "unconfigured" ? `local mode \u2014 reviews work fully on this server (REST + digests); to add the GitHub mirror: ${cfg.error ?? ""}` : `1:1 issue mirror active \u2014 push on every mutation, pull every ${opts.pollSec}s (POST /sync = force reconcile, never duplicates)`;
    const stalled = (await stalledThreads()).length;
    const activeRepoForDetach = cfg.error ? null : cfg.repo;
    const detached = mode === "auto" && activeRepoForDetach !== null ? list.filter((t) => t.gh && isDetached(t.gh, activeRepoForDetach)).length : 0;
    return {
      enabled: opts.enabled,
      mode,
      labels: labelsOf(),
      mapped: list.filter((t) => t.gh).length,
      detached,
      threads: list.length,
      pending: queue.length + inflight.size,
      stalled,
      pollSec: opts.pollSec,
      lastPushAt,
      lastPullAt,
      lastError: Date.now() < backoffUntil ? lastError ?? "rate-limit backoff active" : lastError,
      backoffUntil: backoffUntil && Date.now() < backoffUntil ? new Date(backoffUntil).toISOString() : null,
      // v0.6.6 (F7/SR-C-02): machine-readable auth state + the last 401 —
      // /health consumers can finally tell "rejected" from "unexercised"
      // from "healthy" without string-matching free-text lastError.
      tokenState,
      lastAuthError,
      // dogfood #4: recovery semantics must be observable — when will the
      // periodic sweep retry stalled threads (also: POST /sync, next mutation,
      // restart — the sweep is just the unattended one)
      nextStalledSweepAt: mode === "auto" ? new Date(lastStalledSweep + STALLED_SWEEP_MS).toISOString() : null,
      note
    };
  };
  const start = () => {
    if (started) return;
    started = true;
    if (!opts.enabled) {
      console.warn("[storybook-annotakit] GH mirror: off (auto disabled by config/env) \u2014 local mode; POST /sync reconciles when configured (enable needs a restart)");
      return;
    }
    if (!token() || !repo) {
      console.warn("[storybook-annotakit] GH mirror: unconfigured \u2014 local mode (threads + digests fully work). To mirror to GitHub: set token+repo, then POST /annotakit/api/gh/reload (no restart needed) or restart.");
    }
    workerTimer = setInterval(() => {
      noteTokenRotation();
      tick();
    }, intervalMs);
    workerTimer.unref?.();
    if (opts.pollSec > 0) {
      pollTimer = setInterval(
        () => {
          noteTokenRotation();
          void run(pullOnceRaw).catch((err) => {
            const e = err;
            if (e.retryMs) backoffUntil = Math.max(backoffUntil, Date.now() + e.retryMs);
            noteAuthFailure(err);
            if (e.status === 401) backoffUntil = Math.max(backoffUntil, Date.now() + PULL_401_BACKOFF_MS2);
            lastError = err instanceof Error ? err.message : String(err);
          });
        },
        opts.pollSec * 1e3
      );
      pollTimer.unref?.();
    }
    if (token() && repo) {
      console.warn(
        `[storybook-annotakit] GH mirror: auto \u2014 every thread gets ONE issue; lifecycle (open/fixed/resolved, replies) syncs both ways${opts.pollSec > 0 ? `, pull every ${opts.pollSec}s` : ", pull on POST /sync"}`
      );
      void run(syncAllRaw).catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
      });
    }
  };
  const stop = async () => {
    if (workerTimer) clearInterval(workerTimer);
    if (pollTimer) clearInterval(pollTimer);
    workerTimer = null;
    pollTimer = null;
    started = false;
    try {
      await chain;
    } catch {
    }
  };
  return { enqueue, enqueueDelete, syncAll, pullOnce: () => run(pullOnceRaw), status, start, stop, clearRateLimitBackoff };
  function clearRateLimitBackoff() {
    backoffUntil = 0;
    for (const k of notBefore.keys()) notBefore.delete(k);
  }
}
var DEBOUNCE_MS = 6e3;
var BOOT_MS = Date.now();
var README_MARKER = "annotakit-store: v1";
var README_PROSE = [
  "# annotakit store branch",
  "",
  "Managed by storybook-annotakit \u2014 do not merge into code branches,",
  "do not commit here manually. The tree is exactly README + threads.db",
  "(a sqlite snapshot, WAL-checkpointed). Divergence between machines is",
  "resolved by a logical union merge performed by the addon itself.",
  "",
  "If you are reading this out of curiosity: `git show annotakit:threads.db`",
  "would stream binary; run the Storybook dev server instead and use",
  "GET /annotakit/api/threads.",
  ""
];
var README_CONTENT = [README_MARKER, ...README_PROSE].join("\n");
var LEGACY_README_CONTENTS = [README_PROSE.join("\n"), README_PROSE.join("\n") + "\n"];
var SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
var BRANCH_PRIMARY = "annotakit-dom";
var BRANCH_FALLBACK = "annotakit-dom-store";
var REMOTE_CACHE_REF = "refs/annotakit/remote";
var gitEnvConfigCapable = null;
function gitSupportsEnvConfig() {
  if (gitEnvConfigCapable !== null) return gitEnvConfigCapable;
  const v = __require("child_process").spawnSync("git", ["--version"], { encoding: "utf8", timeout: 5e3 }).stdout ?? "";
  const m = v.match(/git version (\d+)\.(\d+)/);
  gitEnvConfigCapable = Boolean(m && (Number(m[1]) > 2 || Number(m[1]) === 2 && Number(m[2]) >= 31));
  return gitEnvConfigCapable;
}
function gitAuthEnv(token) {
  if (!token) return { args: [] };
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  if (gitSupportsEnvConfig()) {
    return {
      args: [],
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: header
      }
    };
  }
  return { args: ["-c", `http.https://github.com/.extraheader=${header}`] };
}
var COMMIT_ENV = {
  GIT_AUTHOR_NAME: "storybook-annotakit",
  GIT_AUTHOR_EMAIL: "annotakit@users.noreply.github.com",
  GIT_COMMITTER_NAME: "storybook-annotakit",
  GIT_COMMITTER_EMAIL: "annotakit@users.noreply.github.com"
};
function redact(text) {
  return text.replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@").replace(/https:\/\/[^@\s]+@github\.com/g, "https://github.com").replace(/AUTHORIZATION:\s*basic\s+\S+/gi, "AUTHORIZATION: basic ***").replace(/ghp_[A-Za-z0-9]+/g, "ghp_***");
}
function gitAsync(root, args, timeoutMs, opts) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, out: redact(out).slice(0, 300) });
    };
    const child = child_process.spawn("git", ["--no-optional-locks", "-C", root, ...args], {
      stdio: [opts?.stdin === void 0 ? "ignore" : "pipe", "pipe", "pipe"],
      ...opts?.env ? { env: { ...process.env, ...opts.env } } : {}
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    if (opts?.stdin !== void 0 && child.stdin) {
      child.stdin.on("error", () => void 0);
      child.stdin.end(opts.stdin);
    }
    child.stdout?.on("data", (d) => out += d.toString());
    child.stderr?.on("data", (d) => out += d.toString());
    child.on("error", (err) => {
      clearTimeout(timer);
      out += `spawn error: ${err.message}`;
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}
function gitBlobToFile(root, args, dest, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    let fd;
    try {
      fd = fs3.openSync(dest, "w");
    } catch {
      resolve({ ok: false, out: "open dest failed" });
      return;
    }
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        fs3.closeSync(fd);
      } catch {
      }
      resolve({ ok, out: redact(out).slice(0, 200) });
    };
    const child = child_process.spawn("git", ["--no-optional-locks", "-C", root, ...args], {
      stdio: ["ignore", fd, "pipe"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, timeoutMs);
    child.stderr?.on("data", (d) => out += d.toString());
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}
function createAutoSync(opts) {
  const root = projectRoot(opts.configDir);
  const commonDir = gitCommonDir(root);
  const gitMode = Boolean(commonDir);
  let timer = null;
  let inflight = null;
  let stopped = false;
  let state = "init";
  let branch = BRANCH_PRIMARY;
  let restorePromise = null;
  let readmeSha = null;
  let legacyReadmeShas = null;
  let everPushed = false;
  let noCredLocalMode = false;
  let consecutivePushFailures = 0;
  let lastPushError = null;
  let lastSyncAt = null;
  let lastSyncAttemptAt = null;
  const enabled = opts.autoSyncEnabled && gitMode && isGitRepo(root);
  const repo = opts.repo;
  if (!opts.autoSyncEnabled) {
    state = "disabled by config (autoSync: false)";
  } else if (!gitMode) {
    state = "no git repo \u2014 feedback persists to disk only (threads.db)";
  } else if (!repo) {
    state = "partial: git repo without a github remote (orphan branch kept locally, no push)";
  }
  const logOnce = (msg) => {
    const safe = redact(msg);
    const n = (logCounts.get(safe) ?? 0) + 1;
    logCounts.set(safe, n);
    if (n === 1 || n === 5 || n === 25 || n > 25 && n % 100 === 0) {
      console.warn(`[storybook-annotakit] store-sync: ${safe}${n > 1 ? ` (x${n})` : ""}`);
    }
  };
  const logCounts = /* @__PURE__ */ new Map();
  const commitEnv = () => ({ ...COMMIT_ENV });
  const getLegacyReadmeShas = async () => {
    if (legacyReadmeShas) return legacyReadmeShas;
    const shas = /* @__PURE__ */ new Set();
    for (const content of LEGACY_README_CONTENTS) {
      const h = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--stdin"], 8e3, { stdin: content });
      if (h.ok && SHA_RE.test(h.out.trim())) shas.add(h.out.trim());
    }
    legacyReadmeShas = shas;
    return shas;
  };
  const refReadmeKind = async (ref) => {
    if (!readmeSha) {
      const h = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--stdin"], 8e3, { stdin: README_CONTENT });
      if (!h.ok || !SHA_RE.test(h.out.trim())) return "no-readme";
      readmeSha = h.out.trim();
    }
    const blob = await gitAsync(root, ["rev-parse", `${ref}:README`], 6e3);
    const sha = blob.ok ? blob.out.trim() : "";
    if (!blob.ok || !SHA_RE.test(sha)) return "no-readme";
    if (sha === readmeSha) return "ours";
    const content = await gitAsync(root, ["show", `${ref}:README`], 6e3);
    const line1 = content.ok ? (content.out.split("\n")[0] ?? "").trim() : "";
    if (line1 === README_MARKER) return "ours";
    const legacy = await getLegacyReadmeShas();
    if (legacy.has(sha)) return "legacy";
    return "foreign";
  };
  const refHasOurReadme = async (ref) => {
    const kind = await refReadmeKind(ref);
    return kind === "ours" || kind === "legacy";
  };
  const resolveBranch = async () => {
    const localHead = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH_PRIMARY}`], 5e3);
    if (localHead.ok && SHA_RE.test(localHead.out.trim())) {
      const kind = await refReadmeKind(`refs/heads/${BRANCH_PRIMARY}`);
      if (kind === "no-readme" || kind === "foreign") {
        logOnce(
          kind === "no-readme" ? `refs/heads/${BRANCH_PRIMARY} exists but its tip has NO README (empty or non-store branch) \u2014 using ${BRANCH_FALLBACK} instead (A14)` : `refs/heads/${BRANCH_PRIMARY} exists but is not an annotakit store branch (README mismatch \u2014 genuinely foreign) \u2014 using ${BRANCH_FALLBACK} instead (A14)`
        );
        return BRANCH_FALLBACK;
      }
    }
    return BRANCH_PRIMARY;
  };
  const fetchRemote = async (timeoutMs, targetBranch) => {
    if (!repo) return null;
    const b = targetBranch ?? branch;
    const token = ghToken();
    const url = `https://github.com/${repo}.git`;
    const auth = gitAuthEnv(token);
    const args = [...auth.args, "fetch", url, `+refs/heads/${b}:${REMOTE_CACHE_REF}`];
    const f = await gitAsync(root, args, timeoutMs, auth.env ? { env: auth.env } : void 0);
    const head = await gitAsync(root, ["rev-parse", "--verify", "--quiet", REMOTE_CACHE_REF], 5e3);
    if (head.ok && SHA_RE.test(head.out.trim())) return { sha: head.out.trim(), ref: REMOTE_CACHE_REF };
    if (!f.ok) {
      const cached = await readCachedRemoteHead();
      if (cached) return cached;
    }
    return null;
  };
  const readCachedRemoteHead = async () => {
    for (const ref of [REMOTE_CACHE_REF, `refs/remotes/origin/${branch}`]) {
      const head = await gitAsync(root, ["rev-parse", "--verify", "--quiet", ref], 5e3);
      if (head.ok && SHA_RE.test(head.out.trim())) return { sha: head.out.trim(), ref };
    }
    return null;
  };
  const buildTree = async (timeoutMs) => {
    if (!readmeSha) {
      const h = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--stdin"], 8e3, { stdin: README_CONTENT });
      if (!h.ok || !SHA_RE.test(h.out.trim())) return null;
      readmeSha = h.out.trim();
    }
    const dbBlob = await gitAsync(root, ["hash-object", "-t", "blob", "-w", "--", opts.storePath], 1e4);
    if (!dbBlob.ok || !SHA_RE.test(dbBlob.out.trim())) {
      logOnce(`git hash-object failed (${dbBlob.out})`);
      return null;
    }
    const mktreeInput = `100644 blob ${readmeSha}	README
100644 blob ${dbBlob.out.trim()}	threads.db
`;
    const tree = await gitAsync(root, ["mktree"], 8e3, { stdin: mktreeInput });
    if (!tree.ok || !SHA_RE.test(tree.out.trim())) {
      logOnce(`git mktree failed (${tree.out})`);
      return null;
    }
    return tree.out.trim();
  };
  const commitTree = async (tree, parent, message, timeoutMs) => {
    const args = ["commit-tree", tree, ...parent ? ["-p", parent] : [], "-m", message];
    const c = await gitAsync(root, args, timeoutMs, { env: commitEnv() });
    if (!c.ok || !SHA_RE.test(c.out.trim())) {
      logOnce(`git commit-tree failed (${c.out})`);
      return null;
    }
    return c.out.trim();
  };
  const pushCommit = async (sha, timeoutMs) => {
    if (!SHA_RE.test(sha)) {
      logOnce(`refusing to push non-sha refspec (${sha.slice(0, 12)}\u2026) \u2014 empty-sha guard (A4.3)`);
      return { ok: false, out: "empty-sha guard" };
    }
    if (!repo) return { ok: false, out: "no remote" };
    if (noCredLocalMode) return { ok: false, out: "local mode (no push credential)" };
    maybeWarnArgvAuth();
    const token = ghToken();
    const url = `https://github.com/${repo}.git`;
    const refspec = `${sha}:refs/heads/${branch}`;
    const auth = gitAuthEnv(token);
    return gitAsync(root, [...auth.args, "push", "--no-verify", url, refspec], timeoutMs, auth.env ? { env: auth.env } : void 0);
  };
  const readRemoteDoc = async (commitSha) => {
    let sha = commitSha;
    let sawBlob = false;
    for (let hop = 0; hop < 4; hop++) {
      const exists = await gitAsync(root, ["cat-file", "-e", `${sha}:threads.db`], 5e3);
      if (exists.ok) {
        sawBlob = true;
        const tmpDir = fs3.mkdtempSync(path2__default.default.join(os__default.default.tmpdir(), "annotakit-restore-"));
        const tmp = path2__default.default.join(tmpDir, "threads.db");
        try {
          const show = await gitBlobToFile(root, ["show", `${sha}:threads.db`], tmp, 15e3);
          if (show.ok) {
            const doc = readStoreFile(tmp);
            if (doc && doc.threads.length >= 0) return { kind: "doc", doc: { threads: doc.threads, deletedIds: doc.deletedIds } };
          } else {
            logOnce(`remote db blob read failed at ${sha.slice(0, 8)} (${show.out})`);
          }
        } finally {
          try {
            fs3.rmSync(tmpDir, { recursive: true, force: true });
          } catch {
          }
        }
      }
      const parent = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `${sha}^`], 5e3);
      if (!parent.ok || !SHA_RE.test(parent.out.trim())) return sawBlob ? { kind: "unreadable" } : { kind: "absent" };
      sha = parent.out.trim();
    }
    return sawBlob ? { kind: "unreadable" } : { kind: "absent" };
  };
  const importDoc = async (doc) => {
    await opts.store.importTombstones(doc.deletedIds);
    for (const t of doc.threads) await opts.store.upsertMergedThread(t);
    await opts.store.recomputeCounters();
    try {
      opts.onRestored?.("restored");
    } catch {
    }
    return doc.threads.length;
  };
  const trace = (msg) => {
    if (process.env.ANNOTAKIT_SYNC_TRACE) console.error(`[annota-sync +${(Date.now() - BOOT_MS).toFixed(0)}ms] ${msg}`);
  };
  const restore = () => {
    if (restorePromise) return restorePromise;
    restorePromise = (async () => {
      if (!enabled) {
        state = opts.autoSyncEnabled ? state : state;
        return;
      }
      try {
        trace("restore: begin");
        branch = await resolveBranch();
        trace(`restore: branch=${branch}`);
        let remote = await readCachedRemoteHead();
        trace(`restore: cached=${remote ? remote.sha.slice(0, 8) : "none"}`);
        const fetched = await fetchRemote(1e4);
        trace(`restore: fetched=${fetched ? fetched.sha.slice(0, 8) : "none"}`);
        if (fetched) remote = fetched;
        if (!remote) {
          state = repo ? `no remote store yet (${branch}) \u2014 first snapshot will create it` : `local orphan branch only (${branch}) \u2014 no GitHub repo configured; set ANNOTAKIT_GH_REPO for cross-machine durability`;
          return;
        }
        let kind = await refReadmeKind(remote.ref);
        if (kind === "no-readme" || kind === "foreign") {
          if (branch === BRANCH_PRIMARY) {
            const fb = await fetchRemote(1e4, BRANCH_FALLBACK);
            if (fb && await refHasOurReadme(fb.ref)) {
              logOnce(
                `remote refs/heads/${BRANCH_PRIMARY} is ${kind === "foreign" ? "foreign" : "README-less"} but ${BRANCH_FALLBACK} is ours \u2014 switching the store branch to ${BRANCH_FALLBACK} (A14/C17)`
              );
              branch = BRANCH_FALLBACK;
              remote = fb;
              kind = await refReadmeKind(fb.ref);
            }
          }
          if (kind === "no-readme" || kind === "foreign") {
            logOnce(
              kind === "no-readme" ? `remote refs/heads/${branch} tip has NO README \u2014 pre-annotakit or empty branch, not adopting it (A14)` : `remote refs/heads/${branch} is not an annotakit store branch (README mismatch \u2014 genuinely foreign), not adopting it (A14)`
            );
            state = `remote ${branch} is foreign; local store unaffected`;
            return;
          }
        }
        const remoteRead = await readRemoteDoc(remote.sha);
        const localCount = await opts.countThreads();
        if (remoteRead.kind !== "doc") {
          state = remoteRead.kind === "unreadable" ? `remote store unreadable (walked parents) \u2014 local data safe (${localCount} threads)` : `remote ${branch} carries no store blob (README-only) \u2014 local data safe (${localCount} threads)`;
          return;
        }
        const remoteDoc = remoteRead.doc;
        if (localCount === 0 && (remoteDoc.threads.length > 0 || remoteDoc.deletedIds.size > 0)) {
          const n = await importDoc(remoteDoc);
          state = `restored ${n} threads from ${branch} (boot)`;
          console.warn(`[storybook-annotakit] store restore: ${state}`);
        } else if (localCount > 0 && (remoteDoc.threads.length > 0 || remoteDoc.deletedIds.size > 0)) {
          const local = {
            threads: await opts.store.listThreads(),
            deletedIds: await opts.store.listDeletedIds()
          };
          const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
          const changed = merged.threads.length !== local.threads.length || merged.deletedIds.size !== local.deletedIds.size || merged.threads.some((mt) => {
            const lt = local.threads.find((t) => t.id === mt.id);
            return !lt || JSON.stringify(lt) !== JSON.stringify(mt);
          });
          if (changed) {
            const n = await importDoc(merged);
            const droppedIds = [
              ...local.threads.filter((t) => merged.deletedIds.has(t.id)).map((t) => t.id),
              ...remoteDoc.threads.filter((t) => merged.deletedIds.has(t.id)).map((t) => t.id)
            ].filter((id, i, a) => a.indexOf(id) === i);
            state = `merged remote ${branch} \u2192 ${n} threads (boot)` + (droppedIds.length > 0 ? ` \u2014 delete-wins dropped: ${droppedIds.slice(0, 10).join(", ")}${droppedIds.length > 10 ? ` (+${droppedIds.length - 10} more)` : ""}` : "");
            console.warn(`[storybook-annotakit] store restore: ${state}`);
            void syncOnce(9e3, "boot-merge");
          } else {
            state = `in sync with remote ${branch} (boot)`;
          }
        } else {
          state = `local store ahead (${localCount} threads, remote empty)`;
        }
      } catch (err) {
        logOnce(`restore failed (${err instanceof Error ? err.message : String(err)}) \u2014 local data safe`);
        state = "restore failed (local data safe)";
      }
    })();
    return restorePromise;
  };
  const syncOnce = async (timeoutMs = 9e3, reason = "mutation", countLabel = "?") => {
    if (!enabled) return false;
    if (stopped && !signalHandled) return false;
    if (inflight) return inflight;
    const p = (async () => {
      try {
        trace(`syncOnce(${reason}): begin`);
        const n = await opts.countThreads();
        const tombstones = await opts.store.listDeletedIds();
        if (n === 0 && tombstones.size === 0) {
          state = "up to date (empty store)";
          return true;
        }
        opts.checkpoint();
        const remoteHead = await fetchRemote(timeoutMs);
        trace(`syncOnce(${reason}): remoteHead=${remoteHead ? remoteHead.sha.slice(0, 8) : "none"}`);
        let parent = remoteHead ? remoteHead.sha : null;
        if (parent && remoteHead) {
          const kind = await refReadmeKind(remoteHead.ref);
          if (kind === "no-readme" || kind === "foreign") {
            logOnce(
              kind === "no-readme" ? `remote refs/heads/${branch} tip has NO README \u2014 not parenting on it (A14)` : `remote refs/heads/${branch} is foreign \u2014 not parenting on it (A14)`
            );
            parent = null;
          }
        }
        if (parent) {
          const remoteRead = await readRemoteDoc(parent);
          if (remoteRead.kind === "unreadable") {
            logOnce(
              `remote ${branch} store unreadable at ${parent.slice(0, 8)} \u2014 REFUSING to push an uncomputed union (it would wholesale-replace remote content)`
            );
            state = "refusing to push \u2014 remote store unreadable (union uncomputed); local data safe";
            if (repo) {
              consecutivePushFailures += 1;
              lastPushError = "remote store unreadable \u2014 push refused (union uncomputed)";
              lastSyncAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
            }
            return false;
          }
          if (remoteRead.kind === "doc") {
            const remoteDoc = remoteRead.doc;
            const local = { threads: await opts.store.listThreads(), deletedIds: await opts.store.listDeletedIds() };
            const merged = logicalMerge(local, { threads: remoteDoc.threads, deletedIds: remoteDoc.deletedIds });
            const changed = merged.threads.length !== local.threads.length || merged.deletedIds.size !== local.deletedIds.size || merged.threads.some((mt) => {
              const lt = local.threads.find((t) => t.id === mt.id);
              return !lt || JSON.stringify(lt) !== JSON.stringify(mt);
            });
            if (changed) {
              await importDoc(merged);
              opts.checkpoint();
              const cnt = await opts.countThreads();
              if (cnt === 0 && (await opts.store.listDeletedIds()).size === 0) {
                state = "merged to empty (all deleted) \u2014 nothing to push";
                return true;
              }
            }
          }
        }
        const tree = await buildTree(timeoutMs);
        if (!tree) {
          state = "error: git tree";
          if (repo) {
            consecutivePushFailures += 1;
            lastPushError = "git tree build failed (pre-push cycle failure)";
            lastSyncAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
          }
          return false;
        }
        const commit = await commitTree(
          tree,
          parent,
          `annotakit store snapshot (${await opts.countThreads()} threads, ${reason}, db=${path2__default.default.basename(path2__default.default.dirname(opts.storePath))}@${path2__default.default.basename(root)})`,
          timeoutMs
        );
        if (!commit) {
          state = "error: git commit-tree";
          if (repo) {
            consecutivePushFailures += 1;
            lastPushError = "git commit-tree failed (pre-push cycle failure)";
            lastSyncAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
          }
          return false;
        }
        noCredLocalMode = noCredLocalMode && !ghToken();
        let push = await pushCommit(commit, timeoutMs);
        let pushedSha = commit;
        let pushedParent = parent;
        trace(`syncOnce(${reason}): push1=${push.ok} ${push.out.slice(0, 80)}`);
        if (!push.ok && (/non-fast-forward|fetch first|rejected|failed to push|atomic/i.test(push.out) || /cannot lock ref|cannot lock/i.test(push.out))) {
          const freshHead = await fetchRemote(timeoutMs);
          if (freshHead && await refHasOurReadme(freshHead.ref)) {
            const freshRead = await readRemoteDoc(freshHead.sha);
            if (freshRead.kind === "unreadable") {
              logOnce("diverged and the fresh remote store is unreadable \u2014 REFUSING the merge push (union uncomputed); will retry next mutation");
            } else {
              if (freshRead.kind === "doc") {
                const local = { threads: await opts.store.listThreads(), deletedIds: await opts.store.listDeletedIds() };
                const merged = logicalMerge(local, { threads: freshRead.doc.threads, deletedIds: freshRead.doc.deletedIds });
                await importDoc(merged);
                opts.checkpoint();
              }
              const tree2 = await buildTree(timeoutMs);
              const commit2 = tree2 ? await commitTree(tree2, freshHead.sha, `annotakit store merge (${reason})`, timeoutMs) : null;
              if (commit2) {
                pushedSha = commit2;
                pushedParent = freshHead.sha;
                push = await pushCommit(commit2, timeoutMs);
              }
            }
          } else {
            logOnce("diverged but remote head unavailable/foreign \u2014 will retry next mutation");
          }
        }
        if (!push.ok) {
          if (repo && !ghToken()) {
            noCredLocalMode = true;
            state = "local mode \u2014 no push credential; branch updated locally (set ANNOTAKIT_GH_TOKEN in .env to push)";
            lastSyncAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
            await gitAsync(root, ["update-ref", `refs/heads/${branch}`, commit], timeoutMs);
          } else if (repo) {
            consecutivePushFailures += 1;
            lastPushError = redact(push.out).slice(0, 200) || "git push failed";
            lastSyncAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
            const authRejected = /Authentication failed|could not read Username|terminal prompts disabled|403/.test(String(push.out));
            logOnce(
              `git push failed (${push.out})${ghToken() ? authRejected ? " \u2014 the token looks REJECTED or lacks scope: rotate ANNOTAKIT_GH_TOKEN in .env, then POST /annotakit/api/gh/reload (v0.6.6) or restart" : "" : " \u2014 no ANNOTAKIT_GH_TOKEN in .env?"}`
            );
            state = "committed locally; push failed (retry on next mutation)";
          } else {
            state = "orphan branch updated locally (no remote to push)";
            lastSyncAttemptAt = (/* @__PURE__ */ new Date()).toISOString();
            await gitAsync(root, ["update-ref", `refs/heads/${branch}`, commit], timeoutMs);
          }
          return false;
        }
        everPushed = true;
        consecutivePushFailures = 0;
        lastPushError = null;
        lastSyncAt = (/* @__PURE__ */ new Date()).toISOString();
        lastSyncAttemptAt = lastSyncAt;
        if (pushedParent) {
          await gitAsync(root, ["update-ref", REMOTE_CACHE_REF, pushedSha, pushedParent], timeoutMs);
          await gitAsync(root, ["update-ref", `refs/heads/${branch}`, pushedSha, pushedParent], timeoutMs);
        } else {
          await gitAsync(root, ["update-ref", REMOTE_CACHE_REF, pushedSha], timeoutMs);
          await gitAsync(root, ["update-ref", `refs/heads/${branch}`, pushedSha], timeoutMs);
        }
        state = `pushed ${branch} \u2192 ${repo} (${reason})`;
        return true;
      } catch (err) {
        logOnce(`unexpected error (${err instanceof Error ? err.message : String(err)})`);
        state = "error";
        return false;
      }
    })();
    inflight = p;
    p.then(
      () => {
        if (inflight === p) inflight = null;
        if (dirtyDuringCycle && !stopped && !signalHandled) {
          dirtyDuringCycle = false;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void syncOnce(9e3, "mutation-after-join");
          }, DEBOUNCE_MS);
          timer.unref?.();
        }
      },
      () => {
        if (inflight === p) inflight = null;
        dirtyDuringCycle = false;
      }
    );
    return p;
  };
  let signalHandled = false;
  let dirtyDuringCycle = false;
  const shutdownHooks = opts.onShutdownHooks ?? [];
  let warnedArgvAuth = false;
  const maybeWarnArgvAuth = () => {
    if (warnedArgvAuth || !ghToken() || gitSupportsEnvConfig()) return;
    warnedArgvAuth = true;
    console.warn("[storybook-annotakit] \u26A0 this git (< 2.31) cannot take auth via environment config \u2014 the GitHub token is passed on the git command line, where other local users can read it via /proc. Upgrade git to \u2265 2.31.");
  };
  const notify = () => {
    if (!enabled || stopped || signalHandled) return;
    if (inflight) {
      dirtyDuringCycle = true;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void syncOnce(9e3, "mutation");
    }, DEBOUNCE_MS);
    timer.unref?.();
  };
  const flush = (timeoutMs = 9e3) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!enabled) return;
    const hardExit = setTimeout(() => process.exit(0), timeoutMs + 6e3);
    const run = async () => {
      if (inflight) {
        try {
          await inflight;
        } catch {
        }
      }
      for (const hook of shutdownHooks) {
        try {
          await hook();
        } catch {
        }
      }
      await syncOnce(timeoutMs, "shutdown");
    };
    void run().catch(() => void 0).finally(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  };
  const onSignal = () => {
    if (signalHandled) return;
    signalHandled = true;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (!enabled) {
      process.exit(0);
      return;
    }
    flush();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  };
  const describe = () => state;
  const storeBranchName = () => {
    trace(`storeBranchName() \u2192 ${branch}`);
    return branch;
  };
  const storeMode = () => gitMode ? "git" : "classic";
  const syncNow = (reason = "api") => syncOnce(9e3, reason);
  const durability = () => {
    if (!enabled) return "disk-only";
    if (!repo) return "git-commit";
    if (ghToken() || everPushed) {
      return consecutivePushFailures > 0 ? "git-commit" : "git-push";
    }
    return "git-commit";
  };
  const gitHealth = () => ({
    autoSync: enabled,
    mode: durability(),
    branch,
    remote: repo,
    consecutivePushFailures,
    lastPushError,
    lastSyncAt,
    lastSyncAttemptAt,
    healthy: consecutivePushFailures === 0,
    describe: state
  });
  if (enabled) {
    console.warn(
      `[storybook-annotakit] store sync ON (v0.5 orphan branch): ${opts.storePath} \u2192 refs/heads/${branch}${repo ? ` \u2192 ${repo}` : " (no remote)"} \u2014 survives branch switches, checkouts and clean`
    );
  } else {
    console.warn(`[storybook-annotakit] store sync ${state} \u2014 the .db file still persists to disk`);
  }
  return { notify, describe, durability, gitHealth, syncNow, restore, storeBranch: storeBranchName, storeMode, stop };
}

// src/shared/events.ts
var THREADS_CHANGED = "annotakit/threads-changed";
var API_BASE = "/annotakit/api";

// src/server/routes.ts
var VERSION = "0.1.0";
var BOOTED_AT = (/* @__PURE__ */ new Date()).toISOString();
var CONFIG_FILE = "annotakit.config.json";
var GH_LABEL = "dom-annotakit";
function resolveGhLabels(config) {
  const configLabels = Array.isArray(config.labels) ? config.labels.map((l) => String(l).trim()).filter(Boolean) : null;
  return configLabels?.length ? configLabels : ghLabelsEnv() ?? [GH_LABEL];
}
var emitToChannel = null;
function setChannelEmitter(emit) {
  emitToChannel = emit;
}
function broadcast(payload) {
  try {
    emitToChannel?.(THREADS_CHANGED, payload);
  } catch {
  }
}
var runtime = null;
function nonNegNum(v) {
  const n = typeof v === "string" ? Number.parseInt(v, 10) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : void 0;
}
function bootstrap(configDir2, port) {
  if (runtime) return runtime;
  const env = loadDotEnv(configDir2);
  const preConfig = readConfig(configDir2);
  const gitFlowOn = preConfig.autoSync !== false;
  const loc = storeLocation(configDir2, { forceClassic: !gitFlowOn });
  const store = getStore(configDir2, { dataDir: loc.dir });
  const config = preConfig;
  const root = projectRoot(configDir2);
  const detected = detectGithubRepo(root);
  const configRepoRaw = typeof config.ghRepo === "string" ? config.ghRepo : null;
  const configRepoPresent = config.ghRepo !== void 0 && config.ghRepo !== null;
  const configRepo = configRepoRaw !== null ? normalizeGhRepoInput(configRepoRaw) : null;
  const envRepo = ghRepoEnv();
  const repo = configRepoPresent ? configRepo : envRepo ?? detected.repo;
  const ghLabels = resolveGhLabels(config);
  const shutdownHooks = [];
  const sync = createAutoSync({
    configDir: configDir2,
    dataDir: loc.dir,
    storePath: store.storePath,
    store,
    checkpoint: () => store.checkpoint(),
    countThreads: () => store.countThreads(),
    autoSyncEnabled: config.autoSync !== false,
    repo,
    // A7: restored/merged rows must reach every live surface immediately
    onRestored: (reason) => broadcast({ reason }),
    onShutdownHooks: shutdownHooks
  });
  const repoSource = configRepo ? `${CONFIG_FILE} ghRepo` : envRepo ? "ANNOTAKIT_GH_REPO env" : detected.source;
  const configToken = typeof config.ghToken === "string" ? config.ghToken : void 0;
  const bootWarnings = [...configWarnings];
  if (configRepoPresent && configRepo === null) {
    bootWarnings.push(
      `${CONFIG_FILE} "ghRepo" ${JSON.stringify(config.ghRepo)} is not a valid GitHub repo \u2014 expected "owner/name" as a string (github.com URLs and the github: shorthand normalize). The GitHub mirror stays OFF instead of arming a dead target; fix the value to enable mirroring.`
    );
  }
  const kit = kitRepo();
  if (repo && kit && repo === kit) {
    bootWarnings.push(
      `GitHub mirror target ${repo} is the storybook-annotakit repo ITSELF (${repoSource}) \u2014 feedback will mirror into the ADDON's repo. Intended for demo/dogfood runs only; otherwise set "ghRepo" to YOUR repo in ${CONFIG_FILE} (or ANNOTAKIT_GH_REPO in .env).`
    );
  }
  if (env.file && process.env.ANNOTAKIT_GH_TOKEN && process.env.ANNOTAKIT_ENV_TRACKED_OK !== "1" && isGitRepo(root) && !pathIsIgnored(root, env.file)) {
    bootWarnings.push(
      `.env at ${env.file} holds ANNOTAKIT_GH_TOKEN but is NOT gitignored \u2014 the next \`git add -A\` commits your PAT into history. Add ".env" to .gitignore, or set ANNOTAKIT_ENV_TRACKED_OK=1 if you track it deliberately (sandbox "git is the disk" setups).`
    );
  }
  if (configToken) {
    bootWarnings.push(
      isPathTracked(root, `${configDir2}/${CONFIG_FILE}`) ? `ghToken in ${CONFIG_FILE} is git-TRACKED \u2014 the PAT is already in history on the next commit. Move it to a gitignored .env (ANNOTAKIT_GH_TOKEN).` : `ghToken in ${CONFIG_FILE} is deprecated (config files travel with the repo) \u2014 prefer .env ANNOTAKIT_GH_TOKEN.`
    );
  }
  for (const w of bootWarnings) console.warn(`[storybook-annotakit] \u26A0 ${w}`);
  const ghAuto = config.ghAuto !== false && !["0", "false", "off", "no"].includes(String(process.env.ANNOTAKIT_GH_AUTO ?? "").toLowerCase());
  const pollSec = nonNegNum(process.env.ANNOTAKIT_GH_POLL) ?? nonNegNum(config.ghPoll) ?? 60;
  const intervalMs = Math.max(100, nonNegNum(process.env.ANNOTAKIT_GH_INTERVAL) ?? 700);
  const ghsync = createGhSync({
    store,
    repo,
    token: () => ghToken() ?? configToken,
    configPath: `${configDir2}/${CONFIG_FILE}`,
    labels: () => ghLabels,
    enabled: ghAuto,
    pollSec,
    intervalMs,
    origin: () => runtime?.origin ?? "http://localhost:6006",
    onEngineMutation: (thread, reason) => {
      broadcast({ storyId: thread.storyId, threadId: thread.id, reason });
      sync.notify();
    }
  });
  shutdownHooks.push(() => ghsync.stop());
  runtime = { store, sync, ghsync, config, root, configPath: `${configDir2}/${CONFIG_FILE}`, repo, repoSource, ghLabels, origin: port ? `http://localhost:${port}` : "http://localhost:6006", started: true, bootWarnings };
  if (repo) {
    console.warn(`[storybook-annotakit] GitHub mirror target: ${repo} (${repoSource})`);
  } else {
    console.warn(
      `[storybook-annotakit] no GitHub repo configured \u2014 local mode: REST + digests work fully; POST /sync explains how to add the mirror (${CONFIG_FILE}, .env, or git remote)`
    );
  }
  void (async () => {
    try {
      await migrateLegacyStore(configDir2, store, loc.dir);
    } catch {
    }
    try {
      await sync.restore();
    } catch {
    }
    ghsync.start();
  })();
  return runtime;
}
function afterMutation(rt, payload) {
  broadcast(payload);
  rt.sync.notify();
  if (payload.threadId) rt.ghsync.enqueue(payload.threadId);
}
async function sendMutationJson(rt, res, status, body, opts) {
  try {
    const s = await rt.ghsync.status();
    if (s.mode === "auto" && (s.stalled > 0 || s.lastError)) {
      const ascii = (v) => v.replace(/[^\x20-\x7E]/g, "?");
      res.setHeader(
        "X-Annotakit-Mirror",
        ascii(`unhealthy (stalled=${s.stalled}${s.lastError ? `; lastError=${String(s.lastError).slice(0, 140)}` : ""}) -- see /annotakit/api/health ghSync`)
      );
    }
  } catch {
  }
  if (opts?.replayed) {
    res.setHeader("X-Annotakit-Replayed", "1");
    sendJson(res, status, body && typeof body === "object" ? { ...body, replayed: true } : body);
    return;
  }
  sendJson(res, status, body);
}
function isLoopbackPeer(req) {
  const ra = req.socket?.remoteAddress;
  if (!ra) return true;
  if (ra === "::1" || ra === "127.0.0.1") return true;
  if (ra.startsWith("::ffff:127.")) return true;
  return false;
}
var warnedNonLoopback = false;
function enforceApiAccess(req, res) {
  const key = process.env.ANNOTAKIT_API_KEY;
  if (isLoopbackPeer(req)) return true;
  if (key) {
    const provided = req.headers["x-annotakit-key"];
    const safeEqual = (a, b) => {
      const ha = crypto.createHash("sha256").update(a, "utf8").digest();
      const hb = crypto.createHash("sha256").update(b, "utf8").digest();
      return ha.length === hb.length && ha.equals(hb);
    };
    const ok = typeof provided === "string" && safeEqual(provided, key) || Array.isArray(provided) && provided.some((p) => safeEqual(p, key));
    if (!ok) {
      sendJson(res, 401, { error: "x-annotakit-key header required (ANNOTAKIT_API_KEY is set on this server)" });
      return false;
    }
    return true;
  }
  if (!warnedNonLoopback) {
    warnedNonLoopback = true;
    console.warn(
      `[storybook-annotakit] BLOCKED non-loopback API request from ${String(req.socket?.remoteAddress)} \u2014 the Storybook dev server binds a network interface. To allow network clients, set ANNOTAKIT_API_KEY in .env and send it as the x-annotakit-key header.`
    );
  }
  sendJson(res, 403, {
    error: "annotakit API is loopback-only by default (the dev server binds a network interface). Set ANNOTAKIT_API_KEY in the project .env to enable keyed network access."
  });
  return false;
}
function applyCors(req, res, methods = "GET,POST,PATCH,DELETE,OPTIONS") {
  const origin = req.headers.origin;
  if (!origin) return;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return;
  }
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(host)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    let allow = methods;
    try {
      const path6 = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
      const known = KNOWN_API_ROUTES.find(([re]) => re.test(path6));
      if (known) allow = known[1];
    } catch {
    }
    res.setHeader("Access-Control-Allow-Methods", allow);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Expose-Headers", "X-Annotakit-Replayed, X-Annotakit-Mirror");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Vary", "Origin");
  }
}
function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversize = false;
    req.on("data", (c) => {
      if (oversize) return;
      size += c.length;
      if (size > 2e6) {
        oversize = true;
        chunks.length = 0;
        console.warn("[storybook-annotakit] 413: request body exceeds 2MB \u2014 comment bodies are capped at 64000 chars; PUT snapshots at 96KB");
        reject(Object.assign(new Error("request body too large (max 2MB \u2014 comment bodies are capped at 64000 chars, snapshots at 96KB)"), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (oversize) return;
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("body must be a JSON object");
        }
        resolve(parsed);
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body (${err instanceof Error ? err.message : String(err)})`), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}
function notFound(res, hint) {
  sendJson(res, 404, { error: hint ? `not found \u2014 ${hint}` : "not found" });
}
var THREAD_404_HINT = "GET /annotakit/api/threads lists thread ids";
var ROUTE_404_HINT = "unknown route \u2014 GET /annotakit/api/schema documents every endpoint";
var warnedStories = /* @__PURE__ */ new Set();
function warnUnknownStory(storyId, hasImportPath) {
  if (hasImportPath || warnedStories.has(storyId)) return;
  if (warnedStories.size > 500) warnedStories.clear();
  warnedStories.add(storyId);
  console.warn(
    `[storybook-annotakit] note: thread created for storyId ${JSON.stringify(storyId)} WITHOUT story metadata (importPath) \u2014 digests will show a bare story-id section with no story file. Pass story: {title, name, importPath} when you have it; a typo'd storyId is invisible to the server.`
  );
}
function fail(res, err) {
  const status = err?.status ?? 500;
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, status, { error: message });
}
var THREAD_INPUT_EXAMPLE = {
  // id: the IDEMPOTENCY KEY — send a stable, meaningful id (e.g.
  // "fix-header-overflow") and a replayed POST with the same id returns
  // 200 with the existing thread instead of minting a duplicate (201).
  // FINALITY: an id that was DELETEd is tombstoned forever — a POST with
  // that id 409s (delete-wins); a correction after a delete needs a NEW id.
  // Omit it only when you genuinely want a brand-new thread per POST.
  id: "fix-kpi-tabular-nums",
  // storyId = the CAPTURE id (manifest id: relative path from the captures
  // root, extension-stripped, `[^a-zA-Z0-9-]` → `-`); `story` mirrors the
  // capture metadata: importPath = the capture file's path.
  storyId: "reports-kpi-page",
  story: { title: "Reports", name: "KPI page", importPath: "captures/reports/kpi-page.html" },
  // captures have no live component tree — component stays null/omitted
  // (the field remains in the schema for lineage rows; renderers guard `if (comp)`).
  component: null,
  target: {
    kind: "pin",
    selector: { cssSelector: ".kpi-card > span.value", textQuote: { exact: "revenue", prefix: "kpi", suffix: "month" }, fragment: { x: 24, y: 12, w: 96, h: 20 } },
    fingerprint: { tag: "span", attrs: [{ name: "data-testid", value: "kpi-value" }], neighborText: "revenue" },
    context: { tag: "span", text: "Revenue", ariaLabel: "revenue value", classes: "value tabular-nums", id: "kpi-value", nth: 2 },
    bbox: { x: 24, y: 12, w: 96, h: 20 },
    captureViewportWidth: 1200
  },
  comments: [{ id: "c_example_1", author: "reviewer", body: "numbers should be tabular", createdAt: "2026-09-05T00:00:00.000Z" }]
};
var TARGET_SHAPE_HINT = 'target must be {kind: "pin"|"region", selector: {cssSelector?, textQuote?, fragment?}, fingerprint?: {tag, attrs[]}, context: {tag: string, text?, ...}, bbox: {x,y,w,h}, captureViewportWidth: number} \u2014 see GET /annotakit/api/schema for a full example payload';
function stableCommentId(author, body, createdAt) {
  return "c_" + crypto.createHash("sha256").update(`${author}|${body}|${createdAt}`).digest("base64url").slice(0, 12);
}
function normalizeComment(c) {
  if (typeof c.author !== "string" || !c.author.trim()) c.author = "anonymous";
  if (!c.createdAt) c.createdAt = nowIso();
  c.id = stableCommentId(c.author, c.body, c.createdAt);
  return c;
}
function validateTargetShape(target, label = "target") {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw Object.assign(new Error(`${label} is required \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const t = target;
  if (t.kind !== "pin" && t.kind !== "region") {
    throw Object.assign(new Error(`${label}.kind must be "pin" or "region" (got ${JSON.stringify(t.kind)}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const selector = t.selector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw Object.assign(new Error(`${label}.selector must be an object {cssSelector?, textQuote?, fragment?} (got ${typeof selector}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const bbox = t.bbox;
  const isBBox = (b) => !!b && typeof b === "object" && ["x", "y", "w", "h"].every((k) => typeof b[k] === "number");
  if (!isBBox(bbox)) {
    throw Object.assign(new Error(`${label}.bbox must be {x,y,w,h} numbers (got ${JSON.stringify(bbox)?.slice(0, 80)}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  const context = t.context;
  if (!context || typeof context !== "object" || Array.isArray(context) || typeof context.tag !== "string") {
    throw Object.assign(new Error(`${label}.context must be an object with a string "tag" (got ${typeof context}) \u2014 ${TARGET_SHAPE_HINT}`), { status: 400 });
  }
  if (t.captureViewportWidth != null && typeof t.captureViewportWidth !== "number") {
    throw Object.assign(new Error(`${label}.captureViewportWidth must be a number when provided`), { status: 400 });
  }
}
function validateThreadInput(body) {
  const storyId = typeof body.storyId === "string" ? body.storyId : "";
  const target = body.target;
  const comments = Array.isArray(body.comments) ? body.comments : [];
  if (!storyId) throw Object.assign(new Error("storyId is required"), { status: 400 });
  validateTargetShape(target);
  if (body.id !== void 0 && typeof body.id !== "string") {
    throw Object.assign(new Error(`thread id must be a string (client-minted th_\u2026 for replay-safe retries; got ${typeof body.id})`), { status: 400 });
  }
  if (comments.length === 0) {
    throw Object.assign(new Error("at least one comment is required"), { status: 400 });
  }
  for (const c of comments) {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      throw Object.assign(new Error("each comment must be an object (author, body, createdAt?)"), { status: 400 });
    }
    if (typeof c.body !== "string" || !c.body.trim()) {
      throw Object.assign(new Error("comment body is required (a non-empty string)"), { status: 400 });
    }
    if (c.author !== void 0 && c.author !== null && typeof c.author !== "string") {
      throw Object.assign(new Error(`comment author must be a string when present (got ${typeof c.author})`), { status: 400 });
    }
    if (c.body.length > MAX_BODY_CHARS) {
      throw Object.assign(new Error(`comment body too large (max ${MAX_BODY_CHARS} chars \u2014 the full body stays in the store/json export; keep evidence links instead of pasting whole logs)`), { status: 413 });
    }
    normalizeComment(c);
  }
  return body;
}
var PATCH_MERGEABLE_FIELDS = ["status", "resolvedAt", "story", "component", "target", "author", "comments"];
function buildPatchCandidate(prev, body) {
  const looksFull = "storyId" in body && "comments" in body && "target" in body;
  if (looksFull) {
    const full = body;
    if (!full.id || !Array.isArray(full.comments) || !full.target) {
      throw Object.assign(
        new Error('PATCH with a full document expects id, comments, target (GET /annotakit/api/threads/<id>, mutate, PATCH back) \u2014 or send a PARTIAL body like {"status":"resolved"}'),
        { status: 400 }
      );
    }
    return { ...full, id: prev.id, storyId: prev.storyId, number: prev.number, createdAt: prev.createdAt };
  }
  const next = { ...prev };
  for (const key of PATCH_MERGEABLE_FIELDS) {
    if (key in body) next[key] = body[key];
  }
  if ("comments" in next && !Array.isArray(next.comments)) {
    throw Object.assign(new Error("PATCH `comments` must be an array (comment objects, union-merged by id)"), { status: 400 });
  }
  if ("story" in next && next.story !== null && (typeof next.story !== "object" || Array.isArray(next.story))) {
    throw Object.assign(new Error("PATCH `story` must be an object (story metadata) or null"), { status: 400 });
  }
  if ("component" in next && next.component !== null && (typeof next.component !== "object" || Array.isArray(next.component))) {
    throw Object.assign(new Error("PATCH `component` must be an object (component metadata) or null"), { status: 400 });
  }
  if ("target" in next && (typeof next.target !== "object" || next.target === null || Array.isArray(next.target))) {
    throw Object.assign(new Error("PATCH `target` must be an object (pin target)"), { status: 400 });
  }
  if ("author" in next && typeof next.author !== "string") {
    throw Object.assign(new Error("PATCH `author` must be a string"), { status: 400 });
  }
  if ("resolvedAt" in next && next.resolvedAt !== null && typeof next.resolvedAt !== "string") {
    throw Object.assign(new Error("PATCH `resolvedAt` must be an ISO string or null"), { status: 400 });
  }
  return next;
}
var KNOWN_STATUSES = /* @__PURE__ */ new Set(["open", "fixed", "rejected", "resolved"]);
function parseStatusParam(url) {
  const raw = url.searchParams.get("status");
  if (raw === null || raw === "") return void 0;
  const s = raw.toLowerCase();
  if (!KNOWN_STATUSES.has(s)) {
    throw Object.assign(new Error(`unknown status ${JSON.stringify(raw)} \u2014 use ?status=open|fixed|rejected|resolved (omit for all threads)`), { status: 400 });
  }
  return s;
}
function groupByStory(threads, origin) {
  const map = /* @__PURE__ */ new Map();
  for (const t of threads) {
    let entry = map.get(t.storyId);
    if (!entry) {
      const storyUrl = `${origin}/?capture=${t.storyId}`;
      entry = {
        story: t.story ? { ...t.story, url: t.story.url ?? storyUrl } : { storyId: t.storyId, url: storyUrl },
        counts: { open: 0, fixed: 0, rejected: 0, resolved: 0 },
        threads: []
      };
      map.set(t.storyId, entry);
    }
    entry.threads.push(t);
    if (t.status === "open") entry.counts.open++;
    else if (t.status === "fixed") entry.counts.fixed++;
    else if (t.status === "rejected") entry.counts.rejected++;
    else if (t.status === "resolved") entry.counts.resolved++;
    else entry.counts.open++;
  }
  const out = [...map.values()];
  for (const s of out) s.threads.sort((a, b) => a.number - b.number);
  return out;
}
async function handleApi(req, res, url, configDir2, origin) {
  const rt = bootstrap(configDir2);
  const store = rt.store;
  const p = url.pathname;
  const method = req.method ?? "GET";
  if (p === `${API_BASE}/schema` && (method === "GET" || method === "HEAD")) {
    if (method === "HEAD") {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      // route index (Track B: 404s gave no pointers; agents had to read the
      // README to discover endpoints — now the API self-documents them)
      endpoints: [
        ["GET", `${API_BASE}/health`, "agentSurfaces, store, gh + git state \u2014 detect your path here first"],
        ["GET", `${API_BASE}/schema`, "this document"],
        ["GET", `${API_BASE}/threads`, "ALL threads \u2014 envelope {threads: [...], snapshots: [ids]}; UNWRAP .threads (it is not a bare array). v0.6.14: ?sort=recent (updatedAt DESC \u2014 the panel's latest-first view; unknown sort values 400)"],
        ["GET", `${API_BASE}/threads?storyId=<id>&status=<open|fixed|rejected|resolved>`, "filtered (an EMPTY storyId param is treated as absent, not a filter)"],
        ["POST", `${API_BASE}/threads`, "create \u2192 201; idempotent replay (same id) \u2192 200 with body.replayed=true + X-Annotakit-Replayed header. POST is create-only \u2014 amend via PATCH. A DELETED id is final \u2192 409 {deletedId:true} (delete-wins tombstones; use a new id)"],
        ["GET", `${API_BASE}/threads/<id>`, "one thread doc"],
        ["PATCH", `${API_BASE}/threads/<id>`, "partial {status} (JSON-merge) or full doc \u2014 see PATCH below"],
        ["POST", `${API_BASE}/threads/<id>/comments`, "reply \u2192 201 with the FULL updated thread doc (not the new comment); key comments by thread id, never by your own comment id (ids are re-hashed)"],
        ["DELETE", `${API_BASE}/threads/<id>`, 'delete (path form; legacy DELETE /threads?id=<id> equivalent) \u2014 broadcasts THREADS_CHANGED {reason:"deleted"} so live panels drop the row (v0.6.13, Task 42)'],
        ["GET|PUT|POST", `${API_BASE}/threads/<id>/snapshot`, 'plan-b DOM evidence \u2014 GET \u2192 JSON, GET ?format=html \u2192 human view; PUT/POST replaces (idempotent, 96KB cap) and broadcasts THREADS_CHANGED {reason:"snapshot"} so live panels re-fetch'],
        ["GET", `${API_BASE}/export?format=md|json`, "digest \u2014 json keeps FULL bodies (envelope {generatedAt, stories:[...]}, story-grouped, NOT the {threads:[...]} shape of GET /threads). md default is the LEAN digest (200-char clips for token economy); add ?mode=full for VERBATIM bodies (the panel export uses this \u2014 a hand-off artifact must never shorten a note)"],
        ["GET|POST", `${API_BASE}/sync`, 'mirror status / force reconcile \u2014 POST also forces one git store cycle first (v0.6.1); v0.6.13 (DD-12): POST CLEARS the rate-limit backoff window and per-thread retry parks before reconciling ("Sync now" means retry NOW) \u2014 the debounced tick still respects the window'],
        ["POST", `${API_BASE}/gh/reload`, "re-read .env and apply token changes WITHOUT a restart (v0.6.6) \u2014 response lists applied/requiresRestart; the PAT is never echoed"],
        ["POST", `${API_BASE}/gh`, "legacy alias of POST /sync (force reconcile)"]
      ],
      POST: {
        url: `${API_BASE}/threads`,
        body: THREAD_INPUT_EXAMPLE,
        note: 'body.id is the IDEMPOTENCY KEY: a replayed POST with the same id returns 200 (existing thread, flagged replayed:true \u2014 your new body does NOT land; amend via PATCH), a fresh id (or none) returns 201 \u2014 send a stable id (e.g. "fix-header-overflow") whenever a retry might replay the POST, or you mint duplicate threads. FINALITY: an id that was DELETEd stays deleted \u2014 POSTing it again 409s {deletedId:true}; a correction after a delete needs a NEW id. Server assigns per-capture numbers; comment ids are deterministically re-hashed server-side (your comment id may come back different \u2014 key by thread id). Threads without story.importPath render as bare digest sections (pass capture metadata \u2014 title/name + the capture file path \u2014 when you have it).'
      },
      PATCH: {
        url: `${API_BASE}/threads/<id>`,
        partialBody: { status: "resolved" },
        note: 'partial (JSON-merge) or full-document both accepted; status must be "open", "fixed", "rejected" or "resolved" (case-insensitive, normalized \u2014 anything else is a 400). "fixed" = addressed by the agent, awaiting reviewer verification (the agent Path B terminal state; the GitHub issue stays OPEN). "rejected" = the reviewer did NOT accept the fix (re-work expected; DURABLE \u2014 the verdict survives reloads; the GitHub issue stays OPEN and the server appends a system notice comment, the agent-visible re-work signal). "resolved" = reviewer-confirmed \u2014 server stamps resolvedAt on ANY \u2192resolved transition and clears it on demotion out of resolved; PATCHing "fixed" or "rejected" onto a resolved thread is a 400 (reopen first \u2014 a stale full-doc PATCH must never demote a confirmation); PATCHing "rejected" onto an OPEN thread is a 400 (reject is a verdict on a fix). From rejected: "fixed" (agent re-addresses \u2014 re-enters review), "resolved" (reviewer confirms after all), "open" (reviewer clears the verdict). comments always union-merge by id; comment bodies NEW or CHANGED by this PATCH are capped at 64000 chars (stored ones exempt). reopenedAt is server-owned (stamped on every downward transition, cleared on the next resolved \u2014 never send it)'
      },
      COMMENT: {
        url: `${API_BASE}/threads/<id>/comments`,
        body: { author: "agent", body: "fixed in abc123" },
        note: "returns the FULL updated thread doc (201), not the comment; comment bodies capped at 64000 chars. v0.6.16: idempotent retries \u2014 an identical author|body|createdAt POST replays (200 + replayed:true, no duplicate); a stable client-minted createdAt is the idempotency key"
      },
      DELETE: { url: `${API_BASE}/threads/<id>` },
      SNAPSHOT: {
        url: `${API_BASE}/threads/<id>/snapshot`,
        methods: ["GET", "PUT", "POST"],
        note: 'GET \u2192 JSON { html, clipped, capturedAt, width, height } (plan-b evidence: capture DOM at pin time, pinned element carries data-annota-snap="1"); GET ?format=html \u2192 human-viewable inert render (CSP script-src none; unknown format values \u2192 400); PUT/POST replaces (idempotent, 96KB cap measured in UTF-8 bytes)'
      },
      limits: { maxCommentBodyChars: MAX_BODY_CHARS, maxRequestBodyBytes: 2e6, maxSnapshotBytes: 96 * 1024 }
    });
    return true;
  }
  if (p === `${API_BASE}/health` && (method === "GET" || method === "HEAD")) {
    const ghSync = await rt.ghsync.status();
    const hasToken = Boolean(ghToken() || typeof rt.config.ghToken === "string" && rt.config.ghToken);
    const surfaces = {
      rest: true,
      digests: ["md", "json"],
      github: ghSync.mode === "auto",
      // v0.6.6 (F7/SR-C-02): 'github' above is presence-based (mode); this is
      // the OUTCOME-based signal — agents can stop committing to a mirror
      // whose token is rejected instead of waiting forever.
      githubAuth: ghSync.tokenState ?? (hasToken ? "unexercised" : "missing"),
      githubLabel: GH_LABEL,
      githubLabels: rt.ghLabels,
      ...ghSync.mode !== "auto" ? { githubReason: ghSync.mode === "off" ? "disabled (ANNOTAKIT_GH_AUTO=0 / ghAuto:false)" : !hasToken ? "no token" : "no repo" } : {},
      durability: rt.sync.durability()
    };
    const info = {
      ok: true,
      version: VERSION,
      bootedAt: BOOTED_AT,
      store: store.kind,
      storePath: store.storePath,
      storeMode: rt.sync.storeMode(),
      storeBranch: rt.sync.storeMode() === "git" ? rt.sync.storeBranch() : void 0,
      threads: await store.countThreads(),
      agentSurfaces: surfaces,
      gh: {
        repo: rt.repo,
        hasToken,
        tokenState: ghSync.tokenState ?? (hasToken ? "unexercised" : "missing"),
        lastAuthError: ghSync.lastAuthError ?? null,
        autoSync: rt.sync.describe(),
        ghSync,
        labels: rt.ghLabels
      },
      git: rt.sync.gitHealth(),
      ...rt.bootWarnings.length ? { warnings: rt.bootWarnings } : {}
    };
    if (method === "HEAD") {
      res.writeHead(200);
      res.end();
      return true;
    }
    sendJson(res, 200, info);
    return true;
  }
  if (p === `${API_BASE}/threads`) {
    if (method === "GET") {
      const threads = await store.listThreads({
        storyId: url.searchParams.get("storyId") ?? void 0,
        // H-A-12: the filter is case-exact in sqlite — normalize so
        // ?status=Open (an easy agent typo) matches like the PATCH normalizer
        status: parseStatusParam(url)
      });
      const sort = url.searchParams.get("sort")?.toLowerCase() || null;
      if (sort !== null && sort !== "recent") {
        throw Object.assign(new Error(`unknown sort ${JSON.stringify(sort)} \u2014 use ?sort=recent (updatedAt DESC, newest activity first; omit for the stable story/number order)`), { status: 400 });
      }
      const sorted = sort === "recent" ? [...threads].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? ""))) : threads;
      const snapshots = [...await store.listSnapshotIds()];
      sendJson(res, 200, { threads: sorted, snapshots });
      return true;
    }
    if (method === "POST") {
      const input = validateThreadInput(await readBody(req));
      if (input.id && (await store.listDeletedIds()).has(input.id)) {
        sendJson(res, 409, {
          error: `id ${input.id} was deleted \u2014 tombstones are final (delete-wins). POST with a new id.`,
          deletedId: true
        });
        return true;
      }
      const preexisting = input.id ? await store.getThread(input.id) : null;
      let thread;
      try {
        thread = await store.createThread(input);
      } catch (err) {
        if (err instanceof TombstonedIdError) {
          sendJson(res, 409, { error: err.message, deletedId: true });
          return true;
        }
        throw err;
      }
      warnUnknownStory(input.storyId, Boolean(input.story?.importPath));
      afterMutation(rt, { storyId: thread.storyId, threadId: thread.id, reason: "created" });
      await sendMutationJson(rt, res, preexisting ? 200 : 201, thread, { replayed: Boolean(preexisting) });
      return true;
    }
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) throw Object.assign(new Error("?id= required"), { status: 400 });
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res, THREAD_404_HINT), true;
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue, prev.gh.repo, prev.id);
      afterMutation(rt, { storyId: prev?.storyId, threadId: void 0, reason: "deleted" });
      sendJson(res, 200, { ok: true });
      return true;
    }
  }
  const threadMatch = p.match(new RegExp(`^${API_BASE}/threads/([^/]+)(/comments)?$`));
  if (threadMatch) {
    let id;
    try {
      id = decodeURIComponent(threadMatch[1] ?? "");
    } catch {
      throw Object.assign(new Error(`thread id is not valid percent-encoding (${JSON.stringify(threadMatch[1] ?? "")})`), { status: 400 });
    }
    const isComments = Boolean(threadMatch[2]);
    if (method === "DELETE" && !isComments) {
      const prev = await store.getThread(id);
      const ok = await store.deleteThread(id);
      if (!ok) return notFound(res, THREAD_404_HINT), true;
      if (prev?.gh?.issue) rt.ghsync.enqueueDelete(prev.gh.issue, prev.gh.repo, prev.id);
      afterMutation(rt, { storyId: prev?.storyId, threadId: void 0, reason: "deleted" });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === "GET" && !isComments) {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res, THREAD_404_HINT), true;
      sendJson(res, 200, thread);
      return true;
    }
    if (method === "PATCH" && !isComments) {
      const body = await readBody(req);
      const bodyId = body.id;
      if (bodyId !== void 0 && typeof bodyId !== "string") {
        throw Object.assign(new Error("body.id must be a string when provided"), { status: 400 });
      }
      if (typeof bodyId === "string" && bodyId !== id) {
        throw Object.assign(new Error("id mismatch between URL and body"), { status: 400 });
      }
      const prev = await store.getThread(id);
      if (!prev) return notFound(res, THREAD_404_HINT), true;
      const full = buildPatchCandidate(prev, body);
      if ("target" in body) validateTargetShape(full.target);
      if (full.status === void 0) full.status = prev.status;
      const prevIds = new Set(prev.comments.map((c) => c.id));
      for (const c of full.comments) {
        if (!c || typeof c !== "object" || Array.isArray(c)) {
          throw Object.assign(new Error("comments entries must be objects"), { status: 400 });
        }
        if (!prevIds.has(c.id)) normalizeComment(c);
      }
      if ("status" in body && full.status !== void 0) {
        const norm = String(full.status).toLowerCase();
        if (norm !== "open" && norm !== "fixed" && norm !== "rejected" && norm !== "resolved") {
          throw Object.assign(
            new Error(`status must be "open", "fixed", "rejected" or "resolved" (got ${JSON.stringify(full.status)}) \u2014 {"status":"fixed"} = addressed, awaiting review; {"status":"rejected"} = reviewer rejected the fix (re-work); {"status":"resolved"} = reviewer-confirmed (server stamps resolvedAt); {"status":"open"} reopens`),
            { status: 400 }
          );
        }
        full.status = norm;
      }
      if (prev.status === "resolved" && full.status === "fixed") {
        throw Object.assign(
          new Error('thread is resolved (reviewer-confirmed) \u2014 reopen to "open" first if you want it marked fixed'),
          { status: 400 }
        );
      }
      if (full.status === "rejected" && prev.status !== "fixed" && prev.status !== "rejected") {
        throw Object.assign(
          new Error(
            `reject applies to a fix \u2014 thread is ${prev.status} (reject is only valid from "fixed"${prev.status === "resolved" ? '; reopen to "open" first' : "; nothing to reject yet"})`
          ),
          { status: 400 }
        );
      }
      if (prev.status !== "resolved" && full.status === "resolved" && !full.resolvedAt) {
        full.resolvedAt = nowIso();
      }
      if (prev.status === "resolved" && full.status !== "resolved") {
        delete full.resolvedAt;
      }
      full.reopenedAt = prev.reopenedAt;
      if (STATUS_RANK[prev.status] > STATUS_RANK[full.status]) {
        full.reopenedAt = nowIso();
      }
      if (full.status === "resolved") {
        delete full.reopenedAt;
      }
      if (prev.gh) full.gh = prev.gh;
      else delete full.gh;
      full.ghUnlinkedAt = prev.ghUnlinkedAt;
      const prevByGhId = /* @__PURE__ */ new Map();
      for (const pc of prev.comments) {
        if (pc.ghId && pc.ghId !== "issue-body" && !prevByGhId.has(pc.ghId)) prevByGhId.set(pc.ghId, pc);
      }
      const consumedPrevIds = /* @__PURE__ */ new Set();
      for (const c of full.comments) {
        if (!c.ghId || c.ghId === "issue-body") continue;
        const twin = prevByGhId.get(c.ghId);
        if (twin && twin.id !== c.id) consumedPrevIds.add(twin.id);
      }
      const bodyIds = new Set(full.comments.map((c) => c.id));
      for (const pc of prev.comments) {
        if (!bodyIds.has(pc.id) && !consumedPrevIds.has(pc.id)) full.comments.push(pc);
      }
      for (const c of full.comments) {
        const pc = prev.comments.find((x) => x.id === c.id) ?? (c.ghId && c.ghId !== "issue-body" ? prevByGhId.get(c.ghId) : void 0);
        if (pc) {
          if (pc.ghId && !c.ghId) c.ghId = pc.ghId;
          if (pc.source && !c.source) c.source = pc.source;
        }
        if ((!pc || pc.body !== c.body) && typeof c.body !== "string") {
          throw Object.assign(new Error("comment body must be a string"), { status: 400 });
        }
        if ((!pc || pc.body !== c.body) && c.body.length > MAX_BODY_CHARS) {
          throw Object.assign(new Error(`comment body too large (max ${MAX_BODY_CHARS} chars \u2014 new/changed comments only; stored bodies are exempt)`), { status: 413 });
        }
      }
      const verdictAuthor = typeof body.statusAuthor === "string" && body.statusAuthor.trim() ? body.statusAuthor.trim() : "reviewer";
      delete full.statusAuthor;
      if (prev.status === "fixed" && full.status === "rejected") {
        const at = nowIso();
        full.comments.push({
          id: "c_" + crypto.createHash("sha256").update(`${verdictAuthor}|annotakit-rejected|${full.id}|${at}`).digest("base64url").slice(0, 12),
          author: verdictAuthor,
          body: `rejected \u2014 the fix was not accepted. Re-addressed fixes re-enter review.`,
          createdAt: at
        });
      } else if (prev.status === "rejected" && full.status === "open") {
        const at = nowIso();
        full.comments.push({
          id: "c_" + crypto.createHash("sha256").update(`${verdictAuthor}|annotakit-verdict-cleared|${full.id}|${at}`).digest("base64url").slice(0, 12),
          author: verdictAuthor,
          body: `verdict cleared \u2014 back to open.`,
          createdAt: at
        });
      }
      const updated = await store.updateThread(full);
      if (!updated) return notFound(res, THREAD_404_HINT), true;
      afterMutation(rt, {
        storyId: updated.storyId,
        threadId: updated.id,
        reason: prev.status === "open" && updated.status === "resolved" ? "resolved" : prev.status === "open" && updated.status === "fixed" ? "fixed" : prev.status === "fixed" && updated.status === "rejected" ? "rejected" : prev.status === "resolved" && updated.status === "open" ? "reopened" : "updated"
      });
      await sendMutationJson(rt, res, 200, updated);
      return true;
    }
    if (method === "POST" && isComments) {
      const body = await readBody(req);
      const thread = await store.getThread(id);
      if (!thread) return notFound(res, THREAD_404_HINT), true;
      const author = typeof body.author === "string" && body.author.trim() ? body.author.trim() : "anonymous";
      const commentBody = typeof body.body === "string" ? body.body : "";
      if (!commentBody.trim()) throw Object.assign(new Error("comment body is required"), { status: 400 });
      if (commentBody.length > MAX_BODY_CHARS) {
        throw Object.assign(new Error(`comment body too large (max ${MAX_BODY_CHARS} chars \u2014 keep evidence links instead of pasting whole logs)`), { status: 413 });
      }
      const comment = normalizeComment({
        id: "",
        author,
        body: commentBody,
        createdAt: typeof body.createdAt === "string" ? body.createdAt : nowIso()
      });
      const replay = thread.comments.some((c) => c.id === comment.id);
      if (!replay) thread.comments.push(comment);
      if (!replay) {
        const updated = await store.updateThread(thread);
        if (!updated) return notFound(res), true;
        afterMutation(rt, { storyId: updated.storyId, threadId: updated.id, reason: "commented" });
        await sendMutationJson(rt, res, 201, updated);
      } else {
        res.setHeader("X-Annotakit-Replayed", "1");
        await sendJson(res, 200, { ...thread, replayed: true });
      }
      return true;
    }
  }
  const snapMatch = p.match(new RegExp(`^${API_BASE}/threads/([^/]+)/snapshot$`));
  if (snapMatch) {
    let snapId;
    try {
      snapId = decodeURIComponent(snapMatch[1] ?? "");
    } catch {
      throw Object.assign(new Error(`thread id is not valid percent-encoding (${JSON.stringify(snapMatch[1] ?? "")})`), { status: 400 });
    }
    const id = snapId;
    if (method === "PUT" || method === "POST") {
      const thread = await store.getThread(id);
      if (!thread) return notFound(res), true;
      const body = await readBody(req);
      const html = typeof body.html === "string" ? body.html : "";
      if (!html.trim()) throw Object.assign(new Error("snapshot html is required"), { status: 400 });
      if (Buffer.byteLength(html, "utf8") > 96 * 1024) throw Object.assign(new Error("snapshot too large (max 96KB)"), { status: 413 });
      const sc = body.scroll;
      const scX = sc && typeof sc === "object" ? Number(sc.x) : NaN;
      const scY = sc && typeof sc === "object" ? Number(sc.y) : NaN;
      const snap = {
        format: "dom",
        html,
        clipped: body.clipped === true,
        capturedAt: typeof body.capturedAt === "string" ? body.capturedAt : nowIso(),
        // v0.6.16 (56-a P3-5): hostile dims (1e9 / negative) used to store
        // verbatim — the evidence page and the recall mounted a billion-px
        // layout. Clamp like the scroll fields below (scroll's ≥0 precedent).
        width: Math.max(0, Math.min(2e4, Math.round(Number(body.width)) || 800)),
        height: Math.max(0, Math.min(2e4, Math.round(Number(body.height)) || 600)),
        // v0.6.9 (S3): the frozen-container shape marker — additive; the
        // legacy story-root shape simply lacks it (old snapshots).
        surface: body.surface === "frozen" ? "frozen" : void 0,
        scroll: Number.isFinite(scX) && Number.isFinite(scY) ? { x: Math.max(0, Math.round(scX)), y: Math.max(0, Math.round(scY)) } : void 0
      };
      await store.putSnapshot(id, snap);
      broadcast({ storyId: thread.storyId, threadId: id, reason: "snapshot" });
      sendJson(res, 200, { ok: true, threadId: id, bytes: Buffer.byteLength(html, "utf8"), clipped: snap.clipped });
      return true;
    }
    if (method === "GET" || method === "HEAD") {
      const snap = await store.getSnapshot(id);
      if (!snap) return notFound(res, "this thread has no snapshot (plan-b evidence is optional \u2014 PUT one first, or check the thread doc)"), true;
      const fmt = url.searchParams.get("format");
      if (fmt !== null && fmt !== "html" && fmt !== "json") {
        throw Object.assign(new Error(`unknown format ${JSON.stringify(fmt)} \u2014 use ?format=html (human view) or omit for JSON`), { status: 400 });
      }
      if (fmt === "html") {
        const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const page = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'"><title>annotakit snapshot ${esc(id)}</title><style>html,body{margin:0}body{position:relative;width:${snap.width}px;min-height:${snap.height}px;background:#fff;overflow:hidden}[data-annota-snap]{outline:3px solid #d97706 !important;outline-offset:2px !important}</style></head><body>${snap.html}${snap.clipped ? '<div style="position:fixed;bottom:0;left:0;right:0;background:#451a03;color:#fdba74;font:600 12px sans-serif;padding:6px 10px">annotakit: snapshot clipped (capture exceeded the client size cap)</div>' : ""}</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(method === "HEAD" ? void 0 : page);
        return true;
      }
      if (method === "HEAD") {
        res.writeHead(200);
        res.end();
        return true;
      }
      sendJson(res, 200, { threadId: id, ...snap });
      return true;
    }
  }
  if (p === `${API_BASE}/export` && method === "GET") {
    const storyId = url.searchParams.get("storyId") ?? void 0;
    const status = parseStatusParam(url);
    const threads = await store.listThreads({ storyId, status });
    const stories = groupByStory(threads, origin);
    const snapshotIds = await store.listSnapshotIds();
    const format = (url.searchParams.get("format") ?? "md").toLowerCase();
    if (format !== "md" && format !== "json" && format !== "jsonl") {
      throw Object.assign(new Error(`unknown format ${JSON.stringify(format)} \u2014 use ?format=md (lean markdown digest) or ?format=json (full-fidelity bundle; jsonl is a json alias)`), { status: 400 });
    }
    if (format === "json" || format === "jsonl") {
      const bundle = { generatedAt: (/* @__PURE__ */ new Date()).toISOString(), exportUrl: `${origin}${API_BASE}/export`, stories };
      sendJson(res, 200, bundle);
      return true;
    }
    const mode = url.searchParams.get("mode")?.toLowerCase() ?? null;
    if (mode !== null && mode !== "lean" && mode !== "full") {
      throw Object.assign(new Error(`unknown mode ${JSON.stringify(mode)} \u2014 use ?mode=lean (default; clipped digest) or ?mode=full (verbatim bodies)`), { status: 400 });
    }
    const fullText = mode === "full";
    const md = renderDigest(stories, { origin, snapshotIds, fullText });
    res.writeHead(200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(md);
    return true;
  }
  if (p === `${API_BASE}/sync`) {
    if (method === "GET") {
      sendJson(res, 200, await rt.ghsync.status());
      return true;
    }
    if (method === "POST") {
      rt.ghsync.clearRateLimitBackoff();
      await rt.sync.restore().catch(() => void 0);
      const gitOk = await rt.sync.syncNow("api").catch(() => false);
      const summary = await rt.ghsync.syncAll();
      sendJson(res, 200, { ...summary, gitSync: rt.sync.gitHealth(), gitSyncForced: gitOk });
      return true;
    }
  }
  if (p === `${API_BASE}/gh/reload` && method === "POST") {
    const r = reloadDotEnv(configDir2);
    const st = await rt.ghsync.status();
    sendJson(res, 200, {
      ok: true,
      file: r.file,
      applied: r.changed,
      // keys whose NEW value is now live in process.env
      removed: r.removed,
      tokenChanged: r.tokenChanged,
      // repo/labels/poll/interval/auto are boot-captured — a change needs a restart
      requiresRestart: r.requiresRestart,
      tokenState: st.tokenState,
      mode: st.mode
    });
    return true;
  }
  if (p === `${API_BASE}/gh` && method === "POST") {
    await rt.sync.restore().catch(() => void 0);
    rt.ghsync.clearRateLimitBackoff();
    const gitOk = await rt.sync.syncNow("api").catch(() => false);
    const summary = await rt.ghsync.syncAll();
    sendJson(res, 200, {
      ...summary,
      gitSync: rt.sync.gitHealth(),
      gitSyncForced: gitOk,
      note: "digest issues are gone: each thread mirrors to exactly ONE issue now. POST /annotakit/api/sync is the canonical force-reconcile; this alias behaves identically (clears the rate-limit window, restore settle + forced git cycle + mirror reconcile)."
    });
    return true;
  }
  return false;
}
var KNOWN_API_ROUTES = [
  [new RegExp(`^${API_BASE}/health$`), "GET, HEAD, OPTIONS"],
  [new RegExp(`^${API_BASE}/schema$`), "GET, HEAD, OPTIONS"],
  [new RegExp(`^${API_BASE}/threads$`), "GET, POST, DELETE, OPTIONS"],
  [new RegExp(`^${API_BASE}/threads/[^/]+$`), "GET, PATCH, DELETE, OPTIONS"],
  [new RegExp(`^${API_BASE}/threads/[^/]+/comments$`), "POST, OPTIONS"],
  // v0.6.7 (audit 24-b P3): the snapshot endpoint was missing — unsupported
  // methods on a documented route 404'd as "unknown route" instead of 405+Allow
  // (S9: POST added — the route handler accepts PUT || POST; /schema agrees)
  [new RegExp(`^${API_BASE}/threads/[^/]+/snapshot$`), "GET, PUT, POST, OPTIONS"],
  [new RegExp(`^${API_BASE}/export$`), "GET, OPTIONS"],
  [new RegExp(`^${API_BASE}/sync$`), "GET, POST, OPTIONS"],
  [new RegExp(`^${API_BASE}/gh$`), "POST, OPTIONS"],
  [new RegExp(`^${API_BASE}/gh/reload$`), "POST, OPTIONS"]
];
function resolveNotHandled(res, pathname) {
  for (const [re, allow] of KNOWN_API_ROUTES) {
    if (re.test(pathname)) {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", Allow: allow, "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: `method not allowed (Allow: ${allow})` }));
      return;
    }
  }
  notFound(res, ROUTE_404_HINT);
}
function createMiddleware(configDir2) {
  return (req, res, next) => {
    const urlStr = req.url ?? "";
    if (!urlStr.startsWith("/annotakit/")) {
      next?.();
      return;
    }
    const origin = `http://${req.headers.host ?? "localhost:6006"}`;
    const rt = runtime;
    let url;
    try {
      url = new URL(urlStr, origin);
    } catch {
      sendJson(res, 400, { error: "bad url" });
      return;
    }
    if (url.pathname === "/annotakit/" || url.pathname === "/annotakit") {
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!enforceApiAccess(req, res)) return;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`storybook-annotakit ${VERSION} \u2014 API at ${API_BASE}/* (health, threads, export, gh)`);
      return;
    }
    if (url.pathname.startsWith(API_BASE)) {
      if (url.pathname.length > API_BASE.length + 1 && url.pathname.endsWith("/")) {
        try {
          url.pathname = url.pathname.replace(/\/+$/, "");
        } catch {
        }
      }
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!enforceApiAccess(req, res)) return;
      if (rt) rt.origin = origin;
      handleApi(req, res, url, configDir2, origin).then(
        (handled) => {
          if (!handled) resolveNotHandled(res, url.pathname);
        },
        (err) => fail(res, err)
      );
      return;
    }
    next?.();
  };
}
function serverChannelHook(channel2) {
  setChannelEmitter((event, payload) => {
    try {
      channel2.emit(event, payload);
    } catch {
    }
  });
}
function devServerHook(app, options) {
  const configDir2 = options?.configDir ?? process.env.STORYBOOK_CONFIG_DIR ?? ".storybook";
  const port = typeof options?.port === "number" ? options.port : void 0;
  bootstrap(configDir2, port);
  const middleware = createMiddleware(configDir2);
  app.use(middleware);
}

// src/host/capture-id.ts
function captureIdOf(relpath) {
  const noExt = relpath.replace(/\.[^./\\]+$/, "");
  return noExt.replace(/[^a-zA-Z0-9-]/g, "-");
}
function captureName(relpath) {
  const base = relpath.replace(/^.*[/\\]/, "");
  return base.replace(/\.(html?|htm)$/i, "");
}

// src/shared/bakedCreds.ts
var BAKED_GH_TOKEN = "";
var BAKED_PROJECT_TARGET = "";

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
function specTitleExcerpt(body, fallback, maxLen = 80) {
  const { cleaned } = parseSpecDirectives(body);
  const flat = cleaned.replace(/\s+/g, " ").trim();
  const base = flat || fallback;
  return base.length > maxLen ? `${base.slice(0, maxLen - 1).trimEnd()}\u2026` : base;
}

// src/shared/ghProjects.ts
function parseProjectTarget(v) {
  const m = v.match(/(?:^|github\.com\/)(users|orgs)\/([A-Za-z0-9_.-]+)\/projects\/(\d+)\/?$/);
  if (!m) return null;
  return { kind: m[1] === "orgs" ? "org" : "user", login: m[2], number: Number(m[3]) };
}
var MARKER_PREFIX = "<!-- dom-annotakit:thread=";
var THREAD_ID_RE = /^(th_[A-Za-z0-9_]+|singlefile-[A-Za-z0-9_-]+)$/;
function markerFor(threadId) {
  return `${MARKER_PREFIX}${threadId}-->`;
}
function parseMarker(body) {
  if (!body || !body.startsWith(MARKER_PREFIX)) return null;
  const end = body.indexOf("-->", MARKER_PREFIX.length);
  if (end < 0 || !body.startsWith("-->\n\n", end)) return null;
  const id = body.slice(MARKER_PREFIX.length, end);
  return THREAD_ID_RE.test(id) ? id : null;
}
var GRAPHQL_ENDPOINT = "https://api.github.com/graphql";
var FETCH_TIMEOUT_MS2 = 15e3;
function makeGql(token) {
  return async (query, variables = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS2);
    try {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal
      });
      const json = await res.json().catch(() => null);
      if (!json) throw new Error(`GitHub API ${res.status}: unparseable response`);
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; ").slice(0, 400));
      return { data: json.data };
    } finally {
      clearTimeout(timer);
    }
  };
}
var FIELD_EPIC = "Epic";
var FIELD_STORY = "Story";
var FIELD_CAPTURE = "Capture";
var FIELD_ANCHOR = "DOM anchor";
var OPTION_COLORS = ["BLUE", "GREEN", "PURPLE", "ORANGE", "PINK", "RED", "YELLOW", "GRAY"];
function optionColorFor(name) {
  let h = 0;
  for (const ch of name) h = h * 31 + ch.charCodeAt(0) >>> 0;
  return OPTION_COLORS[h % OPTION_COLORS.length];
}
var PROJECT_FIELDS_QUERY = `
  id title url
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color description } }
    }
  }`;
var ITEMS_PAGE_QUERY = `
  items(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      createdAt
      content {
        __typename
        ... on DraftIssue { id title body }
      }
      fieldValues(first: 30) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
          ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
        }
      }
    }
  }`;
async function loadBoard(gql, target) {
  const ownerQuery = target.kind === "user" ? `query($login: String!, $n: Int!) { user(login: $login) { projectV2(number: $n) { ${PROJECT_FIELDS_QUERY} } } }` : `query($login: String!, $n: Int!) { organization(login: $login) { projectV2(number: $n) { ${PROJECT_FIELDS_QUERY} } } }`;
  const owner = await gql(ownerQuery, { login: target.login, n: target.number });
  const project = owner.data?.[target.kind === "user" ? "user" : "organization"]?.projectV2;
  if (!project || typeof project !== "object") throw new Error(`project not found: ${target.login} #${target.number}`);
  const fields = project.fields?.nodes ?? [];
  const projectId = project.id;
  const items = [];
  let cursor = null;
  for (; ; ) {
    const pageQuery = `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { ${ITEMS_PAGE_QUERY} } } }`;
    const r = await gql(pageQuery, { id: projectId, cursor });
    const node = r.data.node;
    const conn = node?.items;
    for (const raw of conn?.nodes ?? []) {
      const it = raw;
      const selects = {};
      const texts = {};
      for (const fv of it.fieldValues?.nodes ?? []) {
        if (fv?.field?.name) {
          if (typeof fv.name === "string") selects[fv.field.name] = fv.name;
          else if (typeof fv.text === "string") texts[fv.field.name] = fv.text;
        }
      }
      const isDraft = it.content?.__typename === "DraftIssue";
      items.push({
        itemId: it.id,
        createdAt: it.createdAt,
        draftId: isDraft ? it.content?.id ?? null : null,
        title: isDraft ? it.content?.title ?? null : null,
        body: isDraft ? it.content?.body ?? null : null,
        selects,
        texts,
        threadId: isDraft ? parseMarker(it.content?.body) : null
      });
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { projectId, title: project.title ?? "", url: project.url ?? "", fields, items };
}
function anchorSummary(t) {
  const ctx = t.target?.context;
  const sel = t.target?.selector;
  const tag = ctx?.tag ?? "";
  const idPart = ctx?.id ? `#${ctx.id}` : "";
  const text = (ctx?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  const selPart = (sel?.cssSelector ? String(sel.cssSelector) : "").slice(0, 80) || `${tag}${idPart}`.trim();
  return text ? `${selPart} \u2014 \u201C${text}\u201D` : selPart;
}
function buildDesiredItem(thread, captureName2, publicUrl) {
  const comments = thread.comments ?? [];
  const bodies = comments.map((c) => String(c.body ?? ""));
  const d = threadSpecDirectives(bodies);
  const capture = captureName2 ?? thread.story?.name ?? thread.storyId;
  const title = specTitleExcerpt(bodies[0] ?? "", `[pin] ${capture}`);
  const header = [];
  if (d.epic || d.story) {
    const bits = [];
    if (d.epic) bits.push(`**Epic:** ${d.epic}`);
    if (d.story) bits.push(`**Story:** ${d.story}`);
    header.push(bits.join(" \xB7 "));
  }
  header.push(`**Capture:** ${capture}`);
  header.push(`**Status:** ${thread.status}`);
  const anchor = anchorSummary(thread);
  header.push(`**DOM anchor:** \`${anchor}\``);
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      u.searchParams.set("capture", thread.storyId);
      header.push(`**Spec source:** [open in dom-annotakit](${u.href})`);
    } catch {
    }
  }
  const lines = comments.map((c, i) => {
    const cleaned = String(c.body ?? "").trim();
    return `${i + 1}. **${c.author}** \u2014 ${cleaned}`;
  });
  const body = [
    markerFor(thread.id),
    "",
    ...header,
    "",
    "## Directives",
    ...lines.length ? lines : ["_(no comments)_"]
  ].join("\n");
  return { threadId: thread.id, title, body, epic: d.epic, story: d.story, capture, anchor };
}
async function ensureField(gql, projectId, name, dataType) {
  const r = await gql(
    `mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }`,
    { input: { projectId, dataType, name, ...dataType === "SINGLE_SELECT" ? { singleSelectOptions: [{ name: "General", color: "GRAY", description: "default bucket \u2014 rename or delete in the board UI" }] } : {} } }
  );
  const f = r.data.createProjectV2Field?.projectV2Field;
  if (!f?.id) throw new Error(`field create failed: ${name}`);
  return { ...f, options: dataType === "SINGLE_SELECT" ? [] : void 0 };
}
async function ensureOptions(gql, field, names, projectId) {
  const byName = new Map((field.options ?? []).map((o) => [o.name, o.id]));
  const missing = [...new Set(names)].filter((n) => !byName.has(n));
  if (missing.length > 0) {
    const fresh = await gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2SingleSelectField { options { id name color description } } } }`, { id: field.id });
    const freshOpts = fresh.data.node?.options ?? [] ?? [];
    const stillMissing = missing.filter((n) => !freshOpts.some((o) => o.name === n));
    if (stillMissing.length > 0) {
      const replace = [
        ...freshOpts.map((o) => ({ id: o.id, name: o.name, color: o.color || "GRAY", description: o.description ?? "" })),
        ...stillMissing.map((n) => ({ name: n, color: optionColorFor(n), description: "" }))
      ];
      const w = await gql(
        `mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`,
        { input: { fieldId: field.id, singleSelectOptions: replace } }
      );
      const written = w.data.updateProjectV2Field?.projectV2Field?.options ?? [];
      for (const o of written) byName.set(o.name, o.id);
    } else {
      for (const o of freshOpts) byName.set(o.name, o.id);
    }
  }
  return byName;
}
async function createItem(gql, projectId, want, optIds, fieldIds) {
  const r = await gql(
    `mutation($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id content { ... on DraftIssue { id } } } } }`,
    { input: { projectId, title: want.title, body: want.body } }
  );
  const item = r.data.addProjectV2DraftIssue?.projectItem;
  if (!item?.id || !item.content?.id) throw new Error(`draft item create failed for ${want.threadId}`);
  const sets = [];
  const setField = (fieldId, value) => gql(
    `mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
    { input: { projectId, itemId: item.id, fieldId, value } }
  );
  if (want.epic) {
    const oid = optIds.epic?.get(want.epic);
    if (oid) sets.push(setField(fieldIds.epic, { singleSelectOptionId: oid }));
  }
  if (want.story) {
    const oid = optIds.story?.get(want.story);
    if (oid) sets.push(setField(fieldIds.story, { singleSelectOptionId: oid }));
  }
  if (want.capture) sets.push(setField(fieldIds.capture, { text: want.capture }));
  if (want.anchor) sets.push(setField(fieldIds.anchor, { text: want.anchor }));
  await Promise.all(sets);
}
async function updateItem(gql, projectId, item, want, optIds, fieldIds) {
  if (!item.draftId) return false;
  let wrote = false;
  if (item.title !== want.title || item.body !== want.body) {
    await gql(
      `mutation($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id } } }`,
      { input: { draftIssueId: item.draftId, title: want.title, body: want.body } }
    );
    wrote = true;
  }
  const setField = (fieldId, value) => gql(
    `mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
    { input: { projectId, itemId: item.itemId, fieldId, value } }
  );
  const clearField = (fieldId) => gql(
    `mutation($input: ClearProjectV2ItemFieldValueInput!) { clearProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
    { input: { projectId, itemId: item.itemId, fieldId } }
  );
  if ((item.selects[FIELD_EPIC] ?? null) !== (want.epic ?? null)) {
    if (want.epic) {
      const oid = optIds.epic?.get(want.epic);
      if (oid) {
        await setField(fieldIds.epic, { singleSelectOptionId: oid });
        wrote = true;
      }
    } else {
      await clearField(fieldIds.epic);
      wrote = true;
    }
  }
  if ((item.selects[FIELD_STORY] ?? null) !== (want.story ?? null)) {
    if (want.story) {
      const oid = optIds.story?.get(want.story);
      if (oid) {
        await setField(fieldIds.story, { singleSelectOptionId: oid });
        wrote = true;
      }
    } else {
      await clearField(fieldIds.story);
      wrote = true;
    }
  }
  if ((item.texts[FIELD_CAPTURE] ?? null) !== (want.capture ?? null)) {
    await setField(fieldIds.capture, { text: want.capture });
    wrote = true;
  }
  if ((item.texts[FIELD_ANCHOR] ?? null) !== (want.anchor ?? null)) {
    await setField(fieldIds.anchor, { text: want.anchor });
    wrote = true;
  }
  return wrote;
}
async function deleteItem(gql, projectId, itemId) {
  await gql(
    `mutation($input: DeleteProjectV2ItemInput!) { deleteProjectV2Item(input: $input) { clientMutationId } }`,
    { input: { projectId, itemId } }
  );
}
function boardCatalog(view) {
  const epicField = view.fields.find((f) => f.name === FIELD_EPIC);
  const storyField = view.fields.find((f) => f.name === FIELD_STORY);
  const edges = /* @__PURE__ */ new Map();
  for (const it of view.items) {
    const e = it.selects[FIELD_EPIC];
    const s = it.selects[FIELD_STORY];
    if (e && s) {
      const set = edges.get(s) ?? /* @__PURE__ */ new Set();
      set.add(e);
      edges.set(s, set);
    }
  }
  const stories = (storyField?.options ?? []).map((o) => ({
    name: o.name,
    epics: [...edges.get(o.name) ?? []].sort()
  }));
  return {
    epics: (epicField?.options ?? []).map((o) => o.name).sort(),
    stories,
    captures: {}
    // board items carry no capture rollup — the store owns it
  };
}
async function reconcileProject(deps) {
  const log = deps.log ?? (() => void 0);
  const board = await loadBoard(deps.gql, deps.config.target);
  const byName = new Map(board.fields.map((f) => [f.name, f]));
  const epicF = byName.get(FIELD_EPIC) ?? await ensureField(deps.gql, board.projectId, FIELD_EPIC, "SINGLE_SELECT");
  const storyF = byName.get(FIELD_STORY) ?? await ensureField(deps.gql, board.projectId, FIELD_STORY, "SINGLE_SELECT");
  const captureF = byName.get(FIELD_CAPTURE) ?? await ensureField(deps.gql, board.projectId, FIELD_CAPTURE, "TEXT");
  const anchorF = byName.get(FIELD_ANCHOR) ?? await ensureField(deps.gql, board.projectId, FIELD_ANCHOR, "TEXT");
  const fieldIds = { epic: epicF.id, story: storyF.id, capture: captureF.id, anchor: anchorF.id };
  const claimed = /* @__PURE__ */ new Map();
  const extras = [];
  const byThread = /* @__PURE__ */ new Map();
  for (const it of board.items) {
    if (!it.threadId) continue;
    (byThread.get(it.threadId) ?? byThread.set(it.threadId, []).get(it.threadId)).push(it);
  }
  for (const [tid, group] of byThread) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    claimed.set(tid, group[0]);
    extras.push(...group.slice(1));
  }
  const threads = await deps.listThreads();
  const deletedIds = await deps.listDeletedIds();
  const desired = /* @__PURE__ */ new Map();
  let skipped = 0;
  for (const t of threads) {
    if (!THREAD_ID_RE.test(t.id)) {
      skipped++;
      continue;
    }
    desired.set(t.id, buildDesiredItem(t, deps.captureName(t.storyId), deps.config.publicUrl));
  }
  const epicNames = [...desired.values()].map((w) => w.epic).filter((v) => !!v);
  const storyNames = [...desired.values()].map((w) => w.story).filter((v) => !!v);
  const [epicIds, storyIds] = await Promise.all([
    ensureOptions(deps.gql, epicF, epicNames, board.projectId),
    ensureOptions(deps.gql, storyF, storyNames, board.projectId)
  ]);
  let created = 0;
  let updated = 0;
  for (const [tid, want] of desired) {
    const cur = claimed.get(tid);
    try {
      if (!cur) {
        await createItem(deps.gql, board.projectId, want, { epic: epicIds, story: storyIds }, fieldIds);
        created++;
      } else {
        if (await updateItem(deps.gql, board.projectId, cur, want, { epic: epicIds, story: storyIds }, fieldIds)) updated++;
      }
    } catch (err) {
      log(`project-sync: thread ${tid} failed:`, err instanceof Error ? err.message : err);
    }
  }
  let deleted = 0;
  let culled = 0;
  for (const [tid, item] of claimed) {
    if (deletedIds.has(tid)) {
      try {
        await deleteItem(deps.gql, board.projectId, item.itemId);
        deleted++;
      } catch (err) {
        log(`project-sync: delete of ${tid} failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
  for (const extra of extras) {
    try {
      await deleteItem(deps.gql, board.projectId, extra.itemId);
      culled++;
    } catch (err) {
      log("project-sync: duplicate cull failed:", err instanceof Error ? err.message : err);
    }
  }
  const res = {
    threads: desired.size,
    items: board.items.length,
    created,
    updated,
    deleted,
    culled,
    skipped,
    projectUrl: board.url,
    projectTitle: board.title,
    catalog: boardCatalog(board)
  };
  log(`project-sync: +${created} ~${updated} -${deleted} (culled ${culled}) \u2014 ${res.threads}/${threads.length} threads, ${res.items} board items`);
  return res;
}

// src/server/projectMirror.ts
var RECOVERY = 'rotate ANNOTAKIT_GH_TOKEN in the shell environment (or annotakit.config.json "project.token") and restart the server \u2014 a baked-backed token cannot be rotated through .env + POST /gh/reload';
function startProjectMirror(opts) {
  const log = opts.log ?? ((...a) => console.log("[dom-annotakit]", ...a));
  const rawConfig = readConfig(opts.configDir);
  const project = rawConfig.project ?? null;
  const issuesDisarmed = rawConfig.ghAuto === false;
  const targetRaw = typeof project?.target === "string" && project.target.trim() ? project.target.trim() : process.env.ANNOTAKIT_PROJECT_URL || BAKED_PROJECT_TARGET;
  const target = targetRaw ? parseProjectTarget(targetRaw) : null;
  const token = process.env.ANNOTAKIT_GH_TOKEN || (typeof project?.token === "string" && project.token.trim() ? project.token.trim() : "") || BAKED_GH_TOKEN;
  const auto = project?.auto !== false;
  const resolvePublicUrl = () => {
    if (typeof project?.publicUrl === "string" && project.publicUrl.trim()) {
      return project.publicUrl.trim().replace(/\/+$/, "");
    }
    const host = opts.publicHost();
    return host ? `https://${host}` : `http://localhost:${opts.port}`;
  };
  let status = {
    state: "dormant",
    reason: null,
    target: targetRaw || null,
    projectTitle: null,
    projectUrl: null,
    threads: 0,
    items: 0,
    lastSyncAt: null,
    lastError: null,
    writer: "serve",
    recovery: RECOVERY,
    issuesDisarmed
  };
  let lastCatalog = null;
  const config = target && token ? { target, token } : null;
  if (!auto) {
    status = { ...status, state: "dormant", reason: "project.auto is false \u2014 the board mirror is switched off in annotakit.config.json" };
    log("project-sync: dormant (project.auto false)");
  } else if (!target) {
    status = { ...status, state: "dormant", reason: `no valid project target \u2014 set "project.target" in annotakit.config.json (got ${JSON.stringify(targetRaw ?? null)})` };
    log("project-sync: dormant (no valid target)");
  } else if (!token) {
    status = { ...status, state: "dormant", reason: "no GH token (env ANNOTAKIT_GH_TOKEN / config project.token / baked default)" };
    log("project-sync: dormant (no token)");
  }
  let store = null;
  let storeError = null;
  const getStoreSafe = () => {
    if (store) return store;
    if (storeError) return null;
    try {
      const gitFlowOn = rawConfig.autoSync !== false;
      const loc = storeLocation(opts.configDir, { forceClassic: !gitFlowOn });
      store = getStore(opts.configDir, { dataDir: loc.dir });
      return store;
    } catch (err) {
      storeError = err instanceof Error ? err.message : String(err);
      status = { ...status, state: "error", reason: `store unavailable: ${storeError}`, lastError: storeError };
      log("project-sync: store unavailable \u2014 mirror dormant:", storeError);
      return null;
    }
  };
  let chain = Promise.resolve();
  let pendingTimer = null;
  const runPass = (why) => {
    const st = getStoreSafe();
    if (!config || !st) {
      return Promise.resolve(null);
    }
    const store2 = st;
    const pass = chain.then(async () => {
      try {
        const result = await reconcileProject({
          gql: makeGql(config.token),
          config: { ...config, publicUrl: resolvePublicUrl() },
          listThreads: () => store2.listThreads(),
          listDeletedIds: () => store2.listDeletedIds(),
          captureName: opts.resolveCaptureName,
          log
        });
        status = {
          ...status,
          state: "ok",
          reason: null,
          projectTitle: result.projectTitle,
          projectUrl: result.projectUrl,
          threads: result.threads,
          items: result.items,
          lastSyncAt: (/* @__PURE__ */ new Date()).toISOString(),
          lastError: null,
          writer: "serve",
          recovery: RECOVERY
        };
        lastCatalog = result.catalog;
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        status = { ...status, state: "error", lastError: msg, reason: msg, lastSyncAt: status.lastSyncAt };
        log(`project-sync: FAILED (${why}):`, msg);
        return null;
      }
    });
    chain = pass.then(() => void 0, () => void 0);
    return pass;
  };
  const trigger = (why, delayMs) => {
    if (!config || !auto) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      void runPass(why);
    }, delayMs);
    pendingTimer.unref?.();
  };
  if (config && auto) {
    trigger("boot", 6e3);
    opts.channel.on(THREADS_CHANGED, (...args) => {
      const payload = args[0];
      if (payload?.reason === "restored") trigger("restored", 1e3);
      else trigger("threads-changed", 5e3);
    });
    const sweep = setInterval(() => {
      void runPass("hourly-sweep");
    }, 60 * 60 * 1e3);
    sweep.unref?.();
  }
  return {
    status: () => ({ ...status }),
    trigger: () => trigger("manual", 0),
    reconcile: () => config && auto ? runPass("forced") : Promise.resolve(null),
    catalog: () => lastCatalog,
    issuesMirrorDisarmed: () => issuesDisarmed
  };
}

// src/shared/specCatalog.ts
var collator = new Intl.Collator(void 0, { sensitivity: "base" });
function specNameCompare(a, b) {
  return collator.compare(a, b);
}
function buildSpecIndex(threads) {
  const epicSet = /* @__PURE__ */ new Set();
  const storyMap = /* @__PURE__ */ new Map();
  const captures2 = {};
  for (const t of threads) {
    const bodies = (t.comments ?? []).map((c) => String(c.body ?? ""));
    const d = threadSpecDirectives(bodies);
    const roll = captures2[t.storyId] ??= { epics: {}, stories: {}, pairs: {} };
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
  return { epics: [...epicSet].sort(specNameCompare), stories, captures: captures2 };
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
    return { dir: path2__default.default.resolve(env.DOM_AK_CAPTURES_DIR.trim()), recursive, source: "env" };
  }
  if (typeof section?.dir === "string" && section.dir.trim()) {
    const dir = path2__default.default.resolve(opts.repoRoot, section.dir.trim());
    return { dir, recursive, source: "config" };
  }
  return { dir: path2__default.default.resolve(opts.cwd), recursive, source: "default-cwd" };
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
    entries = fs3__default.default.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (recursive && !RECURSIVE_DENY.has(e.name)) out.push(...listCaptures(path2__default.default.join(dir, e.name), recursive, relPath));
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
    const fd = fs3__default.default.openSync(abs, "r");
    try {
      const buf = Buffer.alloc(HEAD_SCAN_BYTES);
      const n = fs3__default.default.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString("utf8");
    } finally {
      fs3__default.default.closeSync(fd);
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
function discoverGitWorkdir(capturesDir2) {
  try {
    const top = child_process.execFileSync("git", ["-C", capturesDir2, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5e3 }).trim();
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
      return fs3__default.default.statSync(cfg.dir).mtimeMs;
    } catch {
      return 0;
    }
  };
  const dirFingerprint = () => {
    const bits = [];
    for (const relpath of listCaptures(cfg.dir, cfg.recursive)) {
      let st;
      try {
        st = fs3__default.default.statSync(path2__default.default.join(cfg.dir, relpath));
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
      const abs = path2__default.default.join(cfg.dir, relpath);
      let size = 0;
      try {
        size = fs3__default.default.statSync(abs).size;
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
  const upload = async (name, content, overwrite, git2) => {
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
    const abs = path2__default.default.join(cfg.dir, clean);
    if (path2__default.default.dirname(abs) !== cfg.dir) return { ok: false, status: 400, error: "bad capture name" };
    if (!overwrite && fs3__default.default.existsSync(abs)) return { ok: false, status: 409, error: `a capture named '${clean}' already exists (send overwrite:true to replace it)`, existing: true };
    const wantId = deps.captureId(clean);
    const built0 = buildManifest();
    if (built0.ok) {
      const clashRel = built0.json.captures.find((c) => c.id === wantId && c.relpath !== clean)?.relpath;
      if (clashRel) return { ok: false, status: 409, error: `capture id collision \u2014 '${clean}' and '${clashRel}' both map to id '${wantId}'. Rename one (rename = new identity).`, existing: false };
    }
    fs3__default.default.writeFileSync(abs, content, "utf8");
    invalidate();
    const entry = { id: deps.captureId(clean), relpath: clean, size: bytes, ...scanHead(abs) };
    let durability = "file written (no git repo \u2014 not backed up)";
    const g = git2 ?? discoverGitWorkdir(cfg.dir);
    if (g.toplevel) {
      const rel = path2__default.default.relative(g.toplevel, abs);
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
  let current2 = {};
  const INVALID = /* @__PURE__ */ Symbol("invalid");
  const clean = (v) => {
    if (v == null) return null;
    if (typeof v !== "string") return INVALID;
    const t = v.trim().replace(/\s+/g, " ");
    return t ? t.slice(0, 60) : null;
  };
  return {
    get: () => ({ ...current2 }),
    /* FULL-SNAPSHOT semantics: the PUT carries BOTH keys (the combobox
     * sends the whole selection); an ABSENT key clears it (null-equivalent).
     * A present-but-non-string value rejects the whole PUT. */
    set(ctx) {
      const epic = clean(ctx.epic);
      const story = clean(ctx.story);
      if (epic === INVALID || story === INVALID) throw new Error("context values must be strings or null");
      current2 = {
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
function sendJson2(res, status, payload) {
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
    void specCatalogPayload(deps).then((payload) => sendJson2(res, 200, payload)).catch((e) => {
      log("spec catalog failed:", e instanceof Error ? e.message : String(e));
      sendJson2(res, 500, { error: "spec catalog unavailable" });
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
        sendJson2(res, read.status, { error: read.error });
        return;
      }
      try {
        deps.specContext.set(read.body);
      } catch (e) {
        sendJson2(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return;
      }
      sendJson2(res, 200, { ok: true, context: deps.specContext.get() });
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
        sendJson2(res, read.status, { error: read.error });
        return;
      }
      const name = typeof read.body.name === "string" ? read.body.name : "";
      const content = typeof read.body.content === "string" ? read.body.content : "";
      const overwrite = read.body.overwrite === true;
      const r = await deps.captures.upload(name, content, overwrite);
      if (r.ok) {
        log(`captures: uploaded ${r.entry.relpath} (${r.durability})`);
        sendJson2(res, 200, r);
      } else {
        sendJson2(res, r.status, r);
      }
    })();
    return true;
  }
  if (pathname === "/dom-annotakit-project.json" && method === "POST") {
    void (async () => {
      const read = await readJson(req);
      if (!read.ok) {
        sendJson2(res, read.status, { error: read.error });
        return;
      }
      if (read.body.action !== "pass") {
        sendJson2(res, 400, { error: `unknown action ${JSON.stringify(read.body.action ?? null)} \u2014 {"action":"pass"} forces a mirror reconcile` });
        return;
      }
      try {
        await deps.mirror.reconcile();
      } catch (e) {
        log("project pass failed:", e);
      }
      sendJson2(res, 200, deps.mirror.status());
    })();
    return true;
  }
  return false;
}

// src/server/standalone.ts
var PORT = Number.parseInt(process.env.PORT ?? "", 10) || 4310;
var repoRoot = path2__default.default.resolve(__dirname, "..");
var configDir = path2__default.default.join(repoRoot, ".dom-annotakit");
fs3__default.default.mkdirSync(configDir, { recursive: true });
var capturesCfg = resolveCapturesDir(readConfig(configDir), { repoRoot, cwd: process.cwd() });
var captures = createCapturesManager(capturesCfg, {
  captureId: captureIdOf,
  log: (...a) => console.log("[dom-annotakit]", ...a)
});
var capturesDir = captures.dir;
var appDir = path2__default.default.join(repoRoot, "dist-app");
var layerFile = path2__default.default.join(repoRoot, "dist", "layer.mjs");
var specContext = createSpecContextStore();
var booted = false;
var apiHandler = null;
var shimApp = {
  use(fn) {
    apiHandler = fn;
  }
};
function bootEngine() {
  if (booted) return;
  booted = true;
  devServerHook(shimApp, { configDir, port: PORT });
}
{
  let envFileHasToken = false;
  for (const p of [path2__default.default.join(repoRoot, ".env"), path2__default.default.join(configDir, ".env"), path2__default.default.resolve(process.cwd(), ".env")]) {
    try {
      if (!fs3__default.default.existsSync(p)) continue;
      if (parseDotEnv(fs3__default.default.readFileSync(p, "utf8")).ANNOTAKIT_GH_TOKEN) {
        envFileHasToken = true;
        console.log(`[dom-annotakit] .env at ${p} carries ANNOTAKIT_GH_TOKEN \u2014 the vendored .env loader owns it (rotation via .env + POST /gh/reload works)`);
        break;
      }
    } catch {
    }
  }
  if (!envFileHasToken && !process.env.ANNOTAKIT_GH_TOKEN && BAKED_GH_TOKEN) ;
}
var channel = new events.EventEmitter();
serverChannelHook(channel);
channel.on(THREADS_CHANGED, (payload) => {
  console.log(`[dom-annotakit] threads changed: ${JSON.stringify(payload)}`);
});
function resolveCaptureName(storyId) {
  const built = captures.buildManifest();
  if (!built.ok) return void 0;
  const entry = built.json.captures.find((c) => c.id === storyId);
  return entry ? captureName(entry.relpath) : void 0;
}
var mirror = startProjectMirror({
  configDir,
  port: PORT,
  channel,
  resolveCaptureName,
  publicHost: () => lastSeenPublicHost
});
function serveManifest(res) {
  const built = captures.buildManifest();
  if (!built.ok) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(built.error);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(built.json));
}
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8"
};
function safeJoin(root, rel) {
  if (rel.includes("\0") || path2__default.default.isAbsolute(rel)) return null;
  const target = path2__default.default.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path2__default.default.sep)) return null;
  return target;
}
function serveFile(req, res, abs) {
  let st;
  try {
    st = fs3__default.default.statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const type = MIME[path2__default.default.extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(st.size), "Cache-Control": "no-store" });
  if ((req.method ?? "GET") === "HEAD") {
    res.end();
    return true;
  }
  fs3__default.default.createReadStream(abs).pipe(res);
  return true;
}
function notFound2(res, note) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(note);
}
var CSP_META_RE = /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>\s*/gi;
var HEAD_SCAN_STEPS = [512 * 1024, 2 * 1024 * 1024, 4 * 1024 * 1024];
var HEAD_END_RE = /<\/head\s*>|<body[\s>]/i;
var HEAD_SCAN_MAX_BYTES = HEAD_SCAN_STEPS[HEAD_SCAN_STEPS.length - 1];
function serveCapture(req, res, abs) {
  let st;
  try {
    st = fs3__default.default.statSync(abs);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  if (path2__default.default.extname(abs).toLowerCase() !== ".html" && path2__default.default.extname(abs).toLowerCase() !== ".htm") {
    return serveFile(req, res, abs);
  }
  let headStr = "";
  let headCloseIdx = -1;
  let read = 0;
  for (const step of HEAD_SCAN_STEPS) {
    const want = Math.min(step, st.size);
    if (want <= read) break;
    const slice = Buffer.alloc(want);
    let n = 0;
    try {
      const fd = fs3__default.default.openSync(abs, "r");
      try {
        n = fs3__default.default.readSync(fd, slice, 0, want, 0);
      } finally {
        fs3__default.default.closeSync(fd);
      }
    } catch {
      return false;
    }
    read = n;
    headStr = slice.subarray(0, n).toString("utf8");
    headCloseIdx = headStr.search(HEAD_END_RE);
    if (headCloseIdx >= 0 || n >= st.size) break;
  }
  if (headCloseIdx < 0) {
    console.warn(
      `[dom-annotakit] capture ${abs}: no </head>/<body> within ${HEAD_SCAN_MAX_BYTES} bytes \u2014 serving RAW; a strict CSP meta (if any) will block the layer on this capture`
    );
    return serveFile(req, res, abs);
  }
  if (headStr.slice(headCloseIdx, headCloseIdx + 5).toLowerCase() === "<body" && /<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/i.test(headStr.slice(headCloseIdx))) {
    console.warn(
      `[dom-annotakit] capture ${abs}: <body boundary matched but CSP meta(s) survive beyond it (possible false boundary in a head attribute) \u2014 the layer may be blocked on this capture`
    );
  }
  const headPart = headStr.slice(0, headCloseIdx);
  let stripped = 0;
  const strippedHead = headPart.replace(CSP_META_RE, () => {
    stripped++;
    return "";
  });
  const outHeadBuf = Buffer.from(strippedHead, "utf8");
  const restStart = Buffer.byteLength(headPart, "utf8");
  const totalLen = outHeadBuf.length + (st.size - restStart);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(totalLen),
    "Cache-Control": "no-store",
    "X-Dom-Anotakit-Csp-Stripped": String(stripped)
  });
  if ((req.method ?? "GET") === "HEAD") {
    res.end();
    return true;
  }
  res.write(outHeadBuf);
  if (st.size > restStart) {
    fs3__default.default.createReadStream(abs, { start: restStart }).pipe(res);
  } else {
    res.end();
  }
  return true;
}
function serveStatic(req, res) {
  const method = req.method ?? "GET";
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    notFound2(res, "bad url");
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (pathname === "/annotakit") {
    res.writeHead(308, { Location: "/annotakit/" });
    res.end();
    return;
  }
  if (pathname === "/dom-annotakit-manifest.json") {
    serveManifest(res);
    return;
  }
  if (pathname === "/dom-annotakit-project.json") {
    const st = mirror.status();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(st));
    return;
  }
  if (pathname === "/layer.mjs") {
    if (serveFile(req, res, layerFile)) return;
    notFound2(res, "dist/layer.mjs is not built yet (the surface port adds the iframe pin-layer bundle)");
    return;
  }
  if (pathname.startsWith("/captures/")) {
    const rel2 = pathname.slice("/captures/".length);
    if (!captures.isServableRel(rel2)) {
      notFound2(res, `no such capture under ${capturesDir}`);
      return;
    }
    const abs2 = safeJoin(capturesDir, rel2);
    if (abs2 && serveCapture(req, res, abs2)) return;
    notFound2(res, `no such capture under ${capturesDir}`);
    return;
  }
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const abs = safeJoin(appDir, rel);
  if (abs && serveFile(req, res, abs)) return;
  if (serveFile(req, res, path2__default.default.join(appDir, "index.html"))) return;
  notFound2(res, "review app not built yet (dist-app/ is the surface port's Vite build)");
}
var lastSeenPublicHost = null;
function hostFromHeader(raw) {
  if (!raw) return null;
  const v6 = raw.match(/^(\[[^\]]+\])(?::\d+)?$/);
  if (v6) return v6[1];
  const host = raw.split(":")[0];
  return host || null;
}
async function listThreadsSafe() {
  try {
    const gitFlowOn = readConfig(configDir).autoSync !== false;
    const loc = storeLocation(configDir, { forceClassic: !gitFlowOn });
    const store = getStore(configDir, { dataDir: loc.dir });
    const threads = await store.listThreads();
    return Array.isArray(threads) ? threads : null;
  } catch {
    return null;
  }
}
var hostRoutesDeps = {
  captures,
  specContext,
  mirror,
  listThreads: listThreadsSafe,
  log: (...a) => console.log("[dom-annotakit]", ...a)
};
var server = http__default.default.createServer((req, res) => {
  {
    const host = hostFromHeader(typeof req.headers.host === "string" ? req.headers.host : void 0);
    if (host && host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0" && host !== "[::1]" && !host.endsWith(".internal")) {
      lastSeenPublicHost = host;
    }
  }
  const urlStr = req.url ?? "/";
  if (urlStr.startsWith("/annotakit/")) {
    if ((urlStr === "/annotakit/api/sync" || urlStr === "/annotakit/api/gh") && (req.method ?? "GET") === "POST" && mirror.issuesMirrorDisarmed()) {
      const st = mirror.status();
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        error: "The GitHub ISSUES mirror is disarmed for this instance (ghAuto:false in annotakit.config.json) \u2014 annotations sync to the GH Projects spec board instead.",
        project: st.projectUrl ?? st.target,
        hint: "GET /annotakit/api/sync explains the engine doors; the board mirror reconciles automatically on every thread change."
      }));
      return;
    }
    bootEngine();
    const handler = apiHandler;
    if (!handler) {
      notFound2(res, "engine failed to boot");
      return;
    }
    const ctx = specContext.get();
    if ((req.method ?? "GET") === "POST" && (ctx.epic || ctx.story) && isRewriteDoor(urlStr)) {
      void (async () => {
        const buffered = await preloadBody(req, res, (bytes) => {
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: `request body too large (${bytes} bytes; the engine caps door bodies at 2MB)` }));
        });
        if (buffered == null) return;
        const rewritten = rewriteDoorBody(urlStr, buffered, ctx);
        handler(wrapRequestWithBody(req, rewritten), res, () => notFound2(res, "unknown route \u2014 GET /annotakit/api/schema documents every endpoint"));
      })();
      return;
    }
    handler(req, res, () => notFound2(res, "unknown route \u2014 GET /annotakit/api/schema documents every endpoint"));
    return;
  }
  if (handleHostRoutes(req, res, hostRoutesDeps)) return;
  serveStatic(req, res);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dom-annotakit] server listening on http://127.0.0.1:${PORT}`);
  console.log(`[dom-annotakit] configDir: ${configDir} (annotakit.config.json / .env)`);
  console.log(`[dom-annotakit] captures: ${capturesDir} (${captures.source}${captures.recursive ? ", recursive" : ", top-level only"}) \u2192 /captures/* + /dom-annotakit-manifest.json`);
  console.log(`[dom-annotakit] app build: ${appDir}${fs3__default.default.existsSync(appDir) ? "" : " (not built yet \u2014 / 404s until the surface port)"}`);
  console.log(`[dom-annotakit] layer bundle: ${layerFile}${fs3__default.default.existsSync(layerFile) ? "" : " (not built yet \u2014 /layer.mjs 404s)"}`);
  console.log("[dom-annotakit] engine boots on the first /annotakit/ request (store + git durability + GH mirror)");
});
var shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    if (!booted) process.exit(0);
  });
  if (!booted) {
    setTimeout(() => process.exit(0), 1500).unref();
  }
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
