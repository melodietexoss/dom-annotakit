#!/usr/bin/env node
/**
 * dom-annotakit M4 — SingleFile import Node suite (COPY-MAP scripts row:
 * singlefile-import-test.mjs, NEW; design D2c test strategy).
 *
 * No new deps: a hand-rolled fake DOM per the upstream injectable-DOM pattern
 * (s6's harness precedent — selector-aware querySelectorAll covering the
 * tag / [attr] / [attr=value] / [attr~=value] subset the reader + classifier
 * touch), driving the BUILT battery entries:
 *
 *   dist/singlefileParse.mjs  — parseSingleFileNotes / stripSingleFileNoteCards
 *                               / contentOf / selectorFromCite
 *   dist/singlefileSha1.mjs   — sha1Hex (pinned against node:crypto)
 *   dist/sfImport.mjs         — runNoteImport / threadIdFor / commentIdFor
 *                               / isTombstoneRejection / danglingTarget
 *                               / formatImportSummary
 *
 * THIS suite pins the template.content (fragment) half of the dual-shape
 * contract — jsdom-free means jsdom-blind: the shadowRoot (live declarative
 * parse) half is pinned by the agent-browser E2E on the REAL annotated
 * capture (fixtures/magnific-folder-new-asset-flow-annotated.html). The
 * fixture FILES are still string-audited here (note counts, cite decodability,
 * textarea bodies) so a re-saved/damaged fixture fails loudly in Node too.
 *
 * Import-door coverage (both tombstone shapes, crit-2): the server door's
 * 409 `{deletedId:true}` envelope → skip; the static store's create-on-
 * tombstone THROW → skip; both continue the batch. Plus: replay skip
 * (deterministic ids → no duplicates), per-note failure isolation, and
 * dangling/page-level classification (NO pinnable anchor captured for them).
 */

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { parseSingleFileNotes, stripSingleFileNoteCards, contentOf, selectorFromCite, hideSingleFileNoteCards, setSingleFileNoteCardsVisible, singleFileNoteCardsVisible, SF_HIDE_STYLE_ATTR } = await import(
  path.join(root, 'dist/singlefileParse.mjs')
);
const { sha1Hex } = await import(path.join(root, 'dist/singlefileSha1.mjs'));
const {
  runNoteImport,
  threadIdFor,
  commentIdFor,
  isTombstoneRejection,
  danglingTarget,
  formatImportSummary,
} = await import(path.join(root, 'dist/sfImport.mjs'));

