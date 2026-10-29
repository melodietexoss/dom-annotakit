/**
 * dom-annotakit — SingleFile note IMPORT (design D2c; M4; D13 rework
 * 2026-10-26 §9 P1-A). Runs in the HOST window against the capture iframe's
 * same-origin contentDocument.
 *
 * THE ORDER IS LOAD-BEARING (D13 — the display invariant):
 *
 *   1. PARSE FIRST — read every `<single-file-note>` into plain data.
 *   2. HIDE the card ELEMENTS via one injected <style> (display:none) — the
 *      elements STAY in the tree. Anchor capture runs on this SAME
 *      cards-present shape every later session uses (hidden by default
 *      post-import): `:nth-child` counts tree position, so hidden and
 *      visible sessions are anchor-identical. (The old flow STRIPPED the
 *      cards before capture, minting anchors against a card-REMOVED tree
 *      that no later session ever presents again — the live audit P1-1.)
 *   3. CAPTURE ANCHORS on the hidden-cards DOM (consistent with every
 *      later load — hidden or visible).
 *   4. CREATE THREADS, per note, through the SAME doors the layer uses
 *      (server REST via preview/api.ts, or the linked static store) — the
 *      imported threads ride ALL existing contracts (replay flags, PATCH
 *      merge, delete-wins tombstones, GH mirror, exports, digests).
 *   5. ANCHOR-V2 MIGRATION (legacy): threads imported by the OLD strip-flow
 *      carry cssSelectors minted against a card-REMOVED tree. At load,
 *      singlefile-* threads whose capture still carries the notes are
 *      RE-CAPTURED via their INDEPENDENT ground truth (the note's
 *      `data-single-file-note-refs~=` target attr — unaffected by card
 *      presence) and PATCHed in place (ids/comments/board items unchanged).
 *      One-time per capture (`dom-annotakit:anchorV2:<id>`). User pins are
 *      NOT migrated (their selectors cannot be re-resolved reliably; the
 *      textQuote fallback stays their safety net) — documented limitation.
 *
 * Classification per note (first match of the note's cite selector in
 * document order):
 *   - no match            → DANGLING — panel-only thread, `context.singleFileDangling`
 *   - root/html/body (or  → PAGE-LEVEL — same singleFileDangling treatment,
 *     contains layer root)   context text records "page-level SingleFile note"
 *   - otherwise           → pinnable — anchor captured in-iframe via the
 *                           layer's own path (bootstrap handle
 *                           `__domAnnotakit.captureAnchorFor`), canvas pin.
 *
 * Dangling/page-level threads carry the note's OWN offsets as their bbox —
 * PROVENANCE ONLY, see `danglingTarget`.
 *
 * Identity is STRUCTURAL (design D2c-2): deterministic thread id
 * `singlefile-<captureId>-<noteId>-<sha1(noteText)[0:8]>` — the text hash
 * folds in note-id RECYCLING (ids restart at 1 on a re-save; unchanged note →
 * replay/no-op at the store door; edited/new note → new thread). No marker
 * fields gate the import; re-import after a cleared flag is a no-op.
 *
 * Delete-wins at BOTH doors, with their DIFFERENT shapes (crit-2 correction):
 * the server replays a tombstoned id as 409 `{deletedId: true}` (routes.ts),
 * the static store's create-on-tombstone THROWS (staticStore.ts) — both are
 * caught PER NOTE, treated as already-imported-and-deleted (skip, never
 * resurrect). Any other per-note failure lands in the summary and the batch
 * CONTINUES — a partial import is honest, an aborted one is not.
 */

import { parseSingleFileNotes, hideSingleFileNoteCards, type NoteInfo } from '../singlefile/parse';
import { sha1Hex } from '../singlefile/sha1';
import { createThread, getThreads, patchThread } from '../preview/api';
import { probeMode } from '../shared/mode';
import { getGhLinkedStaticStore } from '../shared/ghClient';
import { THREADS_CHANGED, type ThreadsChangedPayload } from '../shared/events';
import type { Comment, Thread, ThreadInput, ThreadTarget } from '../shared/types';
import { hostChannel } from './channel';
import { getSnapshotMeta, type CaptureLike } from './snapshot-meta';

/* eslint-disable @typescript-eslint/no-explicit-any */

/* ------------------------ imported flag (D2c-6; D13 rework) ------------------------ */

const STRIPPED_KEY_PREFIX = 'dom-annotakit:stripped:';

