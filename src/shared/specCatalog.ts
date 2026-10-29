/**
 * dom-annotakit — the spec catalog (D10/D11, design 2026-10-26 §D10-D11 + §9).
 *
 * ISOMORPHIC + PURE: no DOM, no fetch, no React — the SAME module drives the
 * Toolbar comboboxes (host window), the Sidebar/Panel filters, and the
 * Node-side endpoint merge (scripts/spec-catalog-test.mjs drives every path
 * with plain data).
 *
 * The catalog answers three questions:
 *   1. WHICH epics/stories exist? — board field options (the reconciler's
 *      pass snapshot) ∪ thread-derived directives (the local store may run
 *      ahead of the board between passes) — union, sorted, base-insensitive
 *      dedup (diacritic-distinct values stay DISTINCT; only the TYPEAHEAD
 *      filter is base-insensitive).
 *   2. which STORY belongs to which EPIC? — co-occurrence edges: a thread
 *      (or board item) filed under both supplies the edge; thread-derived
 *      edges SUPERSEDE board-derived ones (the store is fresher than the
 *      last pass). A story with no edge yet is epic-agnostic.
 *   3. WHICH captures match a selection? — per-capture rollup of thread
 *      directives; the filter is two-level (epic, then story within it).
 */

import { threadSpecDirectives, parseSpecDirectives, type SpecDirectives } from './specDirectives';

/* ---------------------------------- shapes ---------------------------------- */

/** One story's known epic associations (0..n — a value may be reused across
 *  epics until the board settles; the combobox scopes to the SELECTED epic). */
export interface SpecStoryInfo {
  name: string;
  epics: string[];
}

/** Epic/story usage rollup per capture — the D11 filter index.
 *  `pairs` (s6): epic⋄story PAIR counts keyed `epic\u0000story` — the
 *  per-capture match-count chips stay EXACT under two-level selections
 *  (the flat story count would over-report a story filed under another
 *  epic on the same capture). */
export interface SpecCaptureRollup {
  epics: Record<string, number>;
  stories: Record<string, number>;
  pairs: Record<string, number>;
}

/** The merged catalog served by GET /dom-annotakit-spec.json (minus the
 *  context echo, which the sidecar adds). */
export interface SpecCatalog {
  epics: string[];
  stories: SpecStoryInfo[];
  captures: Record<string, SpecCaptureRollup>;
}

/** The session compose context (D10 dual purpose: filter + file-on-create). */
export interface SpecContext {
  epic?: string | null;
  story?: string | null;
}

/** The minimal thread shape the rollup needs (id/storyId/comments) — the
 *  store's Thread satisfies it structurally; tests pass literals. */
export interface SpecThreadLike {
  id: string;
  storyId: string;
  comments?: { body?: unknown }[];
}

/* ------------------------------ name utilities ------------------------------ */

const collator = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Base-insensitive comparison for SORTING (not identity). */
export function specNameCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Typeahead filter: casefold + substring. */
function typeaheadMatch(name: string, q: string): boolean {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return true;
  return name.toLocaleLowerCase().includes(needle);
}

/** Prefix-first ordering: startsWith matches lead, then plain contains. */
function typeaheadRank(name: string, q: string): number {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return 1;
  return name.toLocaleLowerCase().startsWith(needle) ? 0 : 1;
}

/* ------------------------------- the rollups -------------------------------- */

/**
 * Thread-derived catalog + per-capture rollup (D11's filter index).
 * Directives resolve per-thread via threadSpecDirectives (comments in order,
 * last wins) — the SAME resolution the board mirror uses, so the filter can
 * never disagree with the board's filing.
 */
export function buildSpecIndex(threads: SpecThreadLike[]): SpecCatalog {
  const epicSet = new Set<string>();
  const storyMap = new Map<string, Set<string>>();
  const captures: Record<string, SpecCaptureRollup> = {};
  for (const t of threads) {
    const bodies = (t.comments ?? []).map((c) => String(c.body ?? ''));
    const d = threadSpecDirectives(bodies);
    const roll = (captures[t.storyId] ??= { epics: {}, stories: {}, pairs: {} });
    if (d.epic) {
      epicSet.add(d.epic);
      roll.epics[d.epic] = (roll.epics[d.epic] ?? 0) + 1;
    }
    if (d.story) {
      storyMap.set(d.story, storyMap.get(d.story) ?? new Set());
      roll.stories[d.story] = (roll.stories[d.story] ?? 0) + 1;
      if (d.epic) {
        storyMap.get(d.story)!.add(d.epic); // the co-occurrence edge
        const pk = `${d.epic}\u0000${d.story}`;
        roll.pairs[pk] = (roll.pairs[pk] ?? 0) + 1;
      }
    }
  }
  const stories: SpecStoryInfo[] = [...storyMap.entries()]
    .map(([name, epics]) => ({ name, epics: [...epics].sort(specNameCompare) }))
    .sort((a, b) => specNameCompare(a.name, b.name));
  return { epics: [...epicSet].sort(specNameCompare), stories, captures };
}