let passed = 0;
let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e?.stack ?? e}`);
  }
};

/* ------------------------------ fake DOM ------------------------------ */

/** tag / [attr] / [attr=value] / [attr~="value"] — the subset parse.ts +
 *  import.ts touch (`~=` is the SingleFile refs-membership predicate). */
function selMatches(el, sel) {
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\[[^\]]+\])*)$/.exec(sel.trim());
  if (!m) return false;
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  const attrRe = /\[([a-zA-Z-]+)(?:([~|^$*]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g;
  let am;
  while ((am = attrRe.exec(m[2]))) {
    const raw = el.getAttribute(am[1]);
    if (raw == null) return false;
    const want = am[3] ?? am[4] ?? am[5];
    if (want === undefined) continue; // presence predicate
    if (am[2] === '~=') {
      if (!raw.split(/\s+/).includes(want)) return false;
    } else if (am[2] === '=') {
      if (raw !== want) return false;
    } else if (raw !== want) return false;
  }
  return true;
}

const walk = (node, out) => {
  for (const c of node.children ?? []) {
    out.push(c);
    walk(c, out);
  }
  return out;
};

class FakeElement {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null; // the FRAGMENT shape: no declarative-shadow attach
    this.textOverride = null;
  }
  getAttribute(n) {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
  }
  appendChild(c) {
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i !== -1) this.children.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  contains(el) {
    for (const c of walk(this, [])) if (c === el) return true;
    return false;
  }
  get textContent() {
    if (this.textOverride != null) return this.textOverride;
    let s = '';
    for (const c of walk(this, [])) if (c.textOverride != null) s += c.textOverride;
    return s;
  }
  set textContent(v) {
    this.textOverride = String(v); // the style element's CSS text rides this (D13)
  }
  querySelectorAll(sel) {
    return walk(this, []).filter((el) => selMatches(el, sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

/** A `<template>.content` fragment (children, same query API, no tag). */
const fragment = (children) => ({ children, querySelectorAll(sel) { return walk(this, []).filter((el) => selMatches(el, sel)); }, querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; } });

/** The SingleFile note card: <template shadowrootmode=open> with the
 *  blockquote[cite] > textarea body — the FRAGMENT shape (template.content). */
function sfNote({ id, text, cite, offX = 10, offY = 20, liveTextarea = false }) {
  const note = new FakeElement('single-file-note', {
    'data-note-id': String(id),
    ...(offX != null ? { 'data-note-offset-x': String(offX) } : {}),
    ...(offY != null ? { 'data-note-offset-y': String(offY) } : {}),
  });
  const template = new FakeElement('template', { shadowrootmode: 'open' });
  template.content = fragment([
    (() => {
      const bq = new FakeElement('blockquote');
      if (cite != null) bq.attrs.cite = cite;
      const ta = new FakeElement('textarea', { dir: 'auto' });
      // live textareas carry .value; fragment textareas have EMPTY .value
      // and their text lives in textContent (entities were decoded by the
      // HTML parser before this harness — we assert the reader CARRIES the
      // decoded text verbatim, not that it decodes entities itself).
      if (liveTextarea) {
        ta.value = text;
        ta.textOverride = '';
      } else {
        ta.textOverride = text;
      }
      bq.appendChild(ta);
      return bq;
    })(),
  ]);
  note.appendChild(template);
  return note;
}

/** A fake capture document: html > body, optional overlay root, notes,
 *  targets. querySelector walks the whole tree in document order. */
function fakeDoc({ html, body, extra = [], withHead = true }) {
  const head = new FakeElement('head');
  if (withHead) html.appendChild(head);
  html.appendChild(body);
  const all = [];
  walk(html, all);
  for (const e of extra) {
    // notes/targets live under body in the fixture shape
    body.appendChild(e);
  }
  const doc = {
    documentElement: html,
    head: withHead ? head : undefined,
    body,
    createElement(tag) {
      return new FakeElement(tag);
    },
    querySelectorAll(sel) {
      return walk(html, []).filter((el) => selMatches(el, sel));
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] ?? null;
    },
  };
  return doc;
}

/* --------------------- the synthetic-fixture fake world --------------------- */

/** Mirrors fixtures/synthetic-annotated.html (6 notes) in fake-DOM form. */
function buildSyntheticWorld() {
  const html = new FakeElement('html');
  const body = new FakeElement('body');
  const overlay = new FakeElement('div', { 'data-annota-overlay': '1' }); // the injected layer root
  body.appendChild(overlay);
  const target1 = new FakeElement('div', { class: 'card', 'data-single-file-note-refs': '1' });
  target1.appendChild(new FakeElement('p')).textOverride = 'this div carries note 1';
  const targetMulti = new FakeElement('div', { class: 'card', id: 'multiref-div', 'data-single-file-note-refs': '3 4' });
  const highlight = new FakeElement('span', { class: 'single-file-highlight-yellow' });
  body.appendChild(target1);
  body.appendChild(targetMulti);
  body.appendChild(highlight);
  const CITE = (sel) => `https://www.w3.org/TR/annotation-model/#selector(type=CssSelector,value=${sel})`;
  const notes = [
    sfNote({ id: 1, text: 'normal note — first line\nsecond line with an entity: a → b & c', cite: CITE('[data-single-file-note-refs~="1"]'), offX: 127, offY: 414 }),
    sfNote({ id: 2, text: 'dangling note — the cited selector matches nothing in this capture', cite: CITE('[data-single-file-note-refs~="9"]'), offX: 112, offY: 298 }),
    sfNote({ id: 3, text: 'first of the two multi-ref notes — anchored on the same element as note 4', cite: CITE('[data-single-file-note-refs~="3"]'), offX: 193, offY: 28 }),
    sfNote({ id: 4, text: 'second multi-ref note — same element, its own thread (cascade stacks the pins)', cite: CITE('[data-single-file-note-refs~="4"]'), offX: -81, offY: 214 }),
    sfNote({ id: 5, text: 'page-level note — cites the whole body, imports panel-only (no pin)', cite: CITE('body'), offX: 40, offY: 90 }),
    sfNote({ id: 6, text: '', cite: CITE('[data-single-file-note-refs~="6"]'), offX: 60, offY: 60 }),
  ];
  const doc = fakeDoc({ html, body, extra: notes });
  return { doc, notes, target1, targetMulti, highlight, overlay, body, html };
}

