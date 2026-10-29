/**
 * dom-annotakit — GH Projects (v2) spec mirror: isomorphic GraphQL client +
 * the stateless marker-anchored reconciler (D6, design/2026-10-23 + audit fold).
 *
 * THE MODEL (mirrors the vendored issues engine's discipline, new code):
 *   - Source of truth for a thread is the LOCAL STORE. The board item is a
 *     VIEW: one thread = one draft item, owned by us, rewritten on drift.
 *   - The item↔thread link is the body's byte-0 marker
 *     `<!-- dom-annotakit:thread=<id> -->` — NO local mapping table exists;
 *     every pass rebuilds the map from the board side (crash-safe).
 *   - Reconcile = converge, not re-create (P2-4 single-flight at the callers).
 *   - Deletes are EVIDENCE-GATED (P1-3): an item is deleted only when its
 *     thread id is in the store's deletedIds (delete-wins tombstones). "Thread
 *     gone from the list" alone NEVER deletes — a boot-reconcile racing the
 *     engine's async restore must not wipe the board.
 *
 * API shapes are LIVE-PROBED facts (scripts/gh-projects-probe.mjs, P0-P11):
 *   - addProjectV2DraftIssue payload → projectItem { id content { …on
 *     DraftIssue { id } } } (no projectV2Item field; draftIssue id via content)
 *   - single-select option inputs REQUIRE name+color+description (color
 *     required even on id-preserved replaces) — the replace is FULL LIST;
 *     ids survive, so appends pass existing options back with their ids
 *     (P6/P8 verified assignments survive).
 *   - ProjectV2FieldConfiguration is a UNION — fragment-select field ids.
 *
 * Isomorphic: fetch + AbortController only (Node >= 22, browsers). The static
 * twin (src/host/projectClient.ts) injects the same reconcile with
 * localStorage-sourced deps; scripts/project-sync-test.mjs injects a fake
 * transport. ghClient/ghsync are NOT touched (issues mirror stays SB parity).
 */

import type { Thread } from './types';
import { parseSpecDirectives, specTitleExcerpt, threadSpecDirectives } from './specDirectives';
import type { SpecCatalog } from './specCatalog';

/* ------------------------------ config types ------------------------------ */

export interface ProjectSyncTarget {
  kind: 'user' | 'org';
  login: string;
  number: number;
}

/** config.project resolution (target: config > env > baked; token: env >
 *  config > baked — engine-aligned, design fold P3-4). */
export interface ProjectSyncConfig {
  target: ProjectSyncTarget;
  token: string;
  /** Link origin minted into item bodies (preview URL for the hosted shape). */
  publicUrl?: string;
}

/** `https://github.com/users/<u>/projects/<n>` | `…/orgs/<o>/projects/<n>` |
 *  bare `users/<u>/projects/<n>` — anything else → null (honest disable). */
export function parseProjectTarget(v: string): ProjectSyncTarget | null {
  const m = v.match(/(?:^|github\.com\/)(users|orgs)\/([A-Za-z0-9_.-]+)\/projects\/(\d+)\/?$/);
  if (!m) return null;
  return { kind: m[1] === 'orgs' ? 'org' : 'user', login: m[2]!, number: Number(m[3]!) };
}

/* ------------------------------ marker policy ------------------------------ */

const MARKER_PREFIX = '<!-- dom-annotakit:thread=';
/** Write-side id gate: BOTH engine-produced shapes are admitted — newId()
 * `th_<base36>_<rand>` (store.ts:127) and the SingleFile import's deterministic
 * `singlefile-<captureId>-<noteId>-<hash8>` (import.ts). Arbitrary POSTed ids
 * (routes.ts:563-565 accepts them) are skipped by the mirror — documented.
 * The charset (alnum/underscore/dash, and `th_` takes underscore-only) can
 * never spell `-->` or `<!--`, so a hostile id cannot forge marker structure
 * (audit P2-1) — pinned by A16/B9. */
const THREAD_ID_RE = /^(th_[A-Za-z0-9_]+|singlefile-[A-Za-z0-9_-]+)$/;

export function markerFor(threadId: string): string {
  /* NO space before --> : the claim slices id = body[prefixLen..indexOf('-->'))
   * and must round-trip EXACTLY (a trailing space breaks the id-shape gate
   * and every item would be re-created on every pass — pinned by A14). */
  return `${MARKER_PREFIX}${threadId}-->`;
}