/** localStorage key: set at import time; later loads HIDE the cards (the
 * D13 display invariant — elements stay in the tree, one style flips
 * display). The KEY name keeps the historical 'stripped:' spelling on
 * purpose: live flags on already-imported captures must never orphan.
 * If cleared, cards re-render and the import bar re-appears — harmless: the
 * deterministic ids make re-import a no-op (delete-wins still guards
 * deliberate deletes). */
export function strippedFlagKey(captureId: string): string {
  return `${STRIPPED_KEY_PREFIX}${captureId}`;
}

export function hasStrippedFlag(captureId: string): boolean {
  try {
    return localStorage.getItem(strippedFlagKey(captureId)) != null;
  } catch {
    return false;
  }
}

export function setStrippedFlag(captureId: string): void {
  try {
    localStorage.setItem(strippedFlagKey(captureId), String(Date.now()));
  } catch {
    /* storage unavailable (private mode etc.) — import still works; the bar re-offers */
  }
}

/** Escape hatch for devtools/E2E: simulate a fresh machine (cards re-render,
 * the import bar re-appears). Re-import is idempotent — safe to poke. */
export function clearStrippedFlag(captureId: string): void {
  try {
    localStorage.removeItem(strippedFlagKey(captureId));
  } catch {
    /* ignore */
  }
}

/* ------------------------------- author (D2c-7) ------------------------------ */

/** Same key as the layer's getAuthor (settings override) → else the honest
 * import identity `singlefile-import`. */
const AUTHOR_KEY = 'annotakit:author';

export function importAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) || 'singlefile-import';
  } catch {
    return 'singlefile-import';
  }
}

/* ------------------------------ identity (D2c-2) ------------------------------ */

/** Deterministic, recycle-proof thread id (structural idempotency). */
export function threadIdFor(captureId: string, note: NoteInfo): string {
  return `singlefile-${captureId}-${note.noteId}-${sha1Hex(note.text).slice(0, 8)}`;
}

/** Deterministic comment id — the static store does NOT re-hash comment ids
 * (the server door does, routes.ts stableCommentId), so the import mints
 * upstream-keyed ids itself: two machines importing the same note produce the
 * SAME comment id → the merge lattice unions them once (SKILL §9 meta-rule 8:
 * any union of independently-learned entities needs the UPSTREAM's identity —
 * here: the deterministic thread id + the note text). */