/* ------------------------------ suite ------------------------------ */

/* ---- sha1 (identity substrate — pinned against node:crypto) ---- */
{
  for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'multi\nline → entity & text', 'x'.repeat(1000)]) {
    const expect = createHash('sha1').update(s, 'utf8').digest('hex');
    check(`sha1Hex matches node:crypto (${JSON.stringify(s.slice(0, 24))})`, () => assert.strictEqual(sha1Hex(s), expect));
  }
}

/* ---- parse: the FRAGMENT (template.content) shape ---- */
{
  const w = buildSyntheticWorld();
  const parsed = parseSingleFileNotes(w.doc);
  check('fragment shape: parse reads all 6 notes', () => assert.strictEqual(parsed.length, 6));
  const byId = Object.fromEntries(parsed.map((n) => [n.noteId, n]));
  check('fragment shape: contentOf reaches template.content (dual-shape contract)', () => {
    const c = contentOf(w.notes[0]);
    assert.ok(c, 'content must resolve through template.content when shadowRoot is null');
    assert.strictEqual(c.querySelector('textarea').textContent, 'normal note — first line\nsecond line with an entity: a → b & c');
  });
  check('text extraction: newlines + entities survive the fragment path', () => {
    assert.strictEqual(byId['1'].text, 'normal note — first line\nsecond line with an entity: a → b & c');
  });
  check('text extraction: LIVE textarea .value wins when present', () => {
    const live = sfNote({ id: 99, text: 'live value text', cite: null, liveTextarea: true });
    const d = fakeDoc({ html: new FakeElement('html'), body: new FakeElement('body'), extra: [live] });
    const p = parseSingleFileNotes(d);
    assert.strictEqual(p[0].text, 'live value text');
  });
  check('selector: cite extracts the CssSelector value (URL-decoded)', () => {
    assert.strictEqual(byId['1'].selector, '[data-single-file-note-refs~="1"]');
    assert.strictEqual(byId['5'].selector, 'body');
  });
  check('offsets: data-note-offset-x/y parsed (incl. negatives)', () => {
    assert.strictEqual(byId['1'].offsetX, 127);
    assert.strictEqual(byId['1'].offsetY, 414);
    assert.strictEqual(byId['4'].offsetX, -81);
  });
  check('empty notes: returned with text:"" (counted by import, not crashed on)', () => {
    assert.strictEqual(byId['6'].text, '');
  });
}

/* ---- parse: selector FALLBACK + cite edge shapes ---- */
{
  check('selector fallback: missing cite → [data-single-file-note-refs~="<id>"]', () => {
    const n = sfNote({ id: 7, text: 'no cite on the blockquote', cite: null });
    const d = fakeDoc({ html: new FakeElement('html'), body: new FakeElement('body'), extra: [n] });
    assert.strictEqual(parseSingleFileNotes(d)[0].selector, '[data-single-file-note-refs~="7"]');
  });
  check('selector fallback: unparseable cite → same fallback', () => {
    const n = sfNote({ id: 8, text: 'garbage cite', cite: 'https://example.com/not-a-w3c-selector' });
    const d = fakeDoc({ html: new FakeElement('html'), body: new FakeElement('body'), extra: [n] });
    assert.strictEqual(parseSingleFileNotes(d)[0].selector, '[data-single-file-note-refs~="8"]');
  });
  check('selectorFromCite: greedy to the LAST ) so :not(...) selectors survive', () => {
    const sel = selectorFromCite('https://www.w3.org/TR/annotation-model/#selector(type=CssSelector,value=div:not(.skip))');
    assert.strictEqual(sel, 'div:not(.skip)');
  });
  check('selectorFromCite: percent-encoded value decodes', () => {
    const sel = selectorFromCite('https://www.w3.org/TR/annotation-model/#selector(type=CssSelector,value=%5Bdata-single-file-note-refs~%3D%223%22%5D)');
    assert.strictEqual(sel, '[data-single-file-note-refs~="3"]');
  });
  check('selectorFromCite: malformed percent-escapes degrade to the raw selector', () => {
    const sel = selectorFromCite('https://www.w3.org/TR/annotation-model/#selector(type=CssSelector,value=[data-x%=oops])');
    assert.strictEqual(sel, '[data-x%=oops]');
  });
  check('selectorFromCite: empty/absent cite → null', () => {
    assert.strictEqual(selectorFromCite(''), null);
    assert.strictEqual(selectorFromCite(null), null);
  });
}