/** Claim an item ONLY on a byte-0 marker with a well-formed id AND the
 *  generator's exact follow-bytes (`-->\n\n` — buildDesiredItem always writes
 *  marker + blank line). A forged marker whose id TRUNCATES at an embedded
 *  `-->` leaves the rest of the hostile id in the tail where the follow-byte
 *  check refuses it (audit P2-1; pinned by A14/A18 — quoted/prose lookalikes
 *  and user-authored items stay untouched). */
export function parseMarker(body: string | null | undefined): string | null {
  if (!body || !body.startsWith(MARKER_PREFIX)) return null;
  const end = body.indexOf('-->', MARKER_PREFIX.length);
  if (end < 0 || !body.startsWith('-->\n\n', end)) return null;
  const id = body.slice(MARKER_PREFIX.length, end);
  return THREAD_ID_RE.test(id) ? id : null;
}

/* ------------------------------ graphql client ------------------------------ */

export interface GqlResponse {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<GqlResponse>;

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';
const FETCH_TIMEOUT_MS = 15_000;

/** The real transport (Node 22+/browser). Throws ONLY on transport failure +
 * GraphQL error presence — callers catch and report via status. */
export function makeGql(token: string): Gql {
  return async (query, variables = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: ctrl.signal,
      });
      const json = (await res.json().catch(() => null)) as { data?: unknown; errors?: { message: string }[] } | null;
      if (!json) throw new Error(`GitHub API ${res.status}: unparseable response`);
      if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; ').slice(0, 400));
      return { data: json.data as Record<string, unknown> | undefined };
    } finally {
      clearTimeout(timer);
    }
  };
}

/* ------------------------------ board schema ------------------------------- */

const FIELD_EPIC = 'Epic';
const FIELD_STORY = 'Story';
const FIELD_CAPTURE = 'Capture';
const FIELD_ANCHOR = 'DOM anchor';

/** GH single-select colors — deterministic per name (stable hash → palette
 *  index; the SAME name always lands on the same color across appends).
 *  D15 (session 5): the palette is EXACTLY GitHub's accepted set — GRAY,
 *  BLUE, GREEN, YELLOW, ORANGE, RED, PINK, PURPLE (the earlier list carried
 *  BROWN/CYAN/MAGENTA/TAN, which the Projects v2 mutation rejects wholesale:
 *  the append dies with "invalid value for singleSelectOptions.N.color"
 *  and the mirror latches an error state). */
const OPTION_COLORS = ['BLUE', 'GREEN', 'PURPLE', 'ORANGE', 'PINK', 'RED', 'YELLOW', 'GRAY'] as const;

function optionColorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OPTION_COLORS[h % OPTION_COLORS.length];
}

interface BoardField {
  id: string;
  name: string;
  dataType?: string;
  options?: { id: string; name: string; color?: string | null; description?: string | null }[];
}

interface BoardItem {
  itemId: string;
  createdAt: string;
  draftId: string | null;
  title: string | null;
  body: string | null;
  /** field NAME → single-select option NAME */
  selects: Record<string, string>;
  /** field NAME → text value */
  texts: Record<string, string>;
  threadId: string | null;
}

interface BoardView {
  projectId: string;
  title: string;
  url: string;
  fields: BoardField[];
  items: BoardItem[];
}

const PROJECT_FIELDS_QUERY = `
  id title url
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField { options { id name color description } }
    }
  }`;

