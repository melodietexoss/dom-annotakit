#!/usr/bin/env node
/**
 * dom-annotakit — bootstrap the real "UI Spec" GH Projects board (D6 §2.6).
 *
 * Idempotent: finds an EXISTING user project by exact title and completes it;
 * only creates a fresh one when no match exists. Completes = the 4 mirror
 * fields (Epic/Story SINGLE_SELECT — created EMPTY, options arrive via the
 * reconciler's id-preserving append; Capture/DOM anchor TEXT) + the
 * "Living spec (by Epic)" TABLE_LAYOUT view. Prints the project URL + id +
 * number for annotakit.config.json / bakedCreds.ts.
 *
 * Usage: ANNOTAKIT_GH_TOKEN=… node scripts/gh-projects-bootstrap.mjs [--title "…"]
 */

const TOKEN = process.env.ANNOTAKIT_GH_TOKEN;
const TITLE = (() => {
  const i = process.argv.indexOf('--title');
  return i > 0 ? process.argv[i + 1] : 'dom-annotakit — UI Spec';
})();
if (!TOKEN) { console.error('set ANNOTAKIT_GH_TOKEN'); process.exit(1); }

const ENDPOINT = 'https://api.github.com/graphql';

async function gql(query, variables = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'dom-annotakit-bootstrap' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

const fieldsQuery = `query($id: ID!) { node(id: $id) { ... on ProjectV2 {
  title url number
  fields(first: 30) { nodes { __typename ... on ProjectV2FieldCommon { id name dataType } } }
  views(first: 20) { nodes { id name layout }
} } } }`;

const data = await gql(`query { viewer { login id projectsV2(first: 50) { nodes { id number title url closed } } } }`, {});
const viewer = data.viewer;
console.log(`viewer: ${viewer.login}`);

let project = viewer.projectsV2.nodes.find((p) => p.title === TITLE && !p.closed) ?? null;

if (!project) {
  const r = await gql(`mutation($input: CreateProjectV2Input!) { createProjectV2(input: $input) { projectV2 { id number title url } } }`,
    { input: { ownerId: viewer.id, title: TITLE } });
  project = r.createProjectV2.projectV2;
  console.log(`created project #${project.number}: ${project.url}`);
} else {
  console.log(`found existing project #${project.number}: ${project.url}`);
}

const cur = await gql(fieldsQuery, { id: project.id });
const have = new Set(cur.node.fields.nodes.map((f) => f.name));
const views = cur.node.views.nodes.map((v) => v.name);

const MISSING_SINGLE = [
  // GH requires ≥1 option at SINGLE_SELECT creation; the seed is an inert
  // catch-all the user can rename/delete in the board UI. The mirror only
  // assigns options when a comment carries @epic:/@story:.
  { name: 'Epic', seed: [{ name: 'General', color: 'GRAY', description: 'default bucket — rename or delete in the board UI' }] },
  { name: 'Story', seed: [{ name: 'General', color: 'GRAY', description: 'default bucket — rename or delete in the board UI' }] },
];
const MISSING_TEXT = ['Capture', 'DOM anchor'];
for (const f of MISSING_SINGLE) {
  if (have.has(f.name)) { console.log(`field "${f.name}" exists`); continue; }
  await gql(`mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name } } } }`,
    { input: { projectId: project.id, dataType: 'SINGLE_SELECT', name: f.name, singleSelectOptions: f.seed } });
  console.log(`field "${f.name}" (SINGLE_SELECT) created with seed option "General" — further options arrive via the mirror's id-preserving append`);
}
for (const name of MISSING_TEXT) {
  if (have.has(name)) { console.log(`field "${name}" exists`); continue; }
  await gql(`mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name } } } }`,
    { input: { projectId: project.id, dataType: 'TEXT', name } });
  console.log(`field "${name}" (TEXT) created`);
}

const VIEW_NAME = 'Living spec (by Epic)';
if (!views.includes(VIEW_NAME)) {
  await gql(`mutation($input: CreateProjectV2ViewInput!) { createProjectV2View(input: $input) { projectV2View { id name } } }`,
    { input: { projectId: project.id, name: VIEW_NAME, layout: 'TABLE_LAYOUT' } });
  console.log(`view "${VIEW_NAME}" (TABLE_LAYOUT) created — grouping by Epic is one click in the board UI (not API-settable)`);
} else {
  console.log(`view "${VIEW_NAME}" exists`);
}

console.log(`\nproject id:    ${project.id}`);
console.log(`project url:   ${project.url}`);
console.log(`config target: ${project.url}  ← annotakit.config.json "project.target" + src/shared/bakedCreds.ts BAKED_PROJECT_TARGET`);