/* ---- strip: cards go, highlights + targets stay; parse-first ordering ---- */
{
  const w = buildSyntheticWorld();
  const parsed = parseSingleFileNotes(w.doc);
  check('strip-first ordering: PARSE before STRIP reads all notes', () => assert.strictEqual(parsed.length, 6));
  const removed = stripSingleFileNoteCards(w.doc);
  check('strip: removes all 6 note ELEMENTS (shadow cards die with them)', () => assert.strictEqual(removed, 6));
  check('strip: note elements gone from the doc', () => assert.strictEqual(w.doc.querySelectorAll('single-file-note').length, 0));
  check('strip: highlights SURVIVE (separate system, kept in v0.1)', () => assert.ok(w.html.contains(w.highlight), 'the highlight span must still be in the document after the card strip'));
  check('strip: target refs attrs survive (identity attrs are not removed)', () => {
    assert.strictEqual(w.doc.querySelector('[data-single-file-note-refs~="3"]'), w.targetMulti);
    assert.strictEqual(w.doc.querySelector('[data-single-file-note-refs~="1"]'), w.target1);
  });
  check('strip: parse after strip finds nothing (idempotent re-strip = 0)', () => {
    assert.strictEqual(parseSingleFileNotes(w.doc).length, 0);
    assert.strictEqual(stripSingleFileNoteCards(w.doc), 0);
  });
}

/* ---- id determinism (recycle-proof structural identity) ---- */
{
  const note = { noteId: '3', text: 'some note text', selector: 'x' };
  check('id determinism: same capture+note+text → same id (and matches node:crypto sha1[0:8])', () => {
    const id = threadIdFor('magnific-capture', note);
    assert.strictEqual(id, `singlefile-magnific-capture-3-${createHash('sha1').update('some note text', 'utf8').digest('hex').slice(0, 8)}`);
    assert.strictEqual(threadIdFor('magnific-capture', { ...note }), id);
  });
  check('id determinism: changed TEXT → different id (recycled note id does not collide)', () => {
    assert.notStrictEqual(threadIdFor('magnific-capture', { ...note, text: 'edited text' }), threadIdFor('magnific-capture', note));
  });
  check('id determinism: different capture/note → different id', () => {
    assert.notStrictEqual(threadIdFor('other-capture', note), threadIdFor('magnific-capture', note));
    assert.notStrictEqual(threadIdFor('magnific-capture', { ...note, noteId: '4' }), threadIdFor('magnific-capture', note));
  });
  check('commentIdFor: deterministic + upstream-keyed (same thread+text → same; edit → differ)', () => {
    const a = commentIdFor('th1', note);
    assert.strictEqual(commentIdFor('th1', { ...note }), a);
    assert.notStrictEqual(commentIdFor('th1', { ...note, text: 'edited' }), a);
    assert.notStrictEqual(commentIdFor('th2', note), a);
  });
}

