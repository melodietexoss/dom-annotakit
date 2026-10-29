#!/usr/bin/env node
/**
 * dom-annotakit — the spec-catalog suite (D10/D11, design 2026-10-26 + §9).
 *
 * Drives the PURE module (dist/specCatalog.mjs) jsdom-free: the combobox
 * reducer matrix (typeahead/keyboard/create-on-new), the D11 filter model
 * (two-level epic→story, unfiled-never-matches, story-scoping, the
 * story-cleared-on-epic-mismatch transition), the rollup + board merge, and
 * the D10 context text transform (per-key escalation, empty-body skip).
 *
 * Node only — no DOM, no fetch, no React. Run: npm run test:spec-catalog
 */
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const {
  buildSpecIndex,
  mergeCatalog,
  comboOptions,
  comboReduce,
  COMBO_INIT,
  filterCaptureCounts,
  filterCaptureIds,
  storiesForEpic,
  nextSelection,
  threadMatchesSelection,
  applySpecContext,
  specNameCompare,
} = await import(path.join(root, 'dist/specCatalog.mjs'));

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

/* ------------------------------ the rollups ------------------------------ */

const THREADS = [
  {
    id: 'th_a',
    storyId: 'magnific-folder',
    comments: [{ body: 'the filters pill bar is cramped\n@epic: Folder UX Overhaul\n@story: Filters panel' }],
  },
  {
    id: 'th_b',
    storyId: 'magnific-folder',
    comments: [{ body: 'second pin same story' }, { body: '@epic: Folder UX Overhaul\n@story: Filters panel' }],
  },
  {
    id: 'th_c',
    storyId: 'luma-prompt',
    comments: [{ body: '@story: Prompt presets\n@epic: Creator flows' }],
  },
  { id: 'th_d', storyId: 'luma-prompt', comments: [{ body: 'unfiled pin — no directives' }] },
  { id: 'th_e', storyId: 'rh-feed', comments: [{ body: '@epic: Folder UX Overhaul' }] },
];

const IDX = buildSpecIndex(THREADS);

check('buildSpecIndex: epics sorted, deduped', () => {
  assert.deepStrictEqual(IDX.epics, ['Creator flows', 'Folder UX Overhaul']);
});

check('buildSpecIndex: story→epic co-occurrence edges', () => {
  const filters = IDX.stories.find((s) => s.name === 'Filters panel');
  assert.deepStrictEqual(filters?.epics, ['Folder UX Overhaul']);
  const presets = IDX.stories.find((s) => s.name === 'Prompt presets');
  assert.deepStrictEqual(presets?.epics, ['Creator flows']);
});

check('buildSpecIndex: per-capture rollup counts', () => {
  assert.deepStrictEqual(IDX.captures['magnific-folder'], {
    epics: { 'Folder UX Overhaul': 2 },
    stories: { 'Filters panel': 2 },
    pairs: { 'Folder UX Overhaul\u0000Filters panel': 2 },
  });
  assert.strictEqual(IDX.captures['rh-feed'].epics['Folder UX Overhaul'], 1);
  assert.strictEqual(IDX.captures['rh-feed'].stories['Filters panel'], undefined);
  assert.strictEqual(IDX.captures['luma-prompt'].epics['Creator flows'], 1);
});

check('buildSpecIndex: LAST-WINS directive resolution per thread', () => {
  const refiled = buildSpecIndex([
    { id: 'x', storyId: 'cap', comments: [{ body: '@epic: A' }, { body: '@epic: B' }] },
  ]);
  assert.deepStrictEqual(refiled.captures.cap.epics, { B: 1 });
  assert.deepStrictEqual(refiled.captures.cap.pairs, {});
});

check('mergeCatalog: board options ∪ local, thread edges SUPERSEDE', () => {
  const board = {
    epics: ['Folder UX Overhaul', 'Legacy epic'],
    stories: [
      { name: 'Filters panel', epics: ['STALE EDGE'] }, // board edge — superseded by the store
      { name: 'Board-only story', epics: [] }, // an option no thread used yet
    ],
    captures: {},
  };
  const merged = mergeCatalog(board, IDX);
  assert.ok(merged.epics.includes('Legacy epic'), 'board-only epic survives');
  assert.ok(merged.epics.includes('Creator flows'), 'local epic joins');
  const filters = merged.stories.find((s) => s.name === 'Filters panel');
  assert.deepStrictEqual(filters.epics, ['Folder UX Overhaul'], 'thread edge wins over the board edge');
  const boardOnly = merged.stories.find((s) => s.name === 'Board-only story');
  assert.deepStrictEqual(boardOnly.epics, [], 'board-only story keeps its (empty) edges');
  assert.ok(merged.stories.some((s) => s.name === 'Prompt presets'), 'local story joins');
});

