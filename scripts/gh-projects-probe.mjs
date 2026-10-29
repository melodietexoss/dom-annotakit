#!/usr/bin/env node
/**
 * dom-annotakit — GH Projects (v2) MUTATING probe (session 3, D6 design).
 * Runs against a THROWAWAY project it creates and deletes. Never touches
 * the user's real projects.
 *
 * Answers, in order, with hard asserts:
 *   P1  createProjectV2 (user-owned)
 *   P2  createProjectV2Field SINGLE_SELECT with initial options {name,color}
 *   P3  createProjectV2Field TEXT
 *   P4  addProjectV2DraftIssue (title+body)
 *   P5  updateProjectV2ItemFieldValue singleSelectOptionId
 *   P6  APPEND an option on the EXISTING single-select via
 *       updateProjectV2Field(singleSelectOptions=[existing ids + new]) —
 *       then re-read the item: does the P5 assignment SURVIVE?
 *   P7  updateProjectV2DraftIssue (title/body edit)
 *   P8  item fieldValues re-read (marker + field state)
 *   P9  createProjectV2View TABLE_LAYOUT (grouping via updateProjectV2View if possible)
 *   P10 deleteProjectV2Item
 *   P11 deleteProjectV2
 */

const TOKEN = process.env.ANNOTAKIT_GH_TOKEN;
if (!TOKEN) { console.error('set ANNOTAKIT_GH_TOKEN'); process.exit(1); }

const ENDPOINT = 'https://api.github.com/graphql';
const results = [];
let hardFail = false;

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'dom-annotakit-probe' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, ...json };
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!ok) hardFail = true;
}

/* dataType enum + update-view input (facts for the real implementation) */
{
  const e = await gql(`query { __type(name: "ProjectV2CustomFieldType") { enumValues { name } } }`);
  console.log('ProjectV2CustomFieldType enum:', JSON.stringify(e.data?.__type?.enumValues?.map((v) => v.name)));
  const u = await gql(`query { __type(name: "UpdateProjectV2ViewInput") { inputFields { name type { kind name ofType { kind name } } } } }`);
  console.log('UpdateProjectV2ViewInput:', JSON.stringify(u.data?.__type?.inputFields?.map((f) => ({ n: f.name, t: f.type.name || f.type.kind + '>' + (f.type.ofType?.name || f.type.ofType?.kind) }))));
  const vc = await gql(`query { __type(name: "ProjectV2ViewConfiguration") { fields { name type { kind name ofType { kind name } } } } }`);
  console.log('ProjectV2ViewConfiguration (read):', JSON.stringify(vc.data?.__type?.fields?.map((f) => ({ n: f.name, t: f.type.name || f.type.kind + '>' + (f.type.ofType?.name || f.type.ofType?.kind) }))));
  const updV = await gql(`query { __type(name: "ProjectV2ViewConfigurationUpdate") { fields { name type { kind name ofType { kind name } } } } }`);
  console.log('ProjectV2ViewConfigurationUpdate:', JSON.stringify(updV.data?.__type?.fields?.map((f) => ({ n: f.name, t: f.type.name || f.type.kind + '>' + (f.type.ofType?.name || f.type.ofType?.kind) })) ?? updV.errors?.[0]?.message));
}

/* viewer id */
const v = await gql(`query { viewer { id login } }`);
const ownerId = v.data?.viewer?.id;
record('P0 viewer.id', !!ownerId, ownerId);

/* --cleanup-probes: delete every leftover probe project and exit */
if (process.argv.includes('--cleanup-probes')) {
  const find = await gql(`query { viewer { projectsV2(first: 30) { nodes { number id title } } } }`);
  for (const p of find.data.viewer.projectsV2.nodes) {
    if (p.title.includes('api probe')) {
      const del = await gql(`mutation($input: DeleteProjectV2Input!) { deleteProjectV2(input: $input) { projectV2 { id } } }`, { input: { projectId: p.id } });
      console.log(`cleanup: deleted probe project #${p.number} (${del.errors ? 'ERR ' + JSON.stringify(del.errors).slice(0, 120) : 'ok'})`);
    }
  }
  process.exit(0);
}