/* ---- runNoteImport: the full 6-note batch (fragment shape) ---- */
{
  const w = buildSyntheticWorld();
  const notes = parseSingleFileNotes(w.doc);
  stripSingleFileNoteCards(w.doc); // the adapter's order: parse → strip → capture
  const captured = [];
  const captureAnchor = (el) => {
    captured.push(el);
    return { kind: 'pin', selector: { cssSelector: '.fake' }, context: { tag: el.tagName }, bbox: { x: 5, y: 6, w: 30, h: 8 }, captureViewportWidth: 1200 };
  };
  const created = [];
  const door = {
    listIds: async () => new Set(),
    create: async (input) => {
      created.push(input);
      return { ...input, number: created.length, status: 'open' };
    },
  };
  const summary = await runNoteImport({
    captureId: 'synthetic-annotated',
    capture: { relpath: 'synthetic-annotated.html', title: 'synthetic annotated capture' },
    notes,
    doc: w.doc,
    captureAnchor,
    door,
    author: 'singlefile-import',
    now: () => '2026-10-22T00:00:00.000Z',
  });

  check('batch: 6 notes → 5 imported (1 empty), 3 pinned, 1 dangling, 1 page-level', () => {
    assert.deepStrictEqual(
      { notesTotal: summary.notesTotal, imported: summary.imported, pinned: summary.pinned, dangling: summary.dangling, pageLevel: summary.pageLevel, emptyNotes: summary.emptyNotes, failed: summary.failed },
      { notesTotal: 6, imported: 5, pinned: 3, dangling: 1, pageLevel: 1, emptyNotes: 1, failed: 0 },
    );
  });
  check('classification: NO pinnable anchor captured for dangling/page-level notes', () => {
    assert.strictEqual(captured.length, 3);
    assert.ok(captured.includes(w.target1));
    assert.strictEqual(captured.filter((el) => el === w.targetMulti).length, 2, 'multi-ref target captured once per note');
    assert.ok(!captured.includes(w.body));
  });
  check('dangling target: singleFileDangling + noteRef, bbox = the note OWN offsets, w/h = 0 (provenance only — the layer pin-render filter guarantees no pin)', () => {
    const t = created.find((c) => c.id.includes('-2-')).target;
    assert.strictEqual(t.context.singleFileDangling, true);
    assert.strictEqual(t.context.singleFileNoteRef, '2');
    assert.strictEqual(t.context.tag, 'single-file-note');
    assert.deepStrictEqual(t.bbox, { x: 112, y: 298, w: 0, h: 0 });
    assert.strictEqual(t.captureViewportWidth, 0);
  });
  check('page-level target: context text records "page-level SingleFile note"', () => {
    const t = created.find((c) => c.id.includes('-5-')).target;
    assert.strictEqual(t.context.text, 'page-level SingleFile note');
    assert.strictEqual(t.context.singleFileDangling, true);
  });
  check('pinnable target: anchor data + context.singleFileNoteRef spliced in', () => {
    const t = created.find((c) => c.id.includes('-1-')).target;
    assert.strictEqual(t.kind, 'pin');
    assert.strictEqual(t.selector.cssSelector, '.fake');
    assert.strictEqual(t.context.singleFileNoteRef, '1');
    assert.strictEqual(t.context.singleFileDangling, undefined);
  });
  check('thread input: deterministic id + storyId + component:null + story from snapshot-meta (M3 shape: title/name/url; D7 — name/title = FILENAME minus extension, never the page <title>)', () => {
    const c = created.find((x) => x.id.includes('-1-'));
    assert.strictEqual(c.id, `singlefile-synthetic-annotated-1-${sha1Hex(created ? 'normal note — first line\nsecond line with an entity: a → b & c' : '').slice(0, 8)}`);
    assert.strictEqual(c.storyId, 'synthetic-annotated');
    assert.strictEqual(c.component, null);
    assert.strictEqual(c.story.storyId, 'synthetic-annotated');
    assert.strictEqual(c.story.name, 'synthetic-annotated');
    assert.strictEqual(c.story.title, 'synthetic-annotated');
  });
  check('comment: source singlefile + importTime createdAt + deterministic id', () => {
    const c = created.find((x) => x.id.includes('-1-')).comments[0];
    assert.strictEqual(c.source, 'singlefile');
    assert.strictEqual(c.createdAt, '2026-10-22T00:00:00.000Z');
    assert.strictEqual(c.author, 'singlefile-import');
    assert.strictEqual(c.body, 'normal note — first line\nsecond line with an entity: a → b & c');
    assert.strictEqual(c.id, commentIdFor(`singlefile-synthetic-annotated-1-${sha1Hex('normal note — first line\nsecond line with an entity: a → b & c').slice(0, 8)}`, { noteId: '1', text: 'normal note — first line\nsecond line with an entity: a → b & c' }));
  });
  check('multi-ref: two notes on ONE element → two DISTINCT threads (cascade fans the pins)', () => {
    const ids = created.filter((c) => c.id.includes('-3-') || c.id.includes('-4-')).map((c) => c.id);
    assert.strictEqual(ids.length, 2);
    assert.notStrictEqual(ids[0], ids[1]);
  });
  check('danglingTarget(): offsets default to 0 when attrs are absent', () => {
    const t = danglingTarget({ noteId: '9', text: 'x', selector: 'y' });
    assert.deepStrictEqual(t.bbox, { x: 0, y: 0, w: 0, h: 0 });
  });

  /* re-import against a door that already holds the ids: replay, no creates */
  const replay = await runNoteImport({
    captureId: 'synthetic-annotated',
    capture: { relpath: 'synthetic-annotated.html' },
    notes: parseSingleFileNotes(buildSyntheticWorld().doc),
    doc: buildSyntheticWorld().doc,
    captureAnchor,
    door: {
      listIds: async () => new Set(created.map((c) => c.id)),
      create: async () => {
        throw new Error('re-import must never reach the create door');
      },
    },
    author: 'singlefile-import',
  });
  check('re-import: all importable notes skip as already-imported (NO create call, no duplicates)', () => {
    assert.strictEqual(replay.imported, 0);
    assert.strictEqual(replay.alreadyImported, 5);
    assert.strictEqual(replay.emptyNotes, 1);
    assert.strictEqual(replay.pinned, 0);
  });
}

