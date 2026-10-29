import {
  hideSingleFileNoteCards,
  parseSingleFileNotes
} from "./chunk-AQVFX3FX.mjs";
import {
  sha1Hex
} from "./chunk-JPEFV4ZN.mjs";
import {
  getGhLinkedStaticStore
} from "./chunk-KU6TODPW.mjs";
import {
  probeSeed
} from "./chunk-IFYHU3KI.mjs";

// src/shared/events.ts
var THREADS_CHANGED = "annotakit/threads-changed";
var API_BASE = "/annotakit/api";

// src/preview/api.ts
var FETCH_TIMEOUT_MS = 1e4;
var fetchTimeout = () => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
async function json(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`annotakit: non-JSON response (${res.status})`);
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body ? String(body.error) : `annotakit: HTTP ${res.status}`;
    throw new Error(message);
  }
  return body;
}
function asThreadsEnvelope(body) {
  if (body && typeof body === "object" && Array.isArray(body.threads)) {
    return body.threads;
  }
  throw new Error("annotakit: malformed threads envelope (expected {threads: []})");
}
function asThread(body, what) {
  if (body && typeof body === "object" && typeof body.id === "string") {
    return body;
  }
  throw new Error(`annotakit: malformed ${what} response (expected a thread document)`);
}
async function getThreads(storyId) {
  const url = storyId ? `${API_BASE}/threads?storyId=${encodeURIComponent(storyId)}` : `${API_BASE}/threads`;
  const body = await json(await fetch(url, { cache: "no-store", ...fetchTimeout() }));
  return asThreadsEnvelope(body);
}
async function createThread(input) {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        ...fetchTimeout()
      })
    ),
    "createThread"
  );
}
async function patchThread(thread, statusAuthor) {
  return asThread(
    await json(
      await fetch(`${API_BASE}/threads/${encodeURIComponent(thread.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusAuthor ? { ...thread, statusAuthor } : thread),
        ...fetchTimeout()
      })
    ),
    "patchThread"
  );
}

// src/shared/mode.ts
async function healthOkAt(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}
async function healthOk() {
  const candidates = [];
  if (typeof window.__DOM_AK_APP_BASE__ === "string" && window.__DOM_AK_APP_BASE__) {
    try {
      candidates.push(new URL("annotakit/api/health", window.__DOM_AK_APP_BASE__).href);
    } catch {
    }
  }
  candidates.push(new URL("annotakit/api/health", document.baseURI).href);
  candidates.push(new URL("/annotakit/api/health", window.location.origin).href);
  for (const url of [...new Set(candidates)]) {
    if (await healthOkAt(url)) return true;
  }
  return false;
}
async function probeMode() {
  if (await healthOk()) return "dev";
  const seed = await probeSeed();
  return seed ? "static" : "down";
}

// src/host/channel.ts
function addListener(map, event, cb) {
  let set = map.get(event);
  if (!set) {
    set = /* @__PURE__ */ new Set();
    map.set(event, set);
  }
  set.add(cb);
}
function removeListenerAt(map, event, cb) {
  map.get(event)?.delete(cb);
}
function deliver(map, event, payload) {
  if (!map) return;
  const set = map.get(event);
  if (!set || set.size === 0) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch {
    }
  }
}
var hostMap = /* @__PURE__ */ new Map();
var layerMap = null;
function broadcast(event, payload) {
  deliver(hostMap, event, payload);
  deliver(layerMap, event, payload);
}
var hostChannel = {
  on: (event, cb) => addListener(hostMap, event, cb),
  removeListener: (event, cb) => removeListenerAt(hostMap, event, cb),
  emit: broadcast
};

// src/host/capture-id.ts
function captureName(relpath) {
  const base = relpath.replace(/^.*[/\\]/, "");
  return base.replace(/\.(html?|htm)$/i, "");
}

// src/host/snapshot-meta.ts
function getSnapshotMeta(captureId, capture) {
  const displayName = captureName(capture.relpath);
  const meta = {
    storyId: captureId,
    title: displayName,
    name: displayName
  };
  try {
    const u = new URL(location.href);
    u.searchParams.set("capture", captureId);
    u.hash = "";
    meta.url = u.href;
  } catch {
  }
  return meta;
}

// src/host/import.ts
var STRIPPED_KEY_PREFIX = "dom-annotakit:stripped:";
function strippedFlagKey(captureId) {
  return `${STRIPPED_KEY_PREFIX}${captureId}`;
}
function hasStrippedFlag(captureId) {
  try {
    return localStorage.getItem(strippedFlagKey(captureId)) != null;
  } catch {
    return false;
  }
}
function setStrippedFlag(captureId) {
  try {
    localStorage.setItem(strippedFlagKey(captureId), String(Date.now()));
  } catch {
  }
}
function clearStrippedFlag(captureId) {
  try {
    localStorage.removeItem(strippedFlagKey(captureId));
  } catch {
  }
}
var AUTHOR_KEY = "annotakit:author";
function importAuthor() {
  try {
    return localStorage.getItem(AUTHOR_KEY) || "singlefile-import";
  } catch {
    return "singlefile-import";
  }
}
function threadIdFor(captureId, note) {
  return `singlefile-${captureId}-${note.noteId}-${sha1Hex(note.text).slice(0, 8)}`;
}
function commentIdFor(threadId, note) {
  return `c_sf_${sha1Hex(`${threadId}|${note.text}`).slice(0, 12)}`;
}
function clip(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}
function isPageLevelTarget(el, doc) {
  if (el === doc.documentElement || el === doc.body) return true;
  const layerRoot = doc.querySelector("[data-annota-overlay]");
  return layerRoot != null && el.contains(layerRoot);
}
function danglingTarget(note, contextText) {
  return {
    kind: "pin",
    selector: {},
    context: {
      tag: "single-file-note",
      // engine convention: context.text is a clipped identity aid; the FULL
      // note text lives in the first comment body.
      text: clip(contextText ?? note.text, 120),
      singleFileNoteRef: note.noteId,
      singleFileDangling: true
    },
    bbox: { x: note.offsetX ?? 0, y: note.offsetY ?? 0, w: 0, h: 0 },
    // no anchor capture happened — 0 is the honest "not captured" marker
    captureViewportWidth: 0
  };
}
async function openCreateDoor() {
  const mode = await probeMode();
  if (mode === "dev") {
    return {
      listIds: async (storyId) => new Set((await getThreads(storyId)).map((t) => t.id)),
      create: createThread
    };
  }
  if (mode === "static") {
    const store = await getGhLinkedStaticStore();
    return {
      listIds: (storyId) => Promise.resolve(new Set(store.list(storyId).map((t) => t.id))),
      create: (input) => store.create(input)
    };
  }
  throw new Error("annotakit store unreachable (health + seed probes failed) \u2014 cannot import notes");
}
function isTombstoneRejection(e) {
  if (e && typeof e === "object") {
    if (e.deletedId === true) return true;
    const msg = e.message;
    if (typeof msg === "string" && /was deleted|deletion is final|tombstones? are final/i.test(msg)) return true;
  }
  return false;
}
function formatImportSummary(s) {
  const skipped = s.alreadyImported + s.deleted + s.emptyNotes + s.failed;
  const detail = [];
  if (s.alreadyImported || s.deleted) detail.push(`already imported/deleted: ${s.alreadyImported + s.deleted}`);
  if (s.emptyNotes) detail.push(`empty: ${s.emptyNotes}`);
  if (s.failed) detail.push(`failed: ${s.failed}`);
  const head = `Imported ${s.imported} note${s.imported === 1 ? "" : "s"} \xB7 skipped ${skipped}`;
  const tail = detail.length > 0 ? ` (${detail.join(", ")})` : "";
  return `${head}${tail}${s.errors.length ? ` \u2014 ${s.errors[0]}` : ""}`;
}
async function runNoteImport(params) {
  const now = params.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
  const createdAt = now();
  const summary = {
    notesTotal: params.notes.length,
    cardsHidden: 0,
    imported: 0,
    alreadyImported: 0,
    deleted: 0,
    emptyNotes: 0,
    pinned: 0,
    dangling: 0,
    pageLevel: 0,
    failed: 0,
    errors: []
  };
  const existing = await params.door.listIds(params.captureId).catch(() => /* @__PURE__ */ new Set());
  for (const note of params.notes) {
    if (!note.text) {
      summary.emptyNotes++;
      continue;
    }
    if (!note.noteId) {
      summary.failed++;
      summary.errors.push("note without data-note-id skipped (cannot mint a deterministic id)");
      continue;
    }
    const id = threadIdFor(params.captureId, note);
    if (existing.has(id)) {
      summary.alreadyImported++;
      continue;
    }
    let el = null;
    try {
      el = params.doc.querySelector(note.selector);
    } catch {
      el = null;
    }
    let target;
    if (!el) {
      summary.dangling++;
      target = danglingTarget(note);
    } else if (isPageLevelTarget(el, params.doc)) {
      summary.pageLevel++;
      target = danglingTarget(note, "page-level SingleFile note");
    } else {
      const captured = params.captureAnchor(el);
      if (!captured) {
        summary.failed++;
        summary.errors.push(`note ${note.noteId}: anchor capture refused for the matched element`);
        continue;
      }
      summary.pinned++;
      target = { ...captured, context: { ...captured.context, singleFileNoteRef: note.noteId } };
    }
    const comment = {
      id: commentIdFor(id, note),
      author: params.author,
      body: note.text,
      createdAt,
      source: "singlefile"
    };
    const input = {
      id,
      storyId: params.captureId,
      // story.url = the ?capture= view (snapshot-meta.ts) — the ?path=/story/
      // fallbacks never fire; component stays null (captures have no fiber)
      story: getSnapshotMeta(params.captureId, params.capture),
      component: null,
      target,
      comments: [comment]
    };
    try {
      await params.door.create(input);
      summary.imported++;
      existing.add(id);
    } catch (e) {
      if (isTombstoneRejection(e)) {
        summary.deleted++;
        continue;
      }
      summary.failed++;
      summary.errors.push(`note ${note.noteId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}
async function importSingleFileNotes(iframe, capture) {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) throw new Error("capture iframe document unavailable \u2014 cannot import SingleFile notes");
  const handle = win.__domAnnotakit;
  if (!handle?.captureAnchorFor) {
    throw new Error("pin layer handle unavailable \u2014 wait for injection to settle before importing (the anchor capture needs the in-iframe engine)");
  }
  const notes = parseSingleFileNotes(doc);
  const cardsHidden = hideSingleFileNoteCards(doc);
  const door = await openCreateDoor();
  const summary = await runNoteImport({
    captureId: capture.id,
    capture,
    notes,
    doc,
    captureAnchor: (el) => handle.captureAnchorFor(el),
    door,
    author: importAuthor()
  });
  const full = { ...summary, cardsHidden };
  if (full.notesTotal > 0) {
    const payload = { storyId: capture.id, reason: "created" };
    hostChannel.emit(THREADS_CHANGED, payload);
    setStrippedFlag(capture.id);
  }
  return full;
}
var ANCHOR_V2_PREFIX = "dom-annotakit:anchorV2:";
function anchorV2FlagKey(captureId) {
  return `${ANCHOR_V2_PREFIX}${captureId}`;
}
function hasAnchorV2Flag(captureId) {
  try {
    return localStorage.getItem(anchorV2FlagKey(captureId)) != null;
  } catch {
    return false;
  }
}
function setAnchorV2Flag(captureId) {
  try {
    localStorage.setItem(anchorV2FlagKey(captureId), String(Date.now()));
  } catch {
  }
}
async function migrateLegacySingleFileAnchors(iframe, captureId) {
  if (hasAnchorV2Flag(captureId)) return null;
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) return null;
  const handle = win.__domAnnotakit;
  if (!handle?.captureAnchorFor) return null;
  if (doc.querySelectorAll("single-file-note").length === 0) {
    setAnchorV2Flag(captureId);
    return null;
  }
  const out = { migrated: 0, skipped: 0, missingTargets: 0, errors: [] };
  let threads;
  const mode = await probeMode();
  if (mode === "dev") threads = await getThreads(captureId);
  else if (mode === "static") threads = (await getGhLinkedStaticStore()).list(captureId);
  else return null;
  const captureAnchor = handle.captureAnchorFor;
  for (const t of threads) {
    if (!t.id.startsWith("singlefile-")) {
      out.skipped++;
      continue;
    }
    if (t.target?.context?.singleFileDangling) {
      out.skipped++;
      continue;
    }
    const noteRef = t.target?.context?.singleFileNoteRef;
    if (!noteRef) {
      out.skipped++;
      continue;
    }
    let el = null;
    try {
      el = doc.querySelector(`[data-single-file-note-refs~="${CSS.escape(String(noteRef))}"]`);
    } catch {
      el = null;
    }
    if (!el) {
      out.missingTargets++;
      continue;
    }
    try {
      const captured = captureAnchor(el);
      if (!captured) {
        out.skipped++;
        continue;
      }
      const nextTarget = { ...captured, context: { ...captured.context, singleFileNoteRef: String(noteRef) } };
      if (JSON.stringify(nextTarget) === JSON.stringify(t.target)) {
        out.skipped++;
        continue;
      }
      if (mode === "dev") await patchThread({ ...t, target: nextTarget });
      else {
        const store = await getGhLinkedStaticStore();
        await store.patch({ ...t, target: nextTarget });
      }
      out.migrated++;
    } catch (e) {
      out.errors.push(`${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (out.errors.length === 0) setAnchorV2Flag(captureId);
  return out;
}
export {
  anchorV2FlagKey,
  clearStrippedFlag,
  commentIdFor,
  danglingTarget,
  formatImportSummary,
  hasAnchorV2Flag,
  hasStrippedFlag,
  importAuthor,
  importSingleFileNotes,
  isTombstoneRejection,
  migrateLegacySingleFileAnchors,
  openCreateDoor,
  runNoteImport,
  setStrippedFlag,
  strippedFlagKey,
  threadIdFor
};