const ITEMS_PAGE_QUERY = `
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

async function loadBoard(gql: Gql, target: ProjectSyncTarget): Promise<BoardView> {
  /* resolve project id by number (user or org) — BOTH variables must be
   * declared (the live API rejected the $login-using/$n-only shape — the
   * fake-transport suite is declaration-blind by design, live E2E caught it) */
  const ownerQuery = target.kind === 'user'
    ? `query($login: String!, $n: Int!) { user(login: $login) { projectV2(number: $n) { ${PROJECT_FIELDS_QUERY} } } }`
    : `query($login: String!, $n: Int!) { organization(login: $login) { projectV2(number: $n) { ${PROJECT_FIELDS_QUERY} } } }`;
  const owner = await gql(ownerQuery, { login: target.login, n: target.number });
  const project = (owner.data as unknown as Record<string, { projectV2?: Record<string, unknown> } | undefined>)?.[target.kind === 'user' ? 'user' : 'organization']?.projectV2;
  if (!project || typeof project !== 'object') throw new Error(`project not found: ${target.login} #${target.number}`);
  const fields = ((project as { fields?: { nodes?: unknown[] } }).fields?.nodes ?? []) as BoardField[] & Record<string, unknown>[];
  const projectId = (project as { id?: string }).id!;

  /* paged item read (P1-1: one 100-node page silently truncates → duplicate
   * minting; read EVERY page) */
  const items: BoardItem[] = [];
  let cursor: string | null = null;
  for (;;) {
    const pageQuery = `query($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { ${ITEMS_PAGE_QUERY} } } }`;
    const r = await gql(pageQuery, { id: projectId, cursor });
    const node = (r.data as unknown as { node?: { items?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: unknown[] } } }).node;
    const conn = node?.items;
    for (const raw of conn?.nodes ?? []) {
      const it = raw as {
        id: string;
        createdAt: string;
        content?: { __typename?: string; id?: string; title?: string | null; body?: string | null };
        fieldValues?: { nodes?: { name?: string; text?: string; field?: { name?: string } }[] };
      };
      const selects: Record<string, string> = {};
      const texts: Record<string, string> = {};
      for (const fv of it.fieldValues?.nodes ?? []) {
        if (fv?.field?.name) {
          if (typeof fv.name === 'string') selects[fv.field.name] = fv.name;
          else if (typeof fv.text === 'string') texts[fv.field.name] = fv.text;
        }
      }
      const isDraft = it.content?.__typename === 'DraftIssue';
      items.push({
        itemId: it.id,
        createdAt: it.createdAt,
        draftId: isDraft ? (it.content?.id ?? null) : null,
        title: isDraft ? it.content?.title ?? null : null,
        body: isDraft ? it.content?.body ?? null : null,
        selects,
        texts,
        threadId: isDraft ? parseMarker(it.content?.body) : null,
      });
    }
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { projectId, title: (project as { title?: string }).title ?? '', url: (project as { url?: string }).url ?? '', fields, items };
}

/* --------------------------- desired item state ---------------------------- */

export interface DesiredItem {
  threadId: string;
  title: string;
  body: string;
  epic?: string;
  story?: string;
  capture: string;
  anchor: string;
}

function anchorSummary(t: Thread): string {
  const ctx = t.target?.context as { tag?: string; id?: string; text?: string; outerHTML?: string } | undefined;
  /* AnchorSelector is ALWAYS an object {cssSelector, textQuote?, fragment}
   * (types.ts:222) — live E2E find #8: stringifying it rendered
   * `[object Object]` on the board. */
  const sel = t.target?.selector as { cssSelector?: string } | undefined;
  const tag = ctx?.tag ?? '';
  const idPart = ctx?.id ? `#${ctx.id}` : '';
  const text = (ctx?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const selPart = (sel?.cssSelector ? String(sel.cssSelector) : '').slice(0, 80) || `${tag}${idPart}`.trim();
  return text ? `${selPart} — “${text}”` : selPart;
}

/** The item body is the SPEC VIEW: marker at byte 0 (the claim), the
 *  organization header, the DOM anchor directive, the deep link, and the
 *  verbatim comment record (directives included — they ARE the record). */
export function buildDesiredItem(thread: Thread, captureName: string | undefined, publicUrl: string | undefined): DesiredItem {
  const comments = thread.comments ?? [];
  const bodies = comments.map((c) => String(c.body ?? ''));
  const d = threadSpecDirectives(bodies);
  const capture = captureName ?? thread.story?.name ?? thread.storyId;
  const title = specTitleExcerpt(bodies[0] ?? '', `[pin] ${capture}`);
  const header: string[] = [];
  if (d.epic || d.story) {
    const bits: string[] = [];
    if (d.epic) bits.push(`**Epic:** ${d.epic}`);
    if (d.story) bits.push(`**Story:** ${d.story}`);
    header.push(bits.join(' · '));
  }
  header.push(`**Capture:** ${capture}`);
  header.push(`**Status:** ${thread.status}`);
  const anchor = anchorSummary(thread);
  header.push(`**DOM anchor:** \`${anchor}\``);
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      u.searchParams.set('capture', thread.storyId);
      header.push(`**Spec source:** [open in dom-annotakit](${u.href})`);
    } catch {
      /* malformed publicUrl — the board body works without the link */
    }
  }
  const lines = comments.map((c, i) => {
    const cleaned = String(c.body ?? '').trim();
    return `${i + 1}. **${c.author}** — ${cleaned}`;
  });
  const body = [
    markerFor(thread.id),
    '',
    ...header,
    '',
    '## Directives',
    ...(lines.length ? lines : ['_(no comments)_']),
  ].join('\n');
  return { threadId: thread.id, title, body, epic: d.epic, story: d.story, capture, anchor };
}