/** Merge the board-derived catalog (options + pass edges) with the fresher
 *  thread-derived one. Thread edges SUPERSEDE pass edges for the SAME story
 *  (§9 fold 7); board-only options survive with their pass edges intact. */
export function mergeCatalog(board: SpecCatalog | null, local: SpecCatalog): SpecCatalog {
  const a = board ?? { epics: [], stories: [], captures: {} };
  const epicSet = new Set([...a.epics, ...local.epics]);
  const storyMap = new Map<string, Set<string>>();
  for (const s of a.stories) storyMap.set(s.name, new Set(s.epics));
  for (const s of local.stories) {
    if (storyMap.has(s.name)) storyMap.get(s.name)!.clear(); // store is fresher
    for (const e of s.epics) (storyMap.get(s.name) ?? new Set()).add(e);
    if (!storyMap.has(s.name)) storyMap.set(s.name, new Set(s.epics));
  }
  return {
    epics: [...epicSet].sort(specNameCompare),
    stories: [...storyMap.entries()]
      .map(([name, epics]) => ({ name, epics: [...epics].sort(specNameCompare) }))
      .sort((x, y) => specNameCompare(x.name, y.name)),
    captures: local.captures, // board items carry no capture rollup — the store owns it
  };
}

/* ------------------------------ D11 filtering ------------------------------- */

export interface SpecSelection {
  epic?: string | null;
  story?: string | null;
}

/** Does a thread's directive resolution match the selection? Unfiled threads
 *  (no directives) never match ANY selection (§D11). */
export function threadMatchesSelection(d: SpecDirectives, sel: SpecSelection): boolean {
  if (sel.epic && d.epic !== sel.epic) return false;
  if (sel.story && d.story !== sel.story) return false;
  return Boolean(sel.epic || sel.story);
}

/** s6: per-capture MATCH-COUNTS for the selection — the sidebar's filter
 *  chips (and filterCaptureIds, which delegates here). The count is the
 *  MOST SPECIFIC constraint's, PAIR-EXACT under a two-level selection. */
export function filterCaptureCounts(catalog: SpecCatalog | null, sel: SpecSelection): Record<string, number> {
  const epic = sel.epic ?? null;
  const story = sel.story ?? null;
  if (!epic && !story) return {};
  const out: Record<string, number> = {};
  const src = catalog ?? { epics: [], stories: [], captures: {} };
  for (const [id, roll] of Object.entries(src.captures)) {
    const epicOk = !epic || (roll.epics[epic] ?? 0) > 0;
    const storyOk = !story || (roll.stories[story] ?? 0) > 0;
    if (!epicOk || !storyOk) continue;
    let n = 0;
    if (epic && story) n = roll.pairs[`${epic}\u0000${story}`] ?? 0;
    else if (story) n = roll.stories[story] ?? 0;
    else if (epic) n = roll.epics[epic] ?? 0;
    out[id] = n;
  }
  return out;
}

/** The capture ids matching the selection (≥1 matching thread). */
export function filterCaptureIds(catalog: SpecCatalog | null, sel: SpecSelection): string[] {
  return Object.keys(filterCaptureCounts(catalog, sel));
}

/** Stories visible for the selected epic: co-occurrence edges first, then
 *  epic-agnostic stories (never stories KNOWN under a different epic — the
 *  reducer clears those instead, this only feeds the dropdown). */
export function storiesForEpic(catalog: SpecCatalog | null, epic: string | null): SpecStoryInfo[] {
  const src = catalog ?? { epics: [], stories: [], captures: {} };
  if (!epic) return src.stories;
  const scoped: SpecStoryInfo[] = [];
  const other: SpecStoryInfo[] = [];
  for (const s of src.stories) {
    if (s.epics.includes(epic)) scoped.push(s);
    else if (s.epics.length === 0) other.push(s);
  }
  return [...scoped, ...other];
}

/**
 * The selection TRANSITION — pure, so the surprise ("picking an epic that
 * has no edge to the picked story clears the story") is test-pinned and the
 * UI can announce it (§9 P3 fold: visible chip-fade + live region).
 *
 * Two-level integrity: after the patch, when BOTH an epic and a story are
 * set, the story must either carry an edge to that epic or be
 * epic-agnostic (no edges yet). A story known ONLY under another epic is
 * CLEARED — the reducer says so, the UI announces it.
 */