export function commentIdFor(threadId: string, note: NoteInfo): string {
  return `c_sf_${sha1Hex(`${threadId}|${note.text}`).slice(0, 12)}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/* --------------------------- dangling / page-level --------------------------- */

/** Page-level = the match IS the document root/html/body, or it contains the
 * layer root (a scope-root wrap — never real content). Such targets mint
 * degenerate anchors (body text as textQuote, cssPath at the root), so they
 * take the same no-pin path as dangling notes. */
function isPageLevelTarget(el: Element, doc: Document): boolean {
  if (el === doc.documentElement || el === doc.body) return true;
  const layerRoot = doc.querySelector('[data-annota-overlay]');
  return layerRoot != null && el.contains(layerRoot);
}

/**
 * The no-pin target shape for dangling + page-level notes.
 *
 * bbox = the note's OWN offsets `{x: offsetX, y: offsetY, w: 0, h: 0}` —
 * PROVENANCE ONLY: these are the sticky CARD's positions, not any target's.
 * A non-degenerate bbox here would be a FABRICATED evidence pin for a target
 * that is not in the capture; nothing may ever render from it. The layer's
 * pin-render filter (layer.tsx EDIT (v)) keys on `context.singleFileDangling`
 * and GUARANTEES no canvas pin is drawn from this thread — the panel row and
 * the thread text are the honest review surface (design D2c-3/4).
 */
export function danglingTarget(note: NoteInfo, contextText?: string): ThreadTarget {
  return {
    kind: 'pin',
    selector: {},
    context: {
      tag: 'single-file-note',
      // engine convention: context.text is a clipped identity aid; the FULL
      // note text lives in the first comment body.
      text: clip(contextText ?? note.text, 120),
      singleFileNoteRef: note.noteId,
      singleFileDangling: true,
    },
    bbox: { x: note.offsetX ?? 0, y: note.offsetY ?? 0, w: 0, h: 0 },
    // no anchor capture happened — 0 is the honest "not captured" marker
    captureViewportWidth: 0,
  };
}

/* --------------------------------- the doors --------------------------------- */

/** The create/list pair behind ONE interface so the batch loop is
 * mode-agnostic (the same swap the layer performs via dataRef). */
export interface ImportDoor {
  /** Existing thread ids for a capture (replay pre-check + no-dup guard). */
  listIds(storyId: string): Promise<Set<string>>;
  create(input: ThreadInput): Promise<Thread>;
}

/** Resolve the door by mode probe (server REST vs static store) — the same
 * probeMode the layer and the host poll use. 'down' throws: importing
 * threads into an unreachable store would silently drop them. */
export async function openCreateDoor(): Promise<ImportDoor> {
  const mode = await probeMode();
  if (mode === 'dev') {
    return {
      listIds: async (storyId) => new Set((await getThreads(storyId)).map((t) => t.id)),
      create: createThread,
    };
  }
  if (mode === 'static') {
    const store = await getGhLinkedStaticStore();
    return {
      listIds: (storyId) => Promise.resolve(new Set(store.list(storyId).map((t) => t.id))),
      create: (input) => store.create(input),
    };
  }
  throw new Error('annotakit store unreachable (health + seed probes failed) — cannot import notes');
}

/**
 * Delete-wins tombstone detection, BOTH door shapes (crit-2 correction):
 *  - the server door's 409 envelope `{deletedId: true}` — either carried on
 *    the error object (envelope-preserved doors/mocks) or, when going through
 *    preview/api.ts's createThread (which flattens non-2xx bodies to
 *    `new Error(body.error)`), matched on the engine's stable tombstone
 *    message (routes.ts: "… was deleted — tombstones are final …");
 *  - the static store's create-on-tombstone THROW (staticStore.ts:
 *    "… was deleted — deletion is final …").
 */
export function isTombstoneRejection(e: unknown): boolean {
  if (e && typeof e === 'object') {
    if ((e as { deletedId?: unknown }).deletedId === true) return true;
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === 'string' && /was deleted|deletion is final|tombstones? are final/i.test(msg)) return true;
  }
  return false;
}

/* ------------------------------- import summary ------------------------------ */

export interface ImportSummary {
  /** Every <single-file-note> parsed from the capture. */
  notesTotal: number;
  /** Cards HIDDEN via the style at import (D13 — parse ran BEFORE; the
   *  elements stay in the tree). */
  cardsHidden: number;
  /** Threads created fresh this run. */
  imported: number;
  /** Deterministic id already in the store (re-import) — no create call. */
  alreadyImported: number;
  /** Tombstoned at either door — already imported AND deleted. Never resurrect. */
  deleted: number;
  /** Empty-text notes — skipped loudly. */
  emptyNotes: number;
  /** Pinnable notes that got a real captured anchor (canvas pins render). */
  pinned: number;
  /** Target not in the capture DOM (panel-only threads). */
  dangling: number;
  /** Target is root/html/body/scope-root (panel-only, "page-level" context). */
  pageLevel: number;
  /** Unexpected per-note errors — the batch CONTINUES past them. */
  failed: number;
  /** The failure details (also the honest tail of the summary notice). */
  errors: string[];
}

export function formatImportSummary(s: ImportSummary): string {
  const skipped = s.alreadyImported + s.deleted + s.emptyNotes + s.failed;
  const detail: string[] = [];
  if (s.alreadyImported || s.deleted) detail.push(`already imported/deleted: ${s.alreadyImported + s.deleted}`);
  if (s.emptyNotes) detail.push(`empty: ${s.emptyNotes}`);
  if (s.failed) detail.push(`failed: ${s.failed}`);
  // the design's exact notice shape: "Imported M notes · skipped K (…: X, …: Y)"
  const head = `Imported ${s.imported} note${s.imported === 1 ? '' : 's'} · skipped ${skipped}`;
  const tail = detail.length > 0 ? ` (${detail.join(', ')})` : '';
  return `${head}${tail}${s.errors.length ? ` — ${s.errors[0]}` : ''}`;
}

/* --------------------------------- the core --------------------------------- */

export interface RunImportParams {
  captureId: string;
  /** Manifest entry (title/relpath) — feeds Thread.story via getSnapshotMeta. */
  capture: CaptureLike;
  /** Pre-parsed notes (parseSingleFileNotes output). */
  notes: NoteInfo[];
  /** The capture document — selector resolution + page-level detection. */
  doc: Document;
  /** The iframe-side anchor capture (bootstrap's `captureAnchorFor`). */
  captureAnchor: (el: Element) => ThreadTarget | null;
  door: ImportDoor;
  author: string;
  /** Clock override (tests). One timestamp per batch = the comments' createdAt. */
  now?: () => string;
}

/** The per-note batch — every dep injected, so scripts/singlefile-import-test.mjs
 *  drives it against fake DOM + fake doors without a browser. Never throws on
 *  a single note: failures land in the summary. */
export async function runNoteImport(params: RunImportParams): Promise<ImportSummary> {
  const now = params.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const summary: ImportSummary = {
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
    errors: [],
  };
  // replay pre-check: ids already in the store never hit the create door.
  // A failed list must not abort the batch — an empty set just means every
  // note POSTs (the door's own replay/tombstone handling stays the guard).
  const existing = await params.door.listIds(params.captureId).catch(() => new Set<string>());

  for (const note of params.notes) {
    // the loud empty skip (D2c-3): counted, never imported
    if (!note.text) {
      summary.emptyNotes++;
      continue;
    }
    if (!note.noteId) {
      summary.failed++;
      summary.errors.push('note without data-note-id skipped (cannot mint a deterministic id)');
      continue;
    }
    const id = threadIdFor(params.captureId, note);
    if (existing.has(id)) {
      summary.alreadyImported++;
      continue;
    }

    // classification — first match in document order
    let el: Element | null = null;
    try {
      el = params.doc.querySelector(note.selector);
    } catch {
      el = null; // a malformed selector degrades to dangling, never kills the batch
    }
    let target: ThreadTarget;
    if (!el) {
      summary.dangling++;
      target = danglingTarget(note);
    } else if (isPageLevelTarget(el, params.doc)) {
      summary.pageLevel++;
      target = danglingTarget(note, 'page-level SingleFile note');
    } else {
      const captured = params.captureAnchor(el);
      if (!captured) {
        // isPinnableTarget refused (overlay chrome / the scope itself) — an
        // honest failure, not a dangling pin
        summary.failed++;
        summary.errors.push(`note ${note.noteId}: anchor capture refused for the matched element`);
        continue;
      }
      summary.pinned++;
      target = { ...captured, context: { ...captured.context, singleFileNoteRef: note.noteId } };
    }

    const comment: Comment = {
      id: commentIdFor(id, note),
      author: params.author,
      body: note.text,
      createdAt,
      source: 'singlefile',
    };
    const input: ThreadInput = {
      id,
      storyId: params.captureId,
      // story.url = the ?capture= view (snapshot-meta.ts) — the ?path=/story/
      // fallbacks never fire; component stays null (captures have no fiber)
      story: getSnapshotMeta(params.captureId, params.capture),
      component: null,
      target,
      comments: [comment],
    };
    try {
      await params.door.create(input);
      summary.imported++;
      existing.add(id); // two notes with identical id+text in ONE batch: the second replays
    } catch (e) {
      if (isTombstoneRejection(e)) {
        summary.deleted++;
        continue; // already imported AND deleted — never resurrect (delete-wins)
      }
      summary.failed++;
      summary.errors.push(`note ${note.noteId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return summary;
}

/* ------------------------------ the live adapter ----------------------------- */

export interface ImportCapture {
  id: string;
  relpath: string;
  title?: string;
}

/**
 * The full live flow against the capture iframe (host window):
 * parse → hide → capture → create → emit THREADS_CHANGED on the host channel
 * (the pair's broadcast refreshes panel AND layer) → set the imported flag.
 * Throws only on ENVIRONMENT failures (no iframe, no layer handle, store
 * down) — per-note failures live in the summary.
 */
export async function importSingleFileNotes(iframe: HTMLIFrameElement, capture: ImportCapture): Promise<ImportSummary> {
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow as (Window & { __domAnnotakit?: { captureAnchorFor?: (el: Element) => ThreadTarget | null } | undefined }) | null;
  if (!doc || !win) throw new Error('capture iframe document unavailable — cannot import SingleFile notes');
  const handle = win.__domAnnotakit;
  if (!handle?.captureAnchorFor) {
    throw new Error('pin layer handle unavailable — wait for injection to settle before importing (the anchor capture needs the in-iframe engine)');
  }

  // (1) PARSE FIRST — plain data before any DOM mutation
  const notes = parseSingleFileNotes(doc);
  // (2) HIDE the cards (D13: elements STAY in the tree — the anchor shape
  //     below matches every later cards-present session, hidden or visible)
  const cardsHidden = hideSingleFileNoteCards(doc);
  // (3+4) per-note capture + create through the mode-resolved door
  const door = await openCreateDoor();
  const summary = await runNoteImport({
    captureId: capture.id,
    capture,
    notes,
    doc,
    captureAnchor: (el) => handle.captureAnchorFor!(el),
    door,
    author: importAuthor(),
  });
  const full: ImportSummary = { ...summary, cardsHidden };

  // (5) refresh fan-out + the auto-strip flag — even a fully-skipped re-import
  // sets it: the user asked for the cards to go, and the ids keep it a no-op.
  if (full.notesTotal > 0) {
    const payload: ThreadsChangedPayload = { storyId: capture.id, reason: 'created' };
    hostChannel.emit(THREADS_CHANGED, payload);
    setStrippedFlag(capture.id);
  }
  return full;
}

/* -------------------- D13 §9 P1-A: the legacy anchor-v2 migration -------------------- */

const ANCHOR_V2_PREFIX = 'dom-annotakit:anchorV2:';

export function anchorV2FlagKey(captureId: string): string {
  return `${ANCHOR_V2_PREFIX}${captureId}`;
}

export function hasAnchorV2Flag(captureId: string): boolean {
  try {
    return localStorage.getItem(anchorV2FlagKey(captureId)) != null;
  } catch {
    return false;
  }
}

function setAnchorV2Flag(captureId: string): void {
  try {
    localStorage.setItem(anchorV2FlagKey(captureId), String(Date.now()));
  } catch {
    /* storage unavailable — the migration may re-run; re-capture is idempotent */
  }
}

export interface AnchorMigrationSummary {
  migrated: number;
  skipped: number;
  missingTargets: number;
  errors: string[];
}

/**
 * Re-capture the targets of SINGLEFILE-IMPORTED threads whose anchors were
 * minted by the OLD strip-flow (selectors against a card-REMOVED tree).
 * Ground truth = the note's `data-single-file-note-refs~=` membership attr —
 * painted by SingleFile on the actual target, unaffected by card presence.
 * The captureAnchorFor(el) call runs on the CURRENT cards-present DOM —
 * the exact shape every later session presents (hidden or visible).
 * Threads PATCH in place: ids, comments, board items all unchanged; only
 * target (selector/bbox/context) is replaced. NEVER throws — failures land
 * in the summary and the flag stays unset so a later load retries.
 *
 * Scope: singlefile-* thread ids ONLY (the deterministic import id shape);
 * threads whose target carries `singleFileDangling` are skipped (no pin to
 * fix); user pins are NOT touched (see header — documented limitation).
 */
export async function migrateLegacySingleFileAnchors(
  iframe: HTMLIFrameElement,
  captureId: string,
): Promise<AnchorMigrationSummary | null> {
  if (hasAnchorV2Flag(captureId)) return null;
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow as (Window & { __domAnnotakit?: { captureAnchorFor?: (el: Element) => ThreadTarget | null } | undefined }) | null;
  if (!doc || !win) return null;
  const handle = win.__domAnnotakit;
  if (!handle?.captureAnchorFor) return null; // layer not settled yet — retry on the next load
  if (doc.querySelectorAll('single-file-note').length === 0) {
    setAnchorV2Flag(captureId); // nothing to migrate — a capture with no notes can never mint legacy anchors
    return null;
  }

  const out: AnchorMigrationSummary = { migrated: 0, skipped: 0, missingTargets: 0, errors: [] };
  let threads: Thread[];
  const mode = await probeMode();
  if (mode === 'dev') threads = await getThreads(captureId);
  else if (mode === 'static') threads = (await getGhLinkedStaticStore()).list(captureId) as unknown as Thread[];
  else return null;

  const captureAnchor = handle.captureAnchorFor;
  for (const t of threads) {
    if (!t.id.startsWith('singlefile-')) {
      out.skipped++;
      continue; // user pins: NOT migrated (documented limitation)
    }
    if (t.target?.context?.singleFileDangling) {
      out.skipped++;
      continue; // panel-only thread — no pin to fix
    }
    const noteRef = t.target?.context?.singleFileNoteRef;
    if (!noteRef) {
      out.skipped++;
      continue;
    }
    let el: Element | null = null;
    try {
      el = doc.querySelector(`[data-single-file-note-refs~="${CSS.escape(String(noteRef))}"]`);
    } catch {
      el = null;
    }
    if (!el) {
      out.missingTargets++;
      continue; // the target is gone from this capture — the old anchor + textQuote stay
    }
    try {
      const captured = captureAnchor(el);
      if (!captured) {
        out.skipped++;
        continue;
      }
      const nextTarget: ThreadTarget = { ...captured, context: { ...captured.context, singleFileNoteRef: String(noteRef) } };
      if (JSON.stringify(nextTarget) === JSON.stringify(t.target)) {
        out.skipped++;
        continue; // already consistent (a previous re-import fixed it)
      }
      if (mode === 'dev') await patchThread({ ...t, target: nextTarget });
      else {
        /* audit round-1 P1: the static store's write door is `patch` — the
         * old duck-typed `update?.()` call short-circuited (method absent),
         * reported "migrated", and latched the one-time flag on a silent
         * no-op. patch() is also the door LinkedStaticStore hooks for the
         * GH outbox — exactly what a target re-capture should enqueue. */
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