/* ------------------------------ field plumbing ------------------------------ */

async function ensureField(gql: Gql, projectId: string, name: string, dataType: 'SINGLE_SELECT' | 'TEXT'): Promise<BoardField> {
  /* caller re-reads fields first; this only creates when truly missing */
  const r = await gql(
    `mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name dataType } } } }`,
    { input: { projectId, dataType, name, ...(dataType === 'SINGLE_SELECT' ? { singleSelectOptions: [{ name: 'General', color: 'GRAY', description: 'default bucket — rename or delete in the board UI' }] } : {}) } },
  );
  const f = (r.data as unknown as { createProjectV2Field?: { projectV2Field?: BoardField } }).createProjectV2Field?.projectV2Field;
  if (!f?.id) throw new Error(`field create failed: ${name}`);
  return { ...f, options: dataType === 'SINGLE_SELECT' ? [] : undefined };
}

/** Id-preserving option append (probe P6 recipe). The replace is a FULL LIST
 *  — options are RE-READ immediately before the write and merged (P2-3:
 *  smallest TOCTOU window; a human option added in the UI survives). */
async function ensureOptions(gql: Gql, field: BoardField, names: string[], projectId: string): Promise<Map<string, string>> {
  const byName = new Map((field.options ?? []).map((o) => [o.name, o.id]));
  const missing = [...new Set(names)].filter((n) => !byName.has(n));
  if (missing.length > 0) {
    const fresh = await gql(`query($id: ID!) { node(id: $id) { ... on ProjectV2SingleSelectField { options { id name color description } } } }`, { id: field.id });
    const freshOpts = ((fresh.data as unknown as { node?: { options?: BoardField['options'] } }).node?.options ?? []) ?? [];
    const stillMissing = missing.filter((n) => !freshOpts.some((o) => o.name === n));
    if (stillMissing.length > 0) {
      const replace = [
        ...freshOpts.map((o) => ({ id: o.id, name: o.name, color: o.color || 'GRAY', description: o.description ?? '' })),
        ...stillMissing.map((n) => ({ name: n, color: optionColorFor(n), description: '' })),
      ];
      const w = await gql(
        `mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`,
        { input: { fieldId: field.id, singleSelectOptions: replace } },
      );
      const written = (w.data as unknown as { updateProjectV2Field?: { projectV2Field?: { options?: { id: string; name: string }[] } } }).updateProjectV2Field?.projectV2Field?.options ?? [];
      for (const o of written) byName.set(o.name, o.id);
    } else {
      for (const o of freshOpts) byName.set(o.name, o.id);
    }
  }
  return byName;
}

/* ------------------------------ mutations ------------------------------ */

async function createItem(gql: Gql, projectId: string, want: DesiredItem, optIds: { epic?: Map<string, string>; story?: Map<string, string> }, fieldIds: { epic: string; story: string; capture: string; anchor: string }): Promise<void> {
  const r = await gql(
    `mutation($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id content { ... on DraftIssue { id } } } } }`,
    { input: { projectId, title: want.title, body: want.body } },
  );
  const item = (r.data as unknown as { addProjectV2DraftIssue?: { projectItem?: { id?: string; content?: { id?: string } } } }).addProjectV2DraftIssue?.projectItem;
  if (!item?.id || !item.content?.id) throw new Error(`draft item create failed for ${want.threadId}`);
  /* set fields only when the directives/name produced a value — unset stays
   * unset (honest; the board's ungrouped bucket) */
  const sets: Promise<unknown>[] = [];
  const setField = (fieldId: string, value: { singleSelectOptionId?: string; text?: string }): Promise<unknown> =>
    gql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
      { input: { projectId, itemId: item.id!, fieldId, value } });
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