/* ---- the tombstone doors, per note (both shapes; batch continues) ---- */
{
  const serverShape = Object.assign(new Error('id singlefile-x-1-deadbeef was deleted — tombstones are final (delete-wins). POST with a new id.'), { deletedId: true }); // the 409 {deletedId:true} envelope, preserved on the error
  const staticShape = new Error('annotakit(static): thread singlefile-x-2-feedface was deleted — deletion is final; use a NEW id (recreating with the same id resurrects a row the next merge will annihilate)');

  const mkNote = (id, text) => ({ noteId: String(id), text, offsetX: 1, offsetY: 2, selector: '[data-single-file-note-refs~="' + id + '"]' });
  const w = buildSyntheticWorld();
  const door = {
    listIds: async () => new Set(),
    create: async (input) => {
      if (input.id.includes('-1-')) throw serverShape;
      if (input.id.includes('-2-')) throw staticShape;
      return { ...input, number: 0 };
    },
  };
  const summary = await runNoteImport({
    captureId: 'tomb-test',
    capture: { relpath: 'tomb.html' },
    notes: [mkNote(1, 'server tombstone'), mkNote(2, 'static tombstone'), mkNote(3, 'healthy note')],
    doc: w.doc,
    captureAnchor: () => ({ kind: 'pin', selector: {}, context: { tag: 'div' }, bbox: { x: 0, y: 0, w: 1, h: 1 }, captureViewportWidth: 800 }),
    door,
    author: 'singlefile-import',
  });
  check('tombstones: server 409 {deletedId:true} shape AND staticStore THROW shape → both skipped as deleted (which shape is which is pinned by the isTombstoneRejection units)', () => {
    assert.strictEqual(summary.deleted, 2, JSON.stringify(summary));
    assert.strictEqual(summary.pinned, 2); // notes 1+3 matched targets; the doomed note's anchor was still captured (its CREATE was refused)
    assert.strictEqual(summary.dangling, 1); // note 2's selector matches nothing in this world
  });
  check('tombstones: the batch CONTINUES past both (healthy note imported)', () => assert.strictEqual(summary.imported, 1));
  check('tombstones: never resurrected — imported count excludes tombstoned ids', () => assert.strictEqual(summary.imported + summary.deleted + summary.failed, 3));

  check('isTombstoneRejection: recognizes both real door shapes + rejects ordinary errors', () => {
    assert.strictEqual(isTombstoneRejection(serverShape), true);
    assert.strictEqual(isTombstoneRejection(new Error('id x was deleted — tombstones are final (delete-wins). POST with a new id.')), true);
    assert.strictEqual(isTombstoneRejection(staticShape), true);
    assert.strictEqual(isTombstoneRejection(new Error('annotakit: HTTP 500')), false);
    assert.strictEqual(isTombstoneRejection(new Error('annotakit: non-JSON response (409)')), false);
    assert.strictEqual(isTombstoneRejection('string error'), false);
  });

  /* failure isolation: a generic per-note error lands in the summary */
  const w2 = buildSyntheticWorld();
  const summary2 = await runNoteImport({
    captureId: 'fail-test',
    capture: { relpath: 'f.html' },
    notes: [mkNote(1, 'doomed'), mkNote(3, 'fine')],
    doc: w2.doc,
    captureAnchor: () => ({ kind: 'pin', selector: {}, context: { tag: 'div' }, bbox: { x: 0, y: 0, w: 1, h: 1 }, captureViewportWidth: 800 }),
    door: {
      listIds: async () => new Set(),
      create: async (input) => {
        if (input.id.includes('-1-')) throw new Error('annotakit: HTTP 500 (store exploded)');
        return { ...input, number: 0 };
      },
    },
    author: 'singlefile-import',
  });
  check('failure isolation: one failing note does not abort the batch (failed=1, imported=1, error recorded)', () => {
    assert.strictEqual(summary2.failed, 1);
    assert.strictEqual(summary2.imported, 1);
    assert.match(summary2.errors[0], /note 1/);
    assert.match(summary2.errors[0], /HTTP 500/);
  });

  /* malformed selector + missing note id: honest skips, no crash */
  const w3 = buildSyntheticWorld();
  const summary3 = await runNoteImport({
    captureId: 'edge-test',
    capture: { relpath: 'e.html' },
    notes: [
      { noteId: '1', text: 'bad selector', selector: '[unclosed' },
      { noteId: '', text: 'no note id', selector: 'div' },
    ],
    doc: w3.doc,
    captureAnchor: () => null,
    door: { listIds: async () => new Set(), create: async (input) => ({ ...input, number: 0 }) },
    author: 'singlefile-import',
  });
  check('edges: malformed selector degrades to dangling; missing note id → failed, batch survives', () => {
    assert.strictEqual(summary3.dangling, 1);
    assert.strictEqual(summary3.failed, 1);
  });
}