/* ------------------------------ D11 filtering ------------------------------ */

check('threadMatchesSelection: unfiled threads never match', () => {
  assert.strictEqual(threadMatchesSelection({}, { epic: 'X' }), false);
  assert.strictEqual(threadMatchesSelection({}, { epic: 'X', story: 'Y' }), false);
});

check('threadMatchesSelection: per-key AND', () => {
  assert.strictEqual(threadMatchesSelection({ epic: 'X', story: 'Y' }, { epic: 'X' }), true);
  assert.strictEqual(threadMatchesSelection({ epic: 'X', story: 'Y' }, { epic: 'X', story: 'Y' }), true);
  assert.strictEqual(threadMatchesSelection({ epic: 'X', story: 'Y' }, { epic: 'X', story: 'Z' }), false);
  assert.strictEqual(threadMatchesSelection({ story: 'Y' }, { story: 'Y' }), true);
});

check('filterCaptureCounts: single-level counts are exact (epic)', () => {
  const c = filterCaptureCounts(IDX, { epic: 'Folder UX Overhaul', story: null });
  assert.deepStrictEqual(c, { 'magnific-folder': 2, 'rh-feed': 1 });
});

check('filterCaptureCounts: two-level counts are PAIR-EXACT (a story under another epic never inflates the chip)', () => {
  // IDX shape (fixture): magnific-folder has 2x (Folder UX Overhaul · Filters panel);
  // rh-feed has 1x Folder UX Overhaul with NO story — the pair count is 0 there.
  const c = filterCaptureCounts(IDX, { epic: 'Folder UX Overhaul', story: 'Filters panel' });
  assert.deepStrictEqual(c, { 'magnific-folder': 2 });
});

check('filterCaptureCounts: empty selection = no counts', () => {
  assert.deepStrictEqual(filterCaptureCounts(IDX, { epic: null, story: null }), {});
});

check('filterCaptureIds: epic level', () => {
  assert.deepStrictEqual(filterCaptureIds(IDX, { epic: 'Folder UX Overhaul', story: null }).sort(), ['magnific-folder', 'rh-feed']);
});

check('filterCaptureIds: two levels AND', () => {
  assert.deepStrictEqual(filterCaptureIds(IDX, { epic: 'Folder UX Overhaul', story: 'Filters panel' }), ['magnific-folder']);
  assert.deepStrictEqual(filterCaptureIds(IDX, { epic: 'Folder UX Overhaul', story: 'Prompt presets' }), []);
});

check('filterCaptureIds: no selection = no filter', () => {
  assert.deepStrictEqual(filterCaptureIds(IDX, { epic: null, story: null }), []);
});

check('storiesForEpic: scoped + epic-agnostic, other-epic stories excluded', () => {
  const merged = mergeCatalog(
    { epics: ['E1', 'E2'], stories: [{ name: 'S-other', epics: ['E2'] }, { name: 'S-agnostic', epics: [] }], captures: {} },
    IDX,
  );
  const names = storiesForEpic(merged, 'Folder UX Overhaul').map((s) => s.name);
  assert.ok(names.includes('Filters panel'), 'the epic-scoped story lists first');
  assert.ok(!names.includes('S-other'), 'a story known under another epic never lists');
  assert.ok(names.includes('S-agnostic'), 'epic-agnostic stories still list');
  assert.strictEqual(storiesForEpic(merged, null).length, merged.stories.length, 'no epic = all stories');
});

check('nextSelection: epic switch clears a story filed under another epic (the surprise is TEST-PINNED)', () => {
  const sel = nextSelection({ epic: 'Folder UX Overhaul', story: 'Filters panel' }, { epic: 'Creator flows' }, IDX);
  assert.strictEqual(sel.epic, 'Creator flows');
  assert.strictEqual(sel.story, null, 'the story is cleared — Filters panel has no edge to Creator flows');
});

check('nextSelection: epic-agnostic story survives the switch', () => {
  const merged = mergeCatalog({ epics: [], stories: [{ name: 'S-agnostic', epics: [] }], captures: {} }, IDX);
  const sel = nextSelection({ epic: 'E1', story: 'S-agnostic' }, { epic: 'E2' }, merged);
  assert.strictEqual(sel.story, 'S-agnostic', 'no edges = epic-agnostic = survives');
});

check('nextSelection: an epic-only null patch KEEPS the story — why the banner needs BOTH keys', () => {
  const sel = nextSelection({ epic: 'Folder UX Overhaul', story: 'Filters panel' }, { epic: null }, IDX);
  assert.deepStrictEqual(sel, { epic: null, story: 'Filters panel' }, 'chip-× semantics: clearing ONE level keeps the other');
});