async function updateItem(gql: Gql, projectId: string, item: BoardItem, want: DesiredItem, optIds: { epic?: Map<string, string>; story?: Map<string, string> }, fieldIds: { epic: string; story: string; capture: string; anchor: string }): Promise<boolean> {
  if (!item.draftId) return false; /* not ours-shaped anymore — ignore */
  let wrote = false;
  if (item.title !== want.title || item.body !== want.body) {
    await gql(`mutation($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id } } }`,
      { input: { draftIssueId: item.draftId, title: want.title, body: want.body } });
    wrote = true;
  }
  const setField = (fieldId: string, value: { singleSelectOptionId?: string; text?: string }): Promise<unknown> =>
    gql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
      { input: { projectId, itemId: item.itemId, fieldId, value } });
  const clearField = (fieldId: string): Promise<unknown> =>
    gql(`mutation($input: ClearProjectV2ItemFieldValueInput!) { clearProjectV2ItemFieldValue(input: $input) { clientMutationId } }`,
      { input: { projectId, itemId: item.itemId, fieldId } });
  /* drift only — equal values never rewritten; BOTH sides normalized to
   * null (an UNSET field reads undefined — undefined !== null would flag every
   * unfiled field as drifted and clear it on EVERY pass — pinned by B2). */
  if ((item.selects[FIELD_EPIC] ?? null) !== (want.epic ?? null)) {
    if (want.epic) {
      const oid = optIds.epic?.get(want.epic);
      if (oid) { await setField(fieldIds.epic, { singleSelectOptionId: oid }); wrote = true; }
    } else {
      await clearField(fieldIds.epic);
      wrote = true;
    }
  }
  if ((item.selects[FIELD_STORY] ?? null) !== (want.story ?? null)) {
    if (want.story) {
      const oid = optIds.story?.get(want.story);
      if (oid) { await setField(fieldIds.story, { singleSelectOptionId: oid }); wrote = true; }
    } else {
      await clearField(fieldIds.story);
      wrote = true;
    }
  }
  if ((item.texts[FIELD_CAPTURE] ?? null) !== (want.capture ?? null)) { await setField(fieldIds.capture, { text: want.capture }); wrote = true; }
  if ((item.texts[FIELD_ANCHOR] ?? null) !== (want.anchor ?? null)) { await setField(fieldIds.anchor, { text: want.anchor }); wrote = true; }
  return wrote;
}

async function deleteItem(gql: Gql, projectId: string, itemId: string): Promise<void> {
  await gql(`mutation($input: DeleteProjectV2ItemInput!) { deleteProjectV2Item(input: $input) { clientMutationId } }`,
    { input: { projectId, itemId } });
}

/* ------------------------------ reconcile ------------------------------ */

/** D10 (2026-10-26): the board-derived spec catalog — Epic/Story OPTIONS
 *  (fields the pass already loaded) + story→epic EDGES from the pass's paged
 *  item read (selects carry both fields per item — zero extra API). Feeds the
 *  serve-mode spec endpoint (merged with the fresher thread-derived index
 *  by mergeCatalog — src/shared/specCatalog.ts). */
export function boardCatalog(view: { fields: BoardField[]; items: BoardItem[] }): SpecCatalog {
  const epicField = view.fields.find((f) => f.name === FIELD_EPIC);
  const storyField = view.fields.find((f) => f.name === FIELD_STORY);
  const edges = new Map<string, Set<string>>();
  for (const it of view.items) {
    const e = it.selects[FIELD_EPIC];
    const s = it.selects[FIELD_STORY];
    if (e && s) {
      const set = edges.get(s) ?? new Set<string>();
      set.add(e);
      edges.set(s, set);
    }
  }
  const stories = (storyField?.options ?? []).map((o) => ({
    name: o.name,
    epics: [...(edges.get(o.name) ?? [])].sort(),
  }));
  return {
    epics: (epicField?.options ?? []).map((o) => o.name).sort(),
    stories,
    captures: {}, // board items carry no capture rollup — the store owns it
  };
}

export interface ReconcileDeps {
  gql: Gql;
  config: ProjectSyncConfig;
  /** live threads (the local truth; serve: store.listThreads(), static: localStorage) */
  listThreads: () => Promise<Thread[]> | Thread[];
  /** delete-wins EVIDENCE (audit P1-3) — the ONLY delete authorization. */
  listDeletedIds: () => Promise<Set<string>> | Set<string>;
  /** manifest-derived display name for the capture (audit P2-7) */
  captureName: (storyId: string) => string | undefined;
  log?: (...args: unknown[]) => void;
}

