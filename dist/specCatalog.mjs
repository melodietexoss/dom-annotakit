import {
  parseSpecDirectives,
  threadSpecDirectives
} from "./chunk-4FZNDGRG.mjs";

// src/shared/specCatalog.ts
var collator = new Intl.Collator(void 0, { sensitivity: "base" });
function specNameCompare(a, b) {
  return collator.compare(a, b);
}
function typeaheadMatch(name, q) {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return true;
  return name.toLocaleLowerCase().includes(needle);
}
function typeaheadRank(name, q) {
  const needle = q.trim().toLocaleLowerCase();
  if (!needle) return 1;
  return name.toLocaleLowerCase().startsWith(needle) ? 0 : 1;
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
  const a = board ?? { epics: [], stories: [], captures: {} };
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
function threadMatchesSelection(d, sel) {
  if (sel.epic && d.epic !== sel.epic) return false;
  if (sel.story && d.story !== sel.story) return false;
  return Boolean(sel.epic || sel.story);
}
function filterCaptureCounts(catalog, sel) {
  const epic = sel.epic ?? null;
  const story = sel.story ?? null;
  if (!epic && !story) return {};
  const out = {};
  const src = catalog ?? { epics: [], stories: [], captures: {} };
  for (const [id, roll] of Object.entries(src.captures)) {
    const epicOk = !epic || (roll.epics[epic] ?? 0) > 0;
    const storyOk = !story || (roll.stories[story] ?? 0) > 0;
    if (!epicOk || !storyOk) continue;
    let n = 0;
    if (epic && story) n = roll.pairs[`${epic}\0${story}`] ?? 0;
    else if (story) n = roll.stories[story] ?? 0;
    else if (epic) n = roll.epics[epic] ?? 0;
    out[id] = n;
  }
  return out;
}
function filterCaptureIds(catalog, sel) {
  return Object.keys(filterCaptureCounts(catalog, sel));
}
function storiesForEpic(catalog, epic) {
  const src = catalog ?? { epics: [], stories: [], captures: {} };
  if (!epic) return src.stories;
  const scoped = [];
  const other = [];
  for (const s of src.stories) {
    if (s.epics.includes(epic)) scoped.push(s);
    else if (s.epics.length === 0) other.push(s);
  }
  return [...scoped, ...other];
}
function nextSelection(cur, patch, catalog) {
  const epic = "epic" in patch ? patch.epic ?? null : cur.epic ?? null;
  let story = "story" in patch ? patch.story ?? null : cur.story ?? null;
  if (epic && story) {
    const edges = catalog?.stories.find((s) => s.name === story)?.epics ?? [];
    if (edges.length > 0 && !edges.includes(epic)) story = null;
  }
  return { epic, story };
}
var COMBO_INIT = { open: false, query: "", active: 0, selected: null };
function comboOptions(source, query) {
  const rows = source.filter((v) => typeaheadMatch(v, query)).sort((a, b) => typeaheadRank(a, query) - typeaheadRank(b, query) || specNameCompare(a, b)).map((v) => ({ kind: "option", value: v }));
  const q = query.trim();
  if (q && !source.some((v) => v.toLocaleLowerCase() === q.toLocaleLowerCase())) {
    rows.unshift({ kind: "create", value: q });
  }
  return rows;
}
function comboReduce(state, action, source) {
  switch (action.type) {
    case "open":
      return { ...state, open: true, query: "", active: 0 };
    case "close":
      return { ...state, open: false, query: "" };
    case "type":
      return { ...state, open: true, query: action.query, active: 0 };
    case "move": {
      if (!state.open) return state;
      const rows = comboOptions(source, state.query);
      if (rows.length === 0) return state;
      const next = state.active + action.delta;
      return { ...state, active: Math.max(0, Math.min(rows.length - 1, next)) };
    }
    case "commit": {
      const rows = comboOptions(source, state.query);
      const row = rows[state.active] ?? rows[0];
      if (!row) return { ...state, open: false, query: "" };
      return { open: false, query: "", active: 0, selected: row.value };
    }
    case "select":
      return { open: false, query: "", active: 0, selected: action.value };
    case "clear":
      return { ...COMBO_INIT, selected: null };
  }
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
export {
  COMBO_INIT,
  applySpecContext,
  buildSpecIndex,
  comboOptions,
  comboReduce,
  filterCaptureCounts,
  filterCaptureIds,
  mergeCatalog,
  nextSelection,
  specNameCompare,
  storiesForEpic,
  threadMatchesSelection
};