check('nextSelection: a BOTH-keys null patch clears everything (the banner path)', () => {
  const sel = nextSelection({ epic: 'Folder UX Overhaul', story: 'Filters panel' }, { epic: null, story: null }, IDX);
  assert.deepStrictEqual(sel, { epic: null, story: null });
});

check('nextSelection: matching edge survives', () => {
  const sel = nextSelection({ epic: 'A', story: 'Filters panel' }, { epic: 'Folder UX Overhaul' }, IDX);
  assert.strictEqual(sel.story, 'Filters panel');
});

/* --------------------------- the combobox reducer --------------------------- */

/* the reducer SORTS options (rank, then base-insensitive name) — callers
 * (specBox) pass already-sorted catalogs, and the reducer's own order is
 * what the active row indexes against. Fixtures here use sorted inputs. */
const SRC = ['Creator flows', 'Filters panel', 'Folder UX Overhaul', 'Prompts'];

check('comboOptions: unfiltered = all options (rank, then name)', () => {
  assert.deepStrictEqual(
    comboOptions(SRC, '').map((r) => r.value),
    SRC,
  );
});

check('comboOptions: substring typeahead, PREFIX-first', () => {
  // fixture letters chosen so the substring ACTUALLY occurs in both names
  const rows = comboOptions(['a: foo bar', 'b: other foo thing', 'c: nope'], 'foo');
  assert.deepStrictEqual(
    rows.filter((r) => r.kind === 'option').map((r) => r.value),
    ['a: foo bar', 'b: other foo thing'],
    'the prefix match leads, the plain contains match follows (name-tiebreak)',
  );
  const prefixed = comboOptions(['b card', 'a button', 'button'], 'button').map((r) => r.value);
  assert.deepStrictEqual(prefixed, ['button', 'a button'], 'startsWith matches lead');
});

check('comboOptions: case-insensitive; an exact casefold match suppresses the create row', () => {
  const rows = comboOptions(SRC, 'FOLDER');
  assert.deepStrictEqual(
    rows.filter((r) => r.kind === 'option').map((r) => r.value),
    ['Folder UX Overhaul'],
  );
  assert.strictEqual(rows[0].kind, 'create', 'FOLDER (≠ the option name) is a legitimate new value');
  const exact = comboOptions(SRC, 'folder ux overhaul');
  assert.ok(exact.every((r) => r.kind === 'option'), 'exact casefold match = no create row');
  assert.strictEqual(exact[0].value, 'Folder UX Overhaul');
});

check('comboOptions: no exact match → a CREATE row mints the typed value', () => {
  const rows = comboOptions(SRC, 'Brand new epic');
  assert.strictEqual(rows[0].kind, 'create');
  assert.strictEqual(rows[0].value, 'Brand new epic');
});

check('comboOptions: an exact (casefold) match → NO create row', () => {
  const rows = comboOptions(SRC, 'folder ux overhaul');
  assert.ok(rows.every((r) => r.kind === 'option'));
  assert.strictEqual(rows[0].value, 'Folder UX Overhaul');
});

check('comboOptions: create row CLIPS to the trimmed value', () => {
  const rows = comboOptions(SRC, '  Padded new  ');
  assert.strictEqual(rows[0].value, 'Padded new');
});

const reduce = (state, action) => comboReduce(state, action, SRC);

check('comboReduce: open resets query + active', () => {
  const s = reduce({ open: false, query: 'zz', active: 3, selected: 'X' }, { type: 'open' });
  assert.deepStrictEqual({ open: s.open, query: s.query, active: s.active }, { open: true, query: '', active: 0 });
  assert.strictEqual(s.selected, 'X', 'opening never drops the selection');
});

check('comboReduce: typing filters + resets active to 0', () => {
  const s = reduce(reduce(COMBO_INIT, { type: 'open' }), { type: 'type', query: 'flo' });
  assert.strictEqual(s.active, 0);
  assert.strictEqual(s.query, 'flo');
});

check('comboReduce: move clamps at BOTH edges (no wraparound)', () => {
  let s = reduce(COMBO_INIT, { type: 'open' });
  s = reduce(s, { type: 'move', delta: -1 });
  assert.strictEqual(s.active, 0, 'up from the top stays');
  s = reduce(s, { type: 'move', delta: 99 });
  assert.strictEqual(s.active, SRC.length - 1, 'down past the bottom clamps to the last row');
  s = reduce(s, { type: 'move', delta: -1 });
  assert.strictEqual(s.active, SRC.length - 2);
});