/* -------- D13: the hide/unhide display helpers (style, never removal) -------- */
{
  const target = new FakeElement('button', { id: 'go', 'data-single-file-note-refs': '3' });
  const d = fakeDoc({ html: new FakeElement('html'), body: new FakeElement('body'), extra: [sfNote({ id: 3, text: 'note text' }), target] });
  check('D13 hideSingleFileNoteCards: injects the style, returns the count, elements STAY', () => {
    const n = hideSingleFileNoteCards(d);
    assert.strictEqual(n, 1);
    const style = d.querySelector(`style[${SF_HIDE_STYLE_ATTR}]`);
    assert.ok(style, 'the hide style exists in the tree');
    assert.strictEqual(style.media, 'all');
    assert.strictEqual(d.querySelectorAll('single-file-note').length, 1, 'the note ELEMENT stays in the tree');
    assert.strictEqual(singleFileNoteCardsVisible(d), false);
  });
  check('D13 setSingleFileNoteCardsVisible(true): the media flips, state reads visible', () => {
    setSingleFileNoteCardsVisible(d, true);
    assert.strictEqual(d.querySelector(`style[${SF_HIDE_STYLE_ATTR}]`).media, 'not all');
    assert.strictEqual(singleFileNoteCardsVisible(d), true);
  });
  check('D13 round-trip: hide -> visible -> hidden is idempotent, ONE style element', () => {
    setSingleFileNoteCardsVisible(d, false);
    setSingleFileNoteCardsVisible(d, false); // idempotent
    hideSingleFileNoteCards(d);
    assert.strictEqual(d.querySelectorAll(`style[${SF_HIDE_STYLE_ATTR}]`).length, 1, 'exactly one style');
    assert.strictEqual(singleFileNoteCardsVisible(d), false);
    assert.strictEqual(d.querySelectorAll('single-file-note').length, 1, 'still in the tree');
  });
  check('D13 visible-by-default: no style = visible', () => {
    const d2 = fakeDoc({ html: new FakeElement('html'), body: new FakeElement('body'), extra: [] });
    assert.strictEqual(singleFileNoteCardsVisible(d2), true);
  });
  check('D13 legacy strip still removes (pinned semantics, no production caller)', () => {
    const removed = stripSingleFileNoteCards(d);
    assert.strictEqual(removed, 1);
    assert.strictEqual(d.querySelectorAll('single-file-note').length, 0);
  });
}