export function nextSelection(
  cur: SpecSelection,
  patch: SpecSelection,
  catalog: SpecCatalog | null,
): SpecSelection {
  const epic = 'epic' in patch ? patch.epic ?? null : cur.epic ?? null;
  let story = 'story' in patch ? patch.story ?? null : cur.story ?? null;
  if (epic && story) {
    const edges = catalog?.stories.find((s) => s.name === story)?.epics ?? [];
    if (edges.length > 0 && !edges.includes(epic)) story = null;
  }
  return { epic, story };
}

/* -------------------------- the combobox reducer ---------------------------- */

/**
 * ONE combobox (Epic or Story) — the D10 contract, pure:
 *   click / chord → open (query '', active 0)
 *   typing filters (casefold substring, prefix-first)
 *   ↑/↓ move (clamp at edges — no wraparound), Enter commits, Esc closes
 *   Tab commits a typed-new value AND CONTINUES (focus proceeds — never traps)
 *   a non-empty query with NO exact match mints a `create` row (auto-create)
 */
export type ComboRow = { kind: 'option' | 'create'; value: string };

export interface ComboState {
  open: boolean;
  query: string;
  active: number;
  selected: string | null;
}

export const COMBO_INIT: ComboState = { open: false, query: '', active: 0, selected: null };

export function comboOptions(source: readonly string[], query: string): ComboRow[] {
  const rows: ComboRow[] = source
    .filter((v) => typeaheadMatch(v, query))
    .sort((a, b) => typeaheadRank(a, query) - typeaheadRank(b, query) || specNameCompare(a, b))
    .map((v) => ({ kind: 'option' as const, value: v }));
  const q = query.trim();
  if (q && !source.some((v) => v.toLocaleLowerCase() === q.toLocaleLowerCase())) {
    rows.unshift({ kind: 'create', value: q });
  }
  return rows;
}

export type ComboAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'type'; query: string }
  | { type: 'move'; delta: number }
  | { type: 'commit' }
  | { type: 'select'; value: string | null }
  | { type: 'clear' };

export function comboReduce(state: ComboState, action: ComboAction, source: readonly string[]): ComboState {
  switch (action.type) {
    case 'open':
      return { ...state, open: true, query: '', active: 0 };
    case 'close':
      return { ...state, open: false, query: '' };
    case 'type':
      return { ...state, open: true, query: action.query, active: 0 };
    case 'move': {
      if (!state.open) return state;
      const rows = comboOptions(source, state.query);
      if (rows.length === 0) return state;
      const next = state.active + action.delta;
      return { ...state, active: Math.max(0, Math.min(rows.length - 1, next)) };
    }
    case 'commit': {
      const rows = comboOptions(source, state.query);
      const row = rows[state.active] ?? rows[0];
      if (!row) return { ...state, open: false, query: '' };
      return { open: false, query: '', active: 0, selected: row.value };
    }
    case 'select':
      return { open: false, query: '', active: 0, selected: action.value };
    case 'clear':
      return { ...COMBO_INIT, selected: null };
  }
}

/* ------------------------- compose-context helpers -------------------------- */

/**
 * The D10 context injection — PURE text transform (the server seam applies
 * it; tests pin the matrix). Rules (§D10 + §9 P3 folds):
 *   - per KEY escalation: the comment's own directive wins (never rewritten);
 *     a MISSING key gets the context value;
 *   - empty/whitespace body → UNTOUCHED (a context-only comment is a weird
 *     artifact; the engine's empty-body door stays its own);
 *   - context absent for a key → that key never injected;
 *   - injected lines are ORDINARY directive lines (visible, editable, and
 *     they flow to the board body verbatim — the record stays honest).
 */
export function applySpecContext(body: string, context: SpecContext | null | undefined): string {
  if (!context) return body;
  const wantEpic = typeof context.epic === 'string' && context.epic.trim() ? context.epic.trim() : null;
  const wantStory = typeof context.story === 'string' && context.story.trim() ? context.story.trim() : null;
  if (!wantEpic && !wantStory) return body;
  if (!body.trim()) return body; // §9 P3-13: never mint a context-only comment
  const { directives } = parseSpecDirectives(body);
  const lines: string[] = [];
  if (wantEpic && !directives.epic) lines.push(`@epic: ${wantEpic}`);
  if (wantStory && !directives.story) lines.push(`@story: ${wantStory}`);
  if (lines.length === 0) return body;
  return `${body.replace(/\s+$/, '')}\n${lines.join('\n')}`;
}