check('comboReduce: commit selects the active row + closes', () => {
  let s = reduce(COMBO_INIT, { type: 'open' });
  s = reduce(s, { type: 'move', delta: 1 });
  s = reduce(s, { type: 'commit' });
  assert.strictEqual(s.selected, SRC[1]);
  assert.strictEqual(s.open, false);
  assert.strictEqual(s.query, '');
});

check('comboReduce: commit on a create row selects the NEW value', () => {
  let s = reduce(COMBO_INIT, { type: 'open' });
  s = reduce(s, { type: 'type', query: 'New thing' });
  s = reduce(s, { type: 'commit' });
  assert.strictEqual(s.selected, 'New thing');
});

check('comboReduce: close keeps the previous selection, drops the query', () => {
  const s = reduce({ open: true, query: 'flo', active: 1, selected: 'Old' }, { type: 'close' });
  assert.deepStrictEqual(s, { open: false, query: '', active: 1, selected: 'Old' });
});

check('comboReduce: select(null) clears (the chip × path)', () => {
  const s = reduce({ open: true, query: 'x', active: 0, selected: 'Old' }, { type: 'select', value: null });
  assert.strictEqual(s.selected, null);
  assert.strictEqual(s.open, false);
});

check('comboReduce: clear resets to COMBO_INIT', () => {
  const s = reduce({ open: true, query: 'x', active: 2, selected: 'Old' }, { type: 'clear' });
  assert.deepStrictEqual(s, COMBO_INIT);
});

check('comboReduce: typing an EMPTY query = full list (no create row)', () => {
  const s = reduce({ open: true, query: 'zzz', active: 0, selected: null }, { type: 'type', query: '' });
  assert.strictEqual(comboOptions(SRC, s.query).length, SRC.length);
});

check('comboReduce: move on an EMPTY filtered list is a no-op', () => {
  const s = reduce({ open: true, query: 'qqqqqq', active: 0, selected: null }, { type: 'move', delta: 1 });
  assert.strictEqual(s.active, 0);
});

check('specNameCompare: base-insensitive ordering', () => {
  const arr = ['b', 'A', 'á'];
  arr.sort(specNameCompare);
  assert.deepStrictEqual(arr, ['A', 'á', 'b']);
});

/* ------------------------ the D10 context transform ------------------------ */

check('applySpecContext: appends MISSING keys as directive lines', () => {
  const out = applySpecContext('the pill bar is cramped', { epic: 'Folder UX', story: 'Filters' });
  assert.strictEqual(out, 'the pill bar is cramped\n@epic: Folder UX\n@story: Filters');
});

check('applySpecContext: PER-KEY escalation — the comment\'s own directive wins, the missing key joins', () => {
  const out = applySpecContext('note\n@epic: Mine', { epic: 'Context', story: 'Filters' });
  assert.strictEqual(out, 'note\n@epic: Mine\n@story: Filters');
});

check('applySpecContext: fully-directed comments pass UNTOUCHED (byte-identical)', () => {
  const body = 'note\n@epic: A\n@story: B';
  assert.strictEqual(applySpecContext(body, { epic: 'X', story: 'Y' }), body);
});

check('applySpecContext: EMPTY body is never context-only (§9 P3-13)', () => {
  assert.strictEqual(applySpecContext('   ', { epic: 'X' }), '   ');
  assert.strictEqual(applySpecContext('', { epic: 'X', story: 'Y' }), '');
});

check('applySpecContext: no context = identity', () => {
  const body = 'plain';
  assert.strictEqual(applySpecContext(body, null), body);
  assert.strictEqual(applySpecContext(body, {}), body);
  assert.strictEqual(applySpecContext(body, { epic: '  ', story: '' }), body, 'blank values are not context');
});

check('applySpecContext: trailing whitespace is trimmed before appending', () => {
  const out = applySpecContext('note\n\n', { epic: 'E' });
  assert.strictEqual(out, 'note\n@epic: E');
});

check('applySpecContext: directive INLINE in text (not line-start) is NOT treated as a directive', () => {
  // parseSpecDirectives only matches line-start @epic:/story: — an inline
  // mention must not suppress the context (nor be stripped by the title path)
  const out = applySpecContext('we discussed @epic: here', { epic: 'E' });
  assert.strictEqual(out, 'we discussed @epic: here\n@epic: E');
});

/* ---------------------------------- report ---------------------------------- */

console.log(
  failed === 0
    ? `\n${passed} passed, 0 failed (spec-catalog suite — D10/D11 reducer + filter + context matrix)`
    : `\n${passed} passed, ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
