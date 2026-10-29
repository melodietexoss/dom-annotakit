import {
  specTitleExcerpt,
  threadSpecDirectives
} from "./chunk-4FZNDGRG.mjs";

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
var FETCH_TIMEOUT_MS = 15e3;
function makeGql(token) {
  return async (query, variables = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
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
function buildDesiredItem(thread, captureName, publicUrl) {
  const comments = thread.comments ?? [];
  const bodies = comments.map((c) => String(c.body ?? ""));
  const d = threadSpecDirectives(bodies);
  const capture = captureName ?? thread.story?.name ?? thread.storyId;
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
export {
  boardCatalog,
  buildDesiredItem,
  makeGql,
  markerFor,
  parseMarker,
  parseProjectTarget,
  reconcileProject
};