/* ---- audit round-1 P1 guard: the static migration writes through `patch` ----
 * The bug: migrateLegacySingleFileAnchors duck-typed store.update?.() — the
 * static store has NO update (it is `patch`), so the migration silently
 * no-op'd while reporting "migrated" and latched the one-time flag. This pin
 * fails if anyone renames the write door again. */
{
  /* the check() helper is sync — top-level await settles the module FIRST.
   * The store is INSTANTIATED via getStaticStore() (localStorage shims like
   * the static-store suite uses); the write doors live on the INSTANCE. */
  const staticStoreMod = await import(path.join(root, 'dist/staticStore.mjs'));
  let storeProto = [];
  try {
    const inst = await staticStoreMod.getStaticStore();
    storeProto = Object.getOwnPropertyNames(Object.getPrototypeOf(inst) ?? {});
  } catch {
    /* no localStorage in this harness shape — fall back to the source-level interface check below */
  }
  const interfaceText = readFileSync(path.join(root, 'src/shared/staticStore.ts'), 'utf8');
  check('static store exposes patch() and NOT update() — the migration write door is patch', () => {
    if (storeProto.length > 0) {
      assert.ok(storeProto.includes('patch'), 'patch is the static write door (instance)');
      assert.ok(!storeProto.includes('update'), 'update must not exist (a duck-typed call would silently no-op — audit P1)');
    } else {
      assert.match(interfaceText, /patch\(thread: Thread/, 'StaticStore interface declares patch(thread');
      assert.doesNotMatch(interfaceText, /update\(thread: Thread/, 'StaticStore interface must NOT declare update (audit P1 guard)');
    }
  });
}

/* ---- summary formatting ---- */
{
  check('formatImportSummary: the loud notice shape', () => {
    const s = formatImportSummary({ notesTotal: 4, cardsHidden: 4, imported: 4, alreadyImported: 1, deleted: 1, emptyNotes: 1, pinned: 4, dangling: 0, pageLevel: 0, failed: 0, errors: [] });
    assert.strictEqual(s, 'Imported 4 notes · skipped 3 (already imported/deleted: 2, empty: 1)');
  });
  check('formatImportSummary: zero-skip single note', () => {
    const s = formatImportSummary({ notesTotal: 1, cardsHidden: 1, imported: 1, alreadyImported: 0, deleted: 0, emptyNotes: 0, pinned: 1, dangling: 0, pageLevel: 0, failed: 0, errors: [] });
    assert.strictEqual(s, 'Imported 1 note · skipped 0');
  });
}

/* ---- fixture file audits (real bytes, no DOM parser needed) ---- */
{
  const readFixture = (p) => readFileSync(path.join(root, 'fixtures', p), 'utf8');
  const synth = readFixture('synthetic-annotated.html');
  /* the REAL annotated capture is dev-repo-only review data (it does not ship
   * in the public release — scripts/stage-release.mjs excludes it); when it is
   * absent, the real-fixture audits SKIP loudly instead of failing. */
  const realPath = path.join(root, 'fixtures', 'magnific-folder-new-asset-flow-annotated.html');
  const real = existsSync(realPath) ? readFileSync(realPath, 'utf8') : null;
  if (!real) console.log('  (skip: fixtures/magnific-folder-new-asset-flow-annotated.html absent — real-capture audits are dev-repo-only)');

  check('fixture audit: synthetic fixture carries 6 single-file-note elements', () => {
    assert.strictEqual((synth.match(/<single-file-note /g) || []).length, 6);
  });
  check('fixture audit: synthetic fixture uses the EXACT serialization shape (template shadowrootmode=open + blockquote cite pattern)', () => {
    assert.match(synth, /<template shadowrootmode=open>/);
    const cites = [...synth.matchAll(/cite='([^']*)'/g)].map((m) => m[1]);
    assert.strictEqual(cites.length, 6);
    for (const c of cites) assert.strictEqual(selectorFromCite(c) != null, true, `cite must decode: ${c}`);
    assert.ok(synth.includes('data-single-file-note-refs="3 4"'), 'multi-ref target must be quoted (space-separated list)');
    assert.ok(synth.includes('single-file-highlight-yellow'), 'highlight must be present (strip-survival audit)');
  });
  check('fixture audit: real annotated capture carries 4 notes + multi-line entity-rich text', () => {
    if (!real) return; // dev-repo-only fixture absent (public release) — skipped
    assert.strictEqual((real.match(/<single-file-note /g) || []).length, 4);
    const bodies = [...real.matchAll(/<textarea dir=auto>([\s\S]*?)<\/textarea>/g)].map((m) => m[1]);
    assert.strictEqual(bodies.length, 4);
    assert.ok(bodies.some((b) => b.includes('\n')), 'a note body must carry a literal newline');
    assert.ok(bodies.some((b) => b.includes('&gt;')), 'a note body must carry an HTML entity');
  });
  check('fixture audit: every real-fixture cite decodes through selectorFromCite', () => {
    if (!real) return; // dev-repo-only fixture absent (public release) — skipped
    const cites = [...real.matchAll(/cite='([^']*)'/g)].map((m) => m[1]);
    assert.strictEqual(cites.length, 4);
    const sels = cites.map((c) => selectorFromCite(c));
    for (const s of sels) assert.match(s, /^\[data-single-file-note-refs~="\d+"\]$/);
  });
}

/* ------------------------------ total ------------------------------ */

console.log(`\n${passed} passed, ${failed} failed (singlefile import suite — Node/fragment shape; the shadowRoot/live-parse half is pinned by the agent-browser E2E)`);
if (failed > 0) process.exit(1);