/* CreateProjectV2ViewInput shape */
const viewInput = await gql(`query { __type(name: "CreateProjectV2ViewInput") { inputFields { name type { kind name ofType { kind name } } } } }`);
console.log('\nCreateProjectV2ViewInput:', JSON.stringify(viewInput.data?.__type?.inputFields ?? viewInput.errors, null, 1));

/* ProjectV2View fields (find the group-by field name) */
const viewType = await gql(`query { __type(name: "ProjectV2View") { fields { name } } }`);
console.log('\nProjectV2View fields:', JSON.stringify(viewType.data?.__type?.fields?.map((f) => f.name) ?? viewType.errors));

/* P1 create project */
let projectId = null;
{
  const r = await gql(`mutation($input: CreateProjectV2Input!) { createProjectV2(input: $input) { projectV2 { id number url } } }`,
    { input: { ownerId, title: 'dom-annotakit api probe (delete me)' } });
  projectId = r.data?.createProjectV2?.projectV2?.id ?? null;
  record('P1 createProjectV2', !!projectId, r.data?.createProjectV2?.projectV2?.url ?? r.errors);
}
if (!projectId) { console.log(JSON.stringify(results, null, 1)); process.exit(1); }

/* declared OUTSIDE try so the finally cleanup can always see them */
let itemId = null, draftId = null;
let storyFieldId = null, captureFieldId = null, anchorFieldId = null;