export interface ReconcileResult {
  threads: number;
  items: number;
  created: number;
  updated: number;
  deleted: number;
  /** duplicate marker items culled (canonical = oldest, audit P2-1) */
  culled: number;
  skipped: number;
  projectUrl: string;
  projectTitle: string;
  /** D10: the board-derived spec catalog (options + pass edges) — feeds
   *  the comboboxes via the serve-mode spec endpoint + the static twin. */
  catalog: SpecCatalog;
}

/**
 * One convergence pass. Statelessness: every structure is rebuilt from the
 * board + store reads; a crash mid-pass is safe (the next pass re-derives).
 * Throws on transport/GraphQL failure — callers keep the error for status.
 */
export async function reconcileProject(deps: ReconcileDeps): Promise<ReconcileResult> {
  const log = deps.log ?? (() => undefined);
  const board = await loadBoard(deps.gql, deps.config.target);

  /* fields: ensure the four exist (created with the inert General seed when
   * the board lacks them — same shape the bootstrap script writes) */
  const byName = new Map(board.fields.map((f) => [f.name, f]));
  const epicF = byName.get(FIELD_EPIC) ?? (await ensureField(deps.gql, board.projectId, FIELD_EPIC, 'SINGLE_SELECT'));
  const storyF = byName.get(FIELD_STORY) ?? (await ensureField(deps.gql, board.projectId, FIELD_STORY, 'SINGLE_SELECT'));
  const captureF = byName.get(FIELD_CAPTURE) ?? (await ensureField(deps.gql, board.projectId, FIELD_CAPTURE, 'TEXT'));
  const anchorF = byName.get(FIELD_ANCHOR) ?? (await ensureField(deps.gql, board.projectId, FIELD_ANCHOR, 'TEXT'));
  const fieldIds = { epic: epicF.id, story: storyF.id, capture: captureF.id, anchor: anchorF.id };

  /* claimed map: threadId → canonical item (oldest createdAt; duplicates are
   * culled — machine-authored mirror views, P2-1) */
  const claimed = new Map<string, BoardItem>();
  const extras: BoardItem[] = [];
  const byThread = new Map<string, BoardItem[]>();
  for (const it of board.items) {
    if (!it.threadId) continue; /* user-authored items: NEVER touched */
    (byThread.get(it.threadId) ?? byThread.set(it.threadId, []).get(it.threadId)!).push(it);
  }
  for (const [tid, group] of byThread) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    claimed.set(tid, group[0]!);
    extras.push(...group.slice(1));
  }

  const threads = await deps.listThreads();
  const deletedIds = await deps.listDeletedIds();

  /* desired state per SYNCABLE thread (id-shape gate P2-1) */
  const desired = new Map<string, DesiredItem>();
  let skipped = 0;
  for (const t of threads) {
    if (!THREAD_ID_RE.test(t.id)) { skipped++; continue; }
    desired.set(t.id, buildDesiredItem(t, deps.captureName(t.storyId), deps.config.publicUrl));
  }

  /* options for every epic/story name that will be written */
  const epicNames = [...desired.values()].map((w) => w.epic).filter((v): v is string => !!v);
  const storyNames = [...desired.values()].map((w) => w.story).filter((v): v is string => !!v);
  const [epicIds, storyIds] = await Promise.all([
    ensureOptions(deps.gql, epicF, epicNames, board.projectId),
    ensureOptions(deps.gql, storyF, storyNames, board.projectId),
  ]);

  /* converge: creates + updates */
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

  /* evidence-gated deletes (P1-3): ONLY tombstoned thread ids authorize a
   * delete; vanished-but-not-tombstoned threads keep their items until the
   * store says otherwise. Cull duplicate markers (P2-1). */
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
      log('project-sync: duplicate cull failed:', err instanceof Error ? err.message : err);
    }
  }

  const res: ReconcileResult = {
    threads: desired.size,
    items: board.items.length,
    created,
    updated,
    deleted,
    culled,
    skipped,
    projectUrl: board.url,
    projectTitle: board.title,
    catalog: boardCatalog(board),
  };
  log(`project-sync: +${created} ~${updated} -${deleted} (culled ${culled}) — ${res.threads}/${threads.length} threads, ${res.items} board items`);
  return res;
}