try {
  /* P2 single-select field with initial options */
  let epicFieldId = null;
  let optA = null, optB = null, colorA = 'GRAY', colorB = 'BLUE';
  {
    const r = await gql(`mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id name options { id name color } } } } }`,
      { input: { projectId, dataType: 'SINGLE_SELECT', name: 'Epic', singleSelectOptions: [
        { name: 'Probe Epic A', color: 'GRAY', description: '' }, { name: 'Probe Epic B', color: 'BLUE', description: '' },
      ] } });
    const f = r.data?.createProjectV2Field?.projectV2Field;
    epicFieldId = f?.id ?? null;
    optA = f?.options?.[0]?.id ?? null;
    optB = f?.options?.[1]?.id ?? null;
    colorA = f?.options?.[0]?.color ?? 'GRAY';
    colorB = f?.options?.[1]?.color ?? 'BLUE';
    record('P2 create SINGLE_SELECT Epic + 2 options', !!epicFieldId && !!optA && !!optB, f?.options?.map((o) => ({ n: o.name, id: o.id })) ?? r.errors);
  }

  /* P3 text fields — ProjectV2FieldConfiguration is a UNION: fragment select */
  for (const [nm, setter] of [['Story', (id) => (storyFieldId = id)], ['Capture', (id) => (captureFieldId = id)], ['DOM anchor', (id) => (anchorFieldId = id)]]) {
    const r = await gql(`mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name } } } }`,
      { input: { projectId, dataType: 'TEXT', name: nm } });
    setter(r.data?.createProjectV2Field?.projectV2Field?.id ?? null);
    if (r.errors) console.log(`    (${nm}) field create err:`, JSON.stringify(r.errors).slice(0, 250));
  }
  record('P3 create TEXT fields Story/Capture/DOM anchor', !!storyFieldId && !!captureFieldId && !!anchorFieldId, { storyFieldId, captureFieldId, anchorFieldId });

  /* P4 draft item */
  {
    const r = await gql(`mutation($input: AddProjectV2DraftIssueInput!) { addProjectV2DraftIssue(input: $input) { projectItem { id content { ... on DraftIssue { id title } } } } }`,
      { input: { projectId, title: 'Probe directive — do something', body: '<!-- dom-annotakit:thread=probe-1 -->\n\n**Epic:** Probe Epic A\nsome body' } });
    itemId = r.data?.addProjectV2DraftIssue?.projectItem?.id ?? null;
    draftId = r.data?.addProjectV2DraftIssue?.projectItem?.content?.id ?? null;
    record('P4 addProjectV2DraftIssue', !!itemId && !!draftId, { itemId, draftId, err: r.errors?.[0]?.message });
  }

  /* P5 set single-select + text values */
  {
    const r1 = await gql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }`,
      { input: { projectId, itemId, fieldId: epicFieldId, value: { singleSelectOptionId: optA } } });
    const r2 = await gql(`mutation($input: UpdateProjectV2ItemFieldValueInput!) { updateProjectV2ItemFieldValue(input: $input) { projectV2Item { id } } }`,
      { input: { projectId, itemId, fieldId: captureFieldId, value: { text: 'magnific-folder-filters' } } });
    record('P5 updateProjectV2ItemFieldValue (singleSelect + text)', !r1.errors && !r2.errors, { e1: r1.errors, e2: r2.errors });
  }

  /* P6 APPEND option via updateProjectV2Field, existing ids preserved */
  let optC = null;
  {
    const r = await gql(`mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`,
      { input: { fieldId: epicFieldId, singleSelectOptions: [
        { id: optA, name: 'Probe Epic A', color: colorA, description: '' }, { id: optB, name: 'Probe Epic B', color: colorB, description: '' }, { name: 'Probe Epic C', color: 'GREEN', description: '' },
      ] } });
    const f = r.data?.updateProjectV2Field?.projectV2Field;
    optC = f?.options?.find((o) => o.name === 'Probe Epic C')?.id ?? null;
    if (r.errors) console.log('    P6 FULL ERROR:', JSON.stringify(r.errors, null, 1));
    record('P6 updateProjectV2Field APPEND option C (ids preserved)', !!optC, { options: f?.options?.map((o) => ({ id: o.id, n: o.name })) });
  }

  /* P8 re-read item — did the P5 assignment survive P6? */
  {
    const r = await gql(`query($pid: ID!) { node(id: $pid) { ... on ProjectV2 { items(first: 10) { nodes { id fieldValues(first: 20) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2SingleSelectField { id name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { id name } } } } } content { ... on DraftIssue { id title body } } } } } } }`, { pid: projectId });
    const item = r.data?.node?.items?.nodes?.find((n) => n.id === itemId);
    const vals = item?.fieldValues?.nodes ?? [];
    const epicVal = vals.find((x) => x.optionId);
    const capVal = vals.find((x) => x.text && (item?.content?.title ?? '') !== x.text);
    record('P8 item re-read: Epic assignment SURVIVED the option append', epicVal?.name === 'Probe Epic A', { epic: epicVal?.name, capture: capVal?.text, bodyHasMarker: (item?.content?.body ?? '').includes('dom-annotakit:thread=probe-1') });
  }

  /* P7 draft item edit */
  {
    const r = await gql(`mutation($input: UpdateProjectV2DraftIssueInput!) { updateProjectV2DraftIssue(input: $input) { draftIssue { id title } } }`,
      { input: { draftIssueId: draftId, title: 'Probe directive EDITED', body: '<!-- dom-annotakit:thread=probe-1 -->\n\nedited body' } });
    record('P7 updateProjectV2DraftIssue', !r.errors, { err: r.errors, t: r.data?.updateProjectV2DraftIssue?.draftIssue?.title });
  }

  /* P9 view creation — layout TABLE_LAYOUT; grouping is UI-side (no API input) */
  {
    const r = await gql(`mutation($input: CreateProjectV2ViewInput!) { createProjectV2View(input: $input) { projectV2View { id name } } }`,
      { input: { projectId, name: 'Living spec (by Epic)', layout: 'TABLE_LAYOUT' } });
    record('P9 createProjectV2View TABLE_LAYOUT', !r.errors, { view: r.data?.createProjectV2View?.projectV2View, err: r.errors?.[0]?.message });
  }
} finally {
  /* P10 + P11 cleanup — best-effort, never throws */
  {
    if (itemId) {
      const r = await gql(`mutation($input: DeleteProjectV2ItemInput!) { deleteProjectV2Item(input: $input) { clientMutationId } }`, { input: { projectId, itemId } });
      record('P10 deleteProjectV2Item', !r.errors, { err: r.errors?.[0]?.message });
    }
    const r2 = await gql(`mutation($input: DeleteProjectV2Input!) { deleteProjectV2(input: $input) { projectV2 { id } } }`, { input: { projectId } });
    record('P11 deleteProjectV2 (cleanup)', !r2.errors, { err: r2.errors?.[0]?.message });
  }
}

console.log(`\n${hardFail ? 'PROBE HAD FAILURES' : 'ALL PROBES PASS'}`);
process.exit(hardFail ? 1 : 0);
